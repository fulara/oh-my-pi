import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { gracefulKillTreeOnce, spawnBrowserApplication } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	acquireBrowser,
	releaseBrowser,
	type PuppeteerBrowserHandle,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { ensureSpawnedKilledForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

const [scenario, directory] = process.argv.slice(2);
if (!scenario || !directory) throw new Error("Missing ownership probe scenario/directory");
const fixture = path.join(import.meta.dir, "browser-owned-process.ts");
const self = Process.fromPid(process.pid);
if (!self || self.groupId() !== process.pid) throw new Error("Ownership probe must run in its own process group");
const tracked: Array<{ subprocess: Bun.Subprocess; ownedProcess: Process }> = [];
const observed: Process[] = [];
const watchdog = setTimeout(() => process.exit(124), 25_000);

interface Ready {
	pid: number;
	identity: string;
	group: number | null;
}

async function readReady(role: string): Promise<Ready> {
	const targetPath = path.join(directory, `${role}.json`);
	const deadline = Date.now() + 4_000;
	while (Date.now() < deadline) {
		const target = Bun.file(targetPath);
		if (await target.exists()) {
			try {
				return (await target.json()) as Ready;
			} catch {
				// The writer may have created the private file before finishing it.
			}
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${role} readiness`);
}

function spawnFixture(role: string, mode = "normal") {
	const subprocess = Bun.spawn([process.execPath, fixture, directory, role, mode], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
	});
	const ownedProcess = Process.fromPid(subprocess.pid);
	if (!ownedProcess) throw new Error(`Cannot pin ${role} at birth`);
	const child = { subprocess, ownedProcess };
	tracked.push(child);
	return child;
}

function spawnApplication(mode = "normal") {
	const child = spawnBrowserApplication([process.execPath, fixture, directory, "leader", mode], directory);
	tracked.push(child);
	return child;
}

async function observeTree(leader?: Process): Promise<{ leader: Process; worker: Process }> {
	const ready = await readReady("leader");
	const reference = leader ?? Process.fromPid(ready.pid);
	assert(reference, "Leader must remain observable until cleanup");
	assert.equal(reference.identity(), ready.identity, "Leader must match its birth-pinned identity");
	observed.push(reference);
	const workerReady = await readReady("worker");
	const workerBirth = await readReady("worker-birth");
	const worker = Process.fromPid(workerReady.pid);
	assert(worker, "Worker must remain observable until cleanup");
	assert.equal(worker.pid, workerBirth.pid);
	assert.equal(worker.identity(), workerBirth.identity, "Worker must match the parent's birth pin");
	assert.equal(worker.identity(), workerReady.identity);
	observed.push(worker);
	return { leader: reference, worker };
}

function assertDedicated(tree: { leader: Process; worker: Process }, sentinel: Process) {
	assert.equal(tree.leader.groupId(), tree.leader.pid, "Production spawn must create a dedicated PGID");
	assert.equal(tree.worker.groupId(), tree.leader.pid, "Worker must inherit only the owned application's PGID");
	assert.notEqual(tree.leader.groupId(), self!.groupId(), "Application must not inherit its agent's PGID");
	assert.notEqual(tree.leader.groupId(), sentinel.groupId(), "Application must not share the sentinel's PGID");
}

async function assertGone(tree: { leader: Process; worker: Process }) {
	assert(await tree.leader.waitForExit({ timeoutMs: 2_000 }), "Owned leader survived cleanup");
	assert(await tree.worker.waitForExit({ timeoutMs: 2_000 }), "Owned worker survived cleanup");
	assert.equal(tree.leader.status(), ProcessStatus.Exited);
	assert.equal(tree.worker.status(), ProcessStatus.Exited);
}

function assertSentinel(sentinel: Process, identity: string) {
	assert.equal(sentinel.status(), ProcessStatus.Running, "Protected sentinel was signaled");
	assert.equal(sentinel.identity(), identity, "Retained sentinel identity changed");
	assert.equal(Process.fromPid(sentinel.pid)?.identity(), identity, "A replacement PID is not the protected sentinel");
}

function browserHandle(
	child?: { subprocess: Bun.Subprocess; ownedProcess?: Process },
	kind: PuppeteerBrowserHandle["kind"] = { kind: "spawned", path: process.execPath },
	close: () => Promise<void> = async () => {},
): PuppeteerBrowserHandle {
	// Only CDP state is a facade. Every PID, process handle and signal is real.
	return {
		key: `ownership:${scenario}`,
		kind,
		refCount: 1,
		pid: child?.subprocess.pid,
		subprocess: child?.subprocess,
		ownedProcess: child?.ownedProcess,
		ownedProcessExited: child?.ownedProcess ? child.subprocess.exited : undefined,
		browser: {
			connected: true,
			disconnect() {},
			process: () => child?.subprocess ?? null,
			close,
		},
		stealth: { browserSession: null, override: null },
	} as unknown as PuppeteerBrowserHandle;
}

async function expectRefusal(operation: () => Promise<void>, pid: number) {
	let failure: unknown;
	try {
		await operation();
	} catch (error) {
		failure = error;
	}
	assert(failure instanceof Error, "Cleanup refusal must be visible to the consumer");
	assert(String(failure).includes(String(pid)), `Refusal must identify remaining process ${pid}: ${failure}`);
}

let pendingOpen: Promise<unknown> | undefined;
const abort = new AbortController();
try {
	const sentinel = spawnFixture("sentinel");
	const sentinelReady = await readReady("sentinel");
	const sentinelIdentity = sentinel.ownedProcess.identity();
	assert.equal(sentinelIdentity, sentinelReady.identity);
	assert.equal(sentinel.ownedProcess.groupId(), self.groupId());

	if (scenario === "attach-failure" || scenario === "startup-interrupt") {
		const mode = scenario === "attach-failure" ? "bad-cdp" : "normal";
		const opened = acquireBrowser(
			{
				kind: "spawned",
				path: process.execPath,
				args: [fixture, directory, "leader", mode, `--user-data-dir=${path.join(directory, "profile")}`],
			},
			{ cwd: directory, signal: abort.signal },
		).then(
			handle => ({ handle, error: undefined }),
			error => ({ handle: undefined, error }),
		);
		pendingOpen = opened;
		const tree = await observeTree();
		assertDedicated(tree, sentinel.ownedProcess);
		if (scenario === "attach-failure") await fs.writeFile(path.join(directory, "CDP.ready"), "ready");
		if (scenario === "startup-interrupt") abort.abort();
		const result = await opened;
		assert(result.error instanceof Error, "Failed startup must reject acquisition");
		assert.equal(result.handle, undefined);
		assert.match(String(result.error), scenario === "attach-failure" ? /puppeteer\.connect failed/ : /abort/i);
		await assertGone(tree);
	} else if (scenario === "borrowed-guards") {
		for (const kind of [
			{ kind: "connected", cdpUrl: "http://127.0.0.1:1" },
			{ kind: "relay", cdpUrl: "http://127.0.0.1:1" },
			{ kind: "spawned", path: process.execPath },
		] as PuppeteerBrowserHandle["kind"][]) {
			const handle = browserHandle(undefined, kind);
			handle.pid = sentinel.subprocess.pid;
			await releaseBrowser(handle, { kill: true });
			await ensureSpawnedKilledForTest(handle);
			assertSentinel(sentinel.ownedProcess, sentinelIdentity);
		}
		const broker = browserHandle({ subprocess: sentinel.subprocess }, { kind: "headless", headless: true });
		broker.sharedDaemon = { name: "ownership-fixture-not-a-real-broker", projectDir: directory };
		await releaseBrowser(broker, { kill: true });
		await ensureSpawnedKilledForTest(broker);
		assertSentinel(sentinel.ownedProcess, sentinelIdentity);
		const unowned = browserHandle({ subprocess: sentinel.subprocess });
		await expectRefusal(() => releaseBrowser(unowned, { kill: true }), sentinel.subprocess.pid);
		await expectRefusal(() => ensureSpawnedKilledForTest(unowned), sentinel.subprocess.pid);
		const unownedHeadless = browserHandle(
			{ subprocess: sentinel.subprocess },
			{ kind: "headless", headless: true },
			async () => {
				throw new Error("Borrowed CDP close failed");
			},
		);
		await expectRefusal(() => releaseBrowser(unownedHeadless, { kill: false }), sentinel.subprocess.pid);
		const unconfirmed = browserHandle(sentinel, { kind: "headless", headless: true }, async () =>
			gracefulKillTreeOnce(sentinel.ownedProcess, 10),
		);
		unconfirmed.ownedProcessExited = undefined;
		await expectRefusal(() => releaseBrowser(unconfirmed, { kill: false }), sentinel.subprocess.pid);
		assertSentinel(sentinel.ownedProcess, sentinelIdentity);
	} else if (scenario === "native-refusal") {
		// The protected host is this disposable probe, never the real test runner or agent.
		await expectRefusal(() => gracefulKillTreeOnce(self, 10), self.pid);
		const subprocess = Bun.spawn(
			[process.execPath, fixture, directory, "ancestor-refusal", "normal", String(self.pid), self.identity()],
			{ stdin: "ignore", stdout: "ignore", stderr: "inherit" },
		);
		const ownedProcess = Process.fromPid(subprocess.pid);
		assert(ownedProcess, "Cannot pin ancestor-refusal helper at birth");
		tracked.push({ subprocess, ownedProcess });
		assert.equal(await subprocess.exited, 0, "Native ancestor refusal must propagate as an error");
		const result = await Bun.file(path.join(directory, "ancestor-result.json")).json();
		assert(String(result.error).includes(String(self.pid)));
	} else if (scenario === "shared-group") {
		const child = spawnFixture("leader", "stubborn");
		const tree = await observeTree(child.ownedProcess);
		assert.equal(tree.leader.groupId(), self.groupId());
		assert.notEqual(tree.leader.pid, tree.leader.groupId());
		// Native group:true must refuse the joined group, while terminating only its owned tree.
		assert(await child.ownedProcess.terminate({ group: true, gracefulMs: 30, timeoutMs: 2_000 }));
		await assertGone(tree);
	} else {
		const child = spawnApplication(scenario === "termination" ? "stubborn" : "normal");
		const tree = await observeTree(child.ownedProcess);
		assertDedicated(tree, sentinel.ownedProcess);
		const birthIdentity = child.ownedProcess.identity();
		if (scenario === "ordinary-exit") {
			await fs.writeFile(path.join(directory, "leader.exit"), "exit");
			assert.equal(await child.subprocess.exited, 0);
			await gracefulKillTreeOnce(child.ownedProcess, 30);
		} else if (scenario === "termination") {
			await gracefulKillTreeOnce(child.ownedProcess, 30);
		} else if (scenario === "headless-timeout") {
			const handle = browserHandle(
				child,
				{ kind: "headless", headless: true },
				() => Promise.withResolvers<void>().promise,
			);
			await releaseBrowser(handle, { kill: false });
		} else if (scenario === "headless-failure") {
			const handle = browserHandle(child, { kind: "headless", headless: true }, async () => {
				throw new Error("CDP close failed");
			});
			await releaseBrowser(handle, { kill: false });
		} else if (scenario === "joined-cleanup") {
			const handle = browserHandle(child);
			await releaseBrowser(handle, { kill: false });
			assert.equal(
				tree.leader.status(),
				ProcessStatus.Running,
				"Non-killing release must leave the application running",
			);
			await ensureSpawnedKilledForTest(handle);
		} else if (scenario === "foreign-identity") {
			const foreign = browserHandle({ subprocess: sentinel.subprocess, ownedProcess: child.ownedProcess });
			await expectRefusal(() => releaseBrowser(foreign, { kill: true }), sentinel.subprocess.pid);
			await expectRefusal(() => ensureSpawnedKilledForTest(foreign), sentinel.subprocess.pid);
			assert.equal(
				tree.leader.status(),
				ProcessStatus.Running,
				"A mismatched handle must not signal either process",
			);
			assertSentinel(sentinel.ownedProcess, sentinelIdentity);
			await gracefulKillTreeOnce(child.ownedProcess, 30);
		} else if (scenario === "repeated-cleanup") {
			const handle = browserHandle(child);
			await releaseBrowser(handle, { kill: true });
			await ensureSpawnedKilledForTest(handle);
			await releaseBrowser(handle, { kill: true });
			await gracefulKillTreeOnce(child.ownedProcess, 30);
		} else if (scenario === "stale-identity") {
			await fs.writeFile(path.join(directory, "leader.exit"), "exit");
			assert.equal(await child.subprocess.exited, 0);
			await assertGone(tree);
			await gracefulKillTreeOnce(child.ownedProcess, 30);
			const stale = browserHandle({ subprocess: sentinel.subprocess, ownedProcess: child.ownedProcess });
			await expectRefusal(() => releaseBrowser(stale, { kill: true }), sentinel.subprocess.pid);
			await expectRefusal(() => ensureSpawnedKilledForTest(stale), sentinel.subprocess.pid);
			const staleHeadless = browserHandle(
				{ subprocess: sentinel.subprocess, ownedProcess: child.ownedProcess },
				{ kind: "headless", headless: true },
				async () => {
					throw new Error("CDP close failed after original process exited");
				},
			);
			staleHeadless.ownedProcessExited = child.subprocess.exited;
			// A facade's current process PID cannot replace the acquisition-time birth pin.
			await releaseBrowser(staleHeadless, { kill: false });
			assertSentinel(sentinel.ownedProcess, sentinelIdentity);
		} else {
			throw new Error(`Unknown ownership scenario ${scenario}`);
		}
		await assertGone(tree);
		assert.equal(child.ownedProcess.identity(), birthIdentity, "Cleanup must retain the original process identity");
	}
	assertSentinel(sentinel.ownedProcess, sentinelIdentity);
	process.stdout.write(`PASS ${scenario}\n`);
} finally {
	abort.abort();
	await fs.writeFile(path.join(directory, "STOP"), "exit");
	await pendingOpen;
	// File-controlled shutdown also works when historical production spawn inherited the PGID.
	for (const child of tracked) {
		assert(
			await child.ownedProcess.waitForExit({ timeoutMs: 3_000 }),
			`Fixture ${child.ownedProcess.pid} survived final cleanup`,
		);
		await child.subprocess.exited;
	}
	for (const reference of observed) {
		assert(
			await reference.waitForExit({ timeoutMs: 3_000 }),
			`Observed fixture ${reference.pid} survived final cleanup`,
		);
	}
	clearTimeout(watchdog);
}
