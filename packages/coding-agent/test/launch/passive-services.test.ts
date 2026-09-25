import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import {
	createDaemonBrokerClient,
	type DaemonBrokerClient,
	inspectExistingDaemonBroker,
} from "../../src/launch/client";
import { canonicalProjectDir, daemonRuntimeDir } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
	type DaemonInspectionOperation,
	type DaemonRpcResult,
} from "../../src/launch/protocol";
import { inspectSessionServiceLogs, inspectSessionServices } from "../../src/launch/services";

interface BrokerFixture {
	projectDir: string;
	runtimeDir: string;
	client: DaemonBrokerClient;
	inspect(operation: DaemonInspectionOperation): Promise<DaemonRpcResult>;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const overlay = {
		[DAEMON_PROJECT_DIR_ENV]: projectDir,
		[DAEMON_RUNTIME_DIR_ENV]: runtimeDir,
		[DAEMON_IDLE_GRACE_ENV]: "5000",
	};
	const previous = Object.fromEntries(Object.keys(overlay).map(key => [key, process.env[key]]));
	Object.assign(process.env, overlay);
	const broker = startDaemonBrokerFromEnvironment();
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return broker;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for broker state");
		// Real sockets and the broker's atomic metadata rename have no fake-clock completion signal.
		await Bun.sleep(10);
	}
}

async function withBroker(
	run: (fixture: BrokerFixture) => Promise<void>,
	seed?: (projectDir: string, runtimeDir: string) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-passive-services-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
	await seed?.(projectDir, runtimeDir);
	const previousTitle = process.title;
	const broker = startBroker(projectDir, runtimeDir);
	const inspect = (operation: DaemonInspectionOperation): Promise<DaemonRpcResult> =>
		inspectExistingDaemonBroker(projectDir, operation, { runtimeDir });
	try {
		await waitFor(async () => {
			try {
				await inspect({ op: "inspect-list", ownerSessionId: "startup" });
				return true;
			} catch {
				return false;
			}
		});
		await client.request({ op: "ping" });
		await run({ projectDir, runtimeDir, client, inspect });
	} finally {
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker;
		setProcessName(previousTitle);
	}
}

function spec(name: string, cwd: string, text = "READY"): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: ["-e", `console.log(${JSON.stringify(text)}); process.stdin.resume()`],
		env: {},
		cwd,
		pty: false,
		ready: { log: text, timeoutMs: 5_000 },
		restart: "no",
		persist: false,
		detached: false,
	};
}

function terminal(name: string, ownerSessionId: string | undefined, exitedAt = Date.now()): DaemonSnapshot {
	return {
		name,
		id: `${name}-id`,
		state: "exited",
		createdAt: exitedAt - 1_000,
		startedAt: exitedAt - 1_000,
		exitedAt,
		exitCode: 0,
		restartCount: 0,
		outputBytes: 0,
		owner: "Main",
		ownerSessionId,
		persist: false,
		detached: false,
	};
}

async function seedRecord(
	projectDir: string,
	runtimeDir: string,
	daemon: DaemonSnapshot,
	text?: string,
): Promise<void> {
	const dir = path.join(runtimeDir, "daemons", daemon.name);
	await Bun.write(path.join(dir, "meta.json"), JSON.stringify({ daemon, spec: spec(daemon.name, projectDir) }));
	if (text !== undefined) await Bun.write(path.join(dir, "output.log"), text);
}

describe("passive session service inspection", () => {
	it("reports missing sources without creating runtime files or spawning a broker", async () => {
		using tempDir = TempDir.createSync("@omp-passive-missing-");
		const cwd = await canonicalProjectDir(tempDir.path());
		const runtimeDir = daemonRuntimeDir(cwd);
		const isolatedRuntimeDir = path.join(tempDir.path(), "existing-runtime");
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("Passive inspection must not spawn");
		});
		try {
			await expect(inspectSessionServices(cwd, "session-a")).rejects.toThrow("Service inspection unavailable");
			await expect(inspectSessionServiceLogs(cwd, "session-a", "server", "old-id")).rejects.toThrow(
				"Service inspection unavailable",
			);
			await expect(fs.stat(runtimeDir)).rejects.toMatchObject({ code: "ENOENT" });

			await Bun.write(path.join(isolatedRuntimeDir, "broker.token"), "existing-token");
			await expect(
				inspectExistingDaemonBroker(
					cwd,
					{ op: "inspect-list", ownerSessionId: "session-a" },
					{
						runtimeDir: isolatedRuntimeDir,
					},
				),
			).rejects.toThrow("Service inspection unavailable");
			expect(await fs.readdir(isolatedRuntimeDir)).toEqual(["broker.token"]);
			expect(await Bun.file(path.join(isolatedRuntimeDir, "broker.token")).text()).toBe("existing-token");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});

	it("isolates two logical sessions sharing Main and rejects a name replaced after listing", async () => {
		await withBroker(async ({ projectDir, runtimeDir, client, inspect }) => {
			const first = await client.request({
				op: "start",
				spec: spec("server", projectDir, "SESSION_A"),
				owner: "Main",
				ownerSessionId: "session-a",
				toolCallId: "call-a",
			});
			const second = await client.request({
				op: "start",
				spec: spec("other", projectDir, "SESSION_B"),
				owner: "Main",
				ownerSessionId: "session-b",
			});
			if (first.op !== "start" || second.op !== "start") throw new Error("Unexpected start result");
			const listed = await inspect({ op: "inspect-list", ownerSessionId: "session-a" });
			if (listed.op !== "inspect-list") throw new Error("Unexpected inspection result");
			expect(listed.daemons.map(daemon => daemon.id)).toEqual([first.daemon.id]);
			expect(listed.daemons[0]).toMatchObject({ owner: "Main", ownerSessionId: "session-a", toolCallId: "call-a" });
			const persisted = await Bun.file(path.join(runtimeDir, "daemons", "server", "meta.json")).json();
			expect(persisted.daemon).toMatchObject({ owner: "Main", ownerSessionId: "session-a", toolCallId: "call-a" });
			const other = await inspect({ op: "inspect-list", ownerSessionId: "session-b" });
			if (other.op !== "inspect-list") throw new Error("Unexpected inspection result");
			expect(other.daemons.map(daemon => daemon.id)).toEqual([second.daemon.id]);
			const own = await inspect({
				op: "inspect-logs",
				ownerSessionId: "session-a",
				name: "server",
				expectedId: first.daemon.id,
			});
			expect(own).toEqual({ op: "inspect-logs", text: "SESSION_A\n", truncated: false });

			const replacement = await client.request({
				op: "start",
				spec: spec("server", projectDir, "PRIVATE_REPLACEMENT"),
				owner: "Main",
				ownerSessionId: "session-b",
				replace: true,
			});
			if (replacement.op !== "start") throw new Error("Unexpected start result");
			await expect(
				inspect({
					op: "inspect-logs",
					ownerSessionId: "session-a",
					name: "server",
					expectedId: first.daemon.id,
				}),
			).rejects.toThrow("Service logs unavailable for this session and service identity");
			await expect(
				inspect({
					op: "inspect-logs",
					ownerSessionId: "session-a",
					name: "server",
					expectedId: replacement.daemon.id,
				}),
			).rejects.toThrow("Service logs unavailable for this session and service identity");
			const remaining = await inspect({ op: "inspect-list", ownerSessionId: "session-a" });
			expect(remaining).toEqual({ op: "inspect-list", daemons: [] });
		});
	}, 20_000);

	it("keeps an authorized in-flight read on its original files while the name is replaced", async () => {
		await withBroker(
			async ({ projectDir, runtimeDir, client, inspect }) => {
				const readingStarted = Promise.withResolvers<void>();
				const releaseRead = Promise.withResolvers<void>();
				const logPath = path.join(runtimeDir, "daemons", "racing", "output.log");
				const originalStat = fs.stat;
				let blocked = false;
				const stat = vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
					if (!blocked && String(args[0]) === logPath) {
						blocked = true;
						readingStarted.resolve();
						await releaseRead.promise;
					}
					return originalStat(...args);
				}) as typeof fs.stat);
				let replacement: Promise<DaemonRpcResult> | undefined;
				const reading = inspect({
					op: "inspect-logs",
					ownerSessionId: "session-a",
					name: "racing",
					expectedId: "racing-id",
				});
				try {
					await readingStarted.promise;
					replacement = client.request({
						op: "start",
						spec: spec("racing", projectDir, "PRIVATE_REPLACEMENT"),
						owner: "Main",
						ownerSessionId: "session-b",
						replace: true,
					});
					// The same socket dispatches start before this ping, so replacement
					// is in flight without relying on a guessed wall-clock delay.
					await client.request({ op: "ping" });
					await expect(
						inspect({
							op: "inspect-logs",
							ownerSessionId: "session-a",
							name: "racing",
							expectedId: "racing-id",
						}),
					).rejects.toThrow("Service logs unavailable for this session and service identity");
					releaseRead.resolve();
					expect(await reading).toEqual({ op: "inspect-logs", text: "ORIGINAL", truncated: false });
					const replaced = await replacement;
					if (replaced.op !== "start") throw new Error("Unexpected start result");
					const current = await inspect({
						op: "inspect-logs",
						ownerSessionId: "session-b",
						name: "racing",
						expectedId: replaced.daemon.id,
					});
					expect(current).toEqual({ op: "inspect-logs", text: "PRIVATE_REPLACEMENT\n", truncated: false });
				} finally {
					releaseRead.resolve();
					await reading.catch(() => undefined);
					await replacement?.catch(() => undefined);
					stat.mockRestore();
				}
			},
			async (projectDir, runtimeDir) => {
				await seedRecord(projectDir, runtimeDir, terminal("racing", "session-a"), "ORIGINAL");
			},
		);
	}, 20_000);

	it("filters recovered ownership before retaining only twenty recent terminal services", async () => {
		const now = Date.now();
		await withBroker(
			async ({ inspect }) => {
				const result = await inspect({ op: "inspect-list", ownerSessionId: "session-a" });
				if (result.op !== "inspect-list") throw new Error("Unexpected inspection result");
				expect(result.daemons.map(daemon => daemon.name)).toEqual(
					Array.from({ length: 20 }, (_, index) => `a-${24 - index}`),
				);
				expect(result.daemons.every(daemon => daemon.ownerSessionId === "session-a")).toBe(true);
				expect(await inspect({ op: "inspect-list", ownerSessionId: "expired-session" })).toEqual({
					op: "inspect-list",
					daemons: [],
				});
			},
			async (projectDir, runtimeDir) => {
				const records = [
					...Array.from({ length: 25 }, (_, index) => terminal(`a-${index}`, "session-a", now - 10_000 + index)),
					...Array.from({ length: 30 }, (_, index) => terminal(`b-${index}`, "session-b", now - 1_000 + index)),
					terminal("expired", "session-a", now - 301_000),
					terminal("expired-only", "expired-session", now - 301_000),
					terminal("legacy-main", undefined, now),
				];
				await Promise.all(records.map(record => seedRecord(projectDir, runtimeDir, record)));
			},
		);
	}, 20_000);

	it("bounds UTF-8 bytes and lines, preserves complete small output, and reports missing logs", async () => {
		await withBroker(
			async ({ inspect }) => {
				for (const name of ["bytes", "lines", "small"]) {
					const result = await inspect({
						op: "inspect-logs",
						ownerSessionId: "session-a",
						name,
						expectedId: `${name}-id`,
					});
					if (result.op !== "inspect-logs") throw new Error("Unexpected inspection result");
					expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(64 * 1024);
					expect(result.text.split("\n").length).toBeLessThanOrEqual(200);
					expect(result.text).not.toContain("\uFFFD");
					expect(result.text.endsWith("END")).toBe(true);
					expect(result.truncated).toBe(name !== "small");
					if (name === "lines") expect(result.text).not.toContain("line-0\n");
					if (name === "small") expect(result.text).toBe("complete output\nEND");
				}
				await expect(
					inspect({
						op: "inspect-logs",
						ownerSessionId: "session-a",
						name: "missing",
						expectedId: "missing-id",
					}),
				).rejects.toThrow("Service inspection unavailable");
			},
			async (projectDir, runtimeDir) => {
				for (const [name, text] of Object.entries({
					bytes: `${"界".repeat(40_000)}END`,
					lines: `${Array.from({ length: 250 }, (_, index) => `line-${index}`).join("\n")}\nEND`,
					small: "complete output\nEND",
				})) {
					await seedRecord(
						projectDir,
						runtimeDir,
						{
							...terminal(name, "session-a"),
							outputBytes: Buffer.byteLength(text, "utf8"),
						},
						text,
					);
				}
				await seedRecord(projectDir, runtimeDir, terminal("missing", "session-a"));
			},
		);
	}, 20_000);

	it("leaves pending completions owned by the original delivery sink until that sink acknowledges", async () => {
		await withBroker(async ({ projectDir, runtimeDir, client, inspect }) => {
			const received = Promise.withResolvers<DaemonCompletionNotification>();
			const release = Promise.withResolvers<void>();
			const notifications: DaemonCompletionNotification[] = [];
			const unsubscribe = client.onCompletion("Main", async notification => {
				notifications.push(notification);
				received.resolve(notification);
				await release.promise;
			});
			try {
				await client.request({ op: "ping" });
				const started = await client.request({
					op: "start",
					spec: { ...spec("completion", projectDir), args: ["-e", 'console.log("DONE")'], ready: undefined },
					owner: "Main",
					ownerSessionId: "session-a",
				});
				if (started.op !== "start") throw new Error("Unexpected start result");
				const notification = await received.promise;
				const meta = Bun.file(path.join(runtimeDir, "daemons", "completion", "meta.json"));
				const before = await meta.json();
				expect(before.pendingCompletions.map((item: DaemonCompletionNotification) => item.completionId)).toEqual([
					notification.completionId,
				]);
				await inspect({ op: "inspect-list", ownerSessionId: "session-a" });
				const logs = await inspect({
					op: "inspect-logs",
					ownerSessionId: "session-a",
					name: "completion",
					expectedId: started.daemon.id,
				});
				expect(logs).toEqual({ op: "inspect-logs", text: "DONE\n", truncated: false });
				const after = await meta.json();
				expect(after.pendingCompletions).toEqual(before.pendingCompletions);
				expect(after.completionSubscriptionId).toBe(before.completionSubscriptionId);
				release.resolve();
				await waitFor(async () => (await meta.json()).pendingCompletions.length === 0);
				expect(notifications.map(item => item.completionId)).toEqual([notification.completionId]);
			} finally {
				release.resolve();
				unsubscribe({ preservePending: true });
			}
		});
	}, 20_000);
});
