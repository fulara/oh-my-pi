// Integration test — real timers are required (ts-no-test-timers exception): recovery
// exercises the real broker, native process handles, child pipes, and socket RPC.
// Every target is our own Bun.spawn child in a separate POSIX session/group. Even
// the pre-fix broker can only terminate that disposable sentinel, not the runner.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
	type DaemonSnapshot,
	type DaemonSpec,
} from "../../src/launch/protocol";

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const keys = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV];
	const previous = keys.map(key => process.env[key]);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	try {
		return startDaemonBrokerFromEnvironment();
	} finally {
		for (const [index, key] of keys.entries()) {
			const value = previous[index];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function nextLine(lines: AsyncGenerator<Uint8Array>): Promise<string> {
	const line = await Promise.race([
		lines.next(),
		Bun.sleep(2_000).then(() => {
			throw new Error("Sentinel did not answer before the deadline");
		}),
	]);
	if (line.done) throw new Error("Sentinel exited instead of answering");
	return new TextDecoder().decode(line.value);
}

async function recoverSentinel(
	detached: boolean,
	identity: "missing" | "stale" | "matching" | "unavailable" | "refused",
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-launch-process-identity-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const sentinel = Bun.spawn(
		[
			process.execPath,
			"-e",
			'process.stdin.on("data", data => process.stdout.write(data)); process.stdout.write("ready\\n");',
		],
		{
			cwd: projectDir,
			env: {},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
			detached: true,
		},
	);
	const lines = readLines(sentinel.stdout);
	const previousTitle = process.title;
	let broker: Promise<void> | undefined;
	let client: DaemonBrokerClient | undefined;
	let connected = false;
	try {
		expect(await nextLine(lines)).toBe("ready");
		const processRef = Process.fromPid(sentinel.pid);
		if (!processRef) throw new Error("Sentinel disappeared before recovery");
		// Fail before invoking the broker if Bun did not create a dedicated group.
		expect(processRef.groupId()).toBe(sentinel.pid);
		const name = "sentinel";
		const spec: DaemonSpec = {
			name,
			application: process.execPath,
			args: ["-e", "process.exit(0)"],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: true,
			detached,
		};
		const snapshot: DaemonSnapshot = {
			id: crypto.randomUUID(),
			name,
			state: identity === "refused" ? "failed" : "running",
			pid: sentinel.pid,
			createdAt: Date.now(),
			startedAt: Date.now(),
			restartCount: 0,
			outputBytes: 0,
			persist: true,
			detached,
		};
		await Bun.write(
			path.join(runtimeDir, "daemons", name, "meta.json"),
			JSON.stringify({
				daemon: snapshot,
				spec,
				// Missing/stale cases do not need the new native API, so they can
				// exercise the old broker/native binary for a genuine RED.
				processIdentity:
					identity === "missing"
						? undefined
						: identity === "stale"
							? "previous-os-boot:previous-process-start"
							: processRef.identity(),
				recoveryError:
					identity === "refused"
						? `Daemon ${name} PID ${sentinel.pid} left unmanaged: process identity unavailable; lifecycle control refused`
						: undefined,
			}),
		);
		if (identity === "unavailable") {
			// fromPid cannot distinguish an exited child from unreadable OS state.
			// Retire our own child to exercise that real null-return path safely.
			sentinel.kill("SIGKILL");
			await sentinel.exited;
		}
		if (identity === "missing" && !detached) {
			// Unresolved resources must not disappear behind the terminal-history cap.
			await Promise.all(
				Array.from({ length: 12 }, (_, index) => {
					const historicalName = `exited-${index}`;
					return Bun.write(
						path.join(runtimeDir, "daemons", historicalName, "meta.json"),
						JSON.stringify({
							spec: { ...spec, name: historicalName },
							daemon: {
								...snapshot,
								name: historicalName,
								state: "exited",
								pid: undefined,
								exitedAt: snapshot.createdAt + index + 1,
							},
						}),
					);
				}),
			);
		}
		// A second recovery must not silently erase or adopt the unresolved resource.
		for (let pass = 0; pass < (identity === "matching" ? 1 : 2); pass++) {
			client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			broker = startBroker(projectDir, runtimeDir);
			const deadline = Date.now() + 5_000;
			const endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
			while (
				!(await fs.stat(endpoint).then(
					() => true,
					() => false,
				))
			) {
				if (Date.now() >= deadline) throw new Error("Private broker socket did not appear");
				await Promise.race([broker, Bun.sleep(10)]);
			}
			connected = true;
			await client.request({ op: "ping" });
			if (identity !== "unavailable") {
				const nonce = crypto.randomUUID();
				sentinel.stdin.write(`${nonce}\n`);
				await sentinel.stdin.flush();
				expect(await nextLine(lines)).toBe(nonce);
			}
			const described = await client.request({ op: "describe", name });
			if (described.op !== "describe") throw new Error(`Unexpected result: ${described.op}`);
			expect(described.daemon.pid).toBe(sentinel.pid);
			if (identity === "matching") {
				expect(described.daemon.state).toBe("running");
				const stopped = await client.request({ op: "stop", name, timeoutMs: 2_000 });
				if (stopped.op !== "stop") throw new Error(`Unexpected result: ${stopped.op}`);
				expect(stopped.daemon.state).toBe("exited");
				expect(stopped.daemon.pid).toBeUndefined();
				await sentinel.exited;
			} else {
				expect(described.daemon.state).toBe("failed");
				expect(described.daemon.exitedAt).toBeUndefined();
				expect(described.daemon.exitReason).toContain("identity");
				const refusedOperations: DaemonOperation[] = [
					{ op: "send", name, signal: "SIGTERM" },
					{ op: "stop", name, timeoutMs: 100 },
					{ op: "restart", name },
					{ op: "start", spec },
				];
				for (const operation of refusedOperations) {
					const error = await client.request(operation).then(
						() => undefined,
						(reason: unknown) => reason,
					);
					expect(error).toBeInstanceOf(DaemonBrokerRejectedError);
				}
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") throw new Error(`Unexpected result: ${listed.op}`);
				expect(listed.daemons.find(daemon => daemon.name === name)?.pid).toBe(sentinel.pid);
				if (identity !== "unavailable") {
					const afterControl = crypto.randomUUID();
					sentinel.stdin.write(`${afterControl}\n`);
					await sentinel.stdin.flush();
					expect(await nextLine(lines)).toBe(afterControl);
				}
			}
			await client.request({ op: "shutdown" });
			connected = false;
			client.close();
			await broker;
			broker = undefined;
		}
	} finally {
		try {
			if (connected) await client?.request({ op: "shutdown" });
		} finally {
			client?.close();
			// Cleanup never reopens a PID: only the Bun handle created above owns
			// this child. No group signal is needed; the sentinel has no children.
			sentinel.kill("SIGKILL");
			await sentinel.exited;
			await lines.return(undefined);
			try {
				await broker;
			} finally {
				process.title = previousTitle;
			}
		}
	}
}

describe.skipIf(process.platform === "win32")("daemon broker process identity recovery", () => {
	for (const detached of [false, true]) {
		for (const identity of ["missing", "stale"] as const) {
			it(`refuses ${identity} identity for ${detached ? "detached adoption" : "recovery termination"}`, async () => {
				await recoverSentinel(detached, identity);
			}, 20_000);
		}
	}

	it("recovers and stops the matching detached process generation", async () => {
		await recoverSentinel(true, "matching");
	}, 15_000);

	it("preserves an unresolved PID when its process reference cannot be opened", async () => {
		await recoverSentinel(true, "unavailable");
	}, 15_000);

	it("preserves an earlier refusal even when the saved identity now matches", async () => {
		await recoverSentinel(true, "refused");
	}, 15_000);
});
