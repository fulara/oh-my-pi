import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
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
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1" },
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	});
	test("launcher builder receives the complete agent argv", async () => {
		let received: string[] | undefined;
		using client = new RpcClient({
			command: args => {
				received = args;
				return ["/usr/bin/false"];
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
