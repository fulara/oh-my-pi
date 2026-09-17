import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("RpcClient.start", () => {
	test("starts and switches legacy sessions without capturing or deleting repository snapshots", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-no-repo-snapshots-"));
		const cwd = path.join(root, "repo");
		const sessionDir = path.join(root, "sessions");
		let client: RpcClient | undefined;
		try {
			await fs.mkdir(cwd);
			const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
			git("init", "--quiet");
			git("config", "user.name", "RPC test");
			git("config", "user.email", "rpc-test@example.invalid");
			await fs.writeFile(path.join(cwd, "tracked.txt"), "base\n");
			git("add", "tracked.txt");
			git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "base");
			const commit = git("rev-parse", "HEAD");
			const ref = "refs/omp/diff-snapshots/legacy";
			git("update-ref", ref, commit);
			await fs.writeFile(path.join(cwd, "tracked.txt"), "staged\n");
			git("add", "tracked.txt");
			await fs.writeFile(path.join(cwd, "tracked.txt"), "unstaged\n");
			await fs.writeFile(path.join(cwd, "untracked.txt"), "untracked\n");

			const legacy = SessionManager.create(cwd, sessionDir);
			legacy.appendMessage({ role: "user", content: "Legacy conversation", timestamp: Date.now() });
			const entryId = legacy.appendCustomEntry("repo-diff-snapshot", {
				version: 1,
				commit,
				createdAt: new Date().toISOString(),
				headCommit: commit,
				kind: "session-start",
				label: "session-start",
				ref,
				repoRoot: cwd,
				tree: git("rev-parse", "HEAD^{tree}"),
			});
			await legacy.ensureOnDisk();
			await legacy.close();
			const legacyPath = legacy.getSessionFile()!;
			const legacyBytes = await fs.readFile(legacyPath, "utf8");
			const refsBefore = git("for-each-ref", "--format=%(refname) %(objectname)");
			const indexBefore = await fs.readFile(path.join(cwd, ".git", "index"));
			const objectsBefore = git("count-objects", "-v");
			const headBefore = await fs.readFile(path.join(cwd, ".git", "HEAD"), "utf8");

			client = new RpcClient({
				command: [process.execPath, path.join(import.meta.dir, "..", "src", "cli.ts")],
				cwd,
				sessionDir,
				env: { PI_CODING_AGENT_DIR: path.join(root, "config"), PI_NO_TITLE: "1" },
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				args: ["--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-tools"],
			});
			await client.start();
			expect(await client.newSession()).toEqual({ cancelled: false });
			expect(await client.switchSession(legacyPath)).toEqual({ cancelled: false });
			expect(await client.getMessages()).toContainEqual(
				expect.objectContaining({ role: "user", content: "Legacy conversation" }),
			);
			const loaded = parseSessionEntries(await fs.readFile(legacyPath, "utf8"));
			expect(loaded).toContainEqual(
				expect.objectContaining({ type: "custom", id: entryId, customType: "repo-diff-snapshot" }),
			);
			expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);
			expect(git("for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsBefore);
			expect(await fs.readFile(path.join(cwd, ".git", "index"))).toEqual(indexBefore);
			expect(git("count-objects", "-v")).toBe(objectsBefore);
			expect(await fs.readFile(path.join(cwd, ".git", "HEAD"), "utf8")).toBe(headBefore);
			expect(await fs.readFile(path.join(cwd, "tracked.txt"), "utf8")).toBe("unstaged\n");
			expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe("untracked\n");
		} finally {
			await client?.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30000);

	test("rejects when RPC process exits immediately", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-invalid-provider-"));
		try {
			using client = new RpcClient({
				cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
				cwd: root,
				sessionDir: path.join(root, "sessions"),
				provider: "__missing_provider__",
				model: "claude-sonnet-4-5",
				env: { HOME: root, PI_CODING_AGENT_DIR: path.join(root, "config"), PI_NO_TITLE: "1" },
				args: ["--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-tools"],
			});

			await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	test("launcher builder receives the complete agent argv", async () => {
		let received: string[] | undefined;
		using client = new RpcClient({
			command: args => {
				received = args;
				return [process.execPath, "--eval", "process.exit(1)"];
			},
			provider: "openrouter",
			model: "example/model",
			args: ["--no-session"],
		});

		await expect(client.start()).rejects.toThrow(/exited with code 1/);
		expect(received).toEqual([
			"--mode",
			"rpc",
			"--provider",
			"openrouter",
			"--model",
			"example/model",
			"--no-session",
		]);
	});
});

describe("RpcClient stdin failures", () => {
	test("fails the request and stops the client when write rejects and flush throws", async () => {
		const exited = Promise.withResolvers<number>();
		const proc: RpcAgentProcess & { stdin: { flush(): never } } = {
			stdin: {
				// A pending pipe write rejects with EPIPE once the agent is gone; flush() can throw synchronously.
				write: () => Promise.reject(new Error("EPIPE: broken pipe, write")),
				flush: () => {
					throw new Error("flush failed");
				},
			},
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(client.getState()).rejects.toThrow("flush failed");
			// Unhandled rejections are reported once the microtask queue drains; one macrotask turn suffices.
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			// The broken pipe is terminal: the agent is killed and the client no longer accepts commands.
			expect(await exited.promise).toBe(0);
			await expect(client.getState()).rejects.toThrow("Client not started");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("rejects a non-serializable command without stopping a healthy client", async () => {
		const exited = Promise.withResolvers<number>();
		let killed = false;
		const proc: RpcAgentProcess = {
			stdin: { write: () => 0 },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => {
				killed = true;
				exited.resolve(0);
			},
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		// A serialization error is not a pipe failure: only this request fails.
		await expect(client.goal("create", { tokenBudget: 1n as unknown as number })).rejects.toThrow(TypeError);
		expect(killed).toBe(false);
	});

	test("still stops the client when killing the agent throws during pipe-failure cleanup", async () => {
		const proc: RpcAgentProcess = {
			stdin: { write: () => Promise.reject(new Error("EPIPE: broken pipe, write")) },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => {
				throw new Error("kill failed");
			},
			exited: Promise.withResolvers<number>().promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(client.getState()).rejects.toThrow("EPIPE");
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			await expect(client.getState()).rejects.toThrow("Client not started");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("drops a manual login code that arrives after the client stopped", async () => {
		const exited = Promise.withResolvers<number>();
		const encoder = new TextEncoder();
		let stdout!: ReadableStreamDefaultController<Uint8Array>;
		const written: string[] = [];
		const proc: RpcAgentProcess = {
			stdin: { write: (data: string) => written.push(data) },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					stdout = controller;
					controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			peekStderr: () => "",
			kill: () => exited.resolve(0),
			exited: exited.promise,
		};
		using client = new RpcClient({ spawn: () => proc });
		await client.start();

		const code = Promise.withResolvers<string>();
		const prompted = Promise.withResolvers<void>();
		const login = client.login("test-provider", {
			onManualCodeInput: () => {
				prompted.resolve();
				return code.promise;
			},
		});
		stdout.enqueue(
			encoder.encode(
				`${JSON.stringify({ type: "extension_ui_request", id: "ui_1", method: "input", title: "Paste code" })}\n`,
			),
		);
		await prompted.promise;

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			// The client stops (as it does on a broken stdin pipe) while the user is still typing the code.
			await client.stop();
			await expect(login).rejects.toThrow("Client stopped");
			const writesBefore = written.length;
			code.resolve("pasted-code");
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			expect(unhandled).toEqual([]);
			expect(written.length).toBe(writesBefore);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
