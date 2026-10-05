import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";

const probe = path.resolve(import.meta.dir, "../fixtures/browser-process-ownership-probe.ts");

// Production imports run in a fresh Bun process: unrelated browser suites' module
// mocks/fake timers cannot turn these real process regressions into mock echoes.
async function runOwnershipProbe(scenario: string) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-ownership-"));
	const subprocess = Bun.spawn([process.execPath, probe, scenario, directory], {
		cwd: path.resolve(import.meta.dir, "../.."),
		detached: true,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const ownedProcess = Process.fromPid(subprocess.pid);
	const timeout = Promise.withResolvers<never>();
	// Real OS watchdog: fake timers cannot bound a crashed/hung independent Bun process.
	const timer = setTimeout(() => timeout.reject(new Error(`Ownership probe ${scenario} timed out`)), 28_000);
	try {
		if (!ownedProcess) throw new Error("Cannot pin ownership probe at birth");
		expect(ownedProcess.groupId()).toBe(subprocess.pid);
		const birthIdentity = ownedProcess.identity();
		const [exitCode, stdout, stderr] = await Promise.race([
			Promise.all([
				subprocess.exited,
				new Response(subprocess.stdout).text(),
				new Response(subprocess.stderr).text(),
			]),
			timeout.promise,
		]);
		expect(exitCode, `${scenario}: ${stderr}\n${stdout}`).toBe(0);
		expect(stdout).toBe(`PASS ${scenario}\n`);
		expect(ownedProcess.identity()).toBe(birthIdentity);
	} finally {
		clearTimeout(timer);
		await fs.writeFile(path.join(directory, "STOP"), "exit");
		if (ownedProcess && !(await ownedProcess.waitForExit({ timeoutMs: 3_000 }))) {
			// Only this birth-pinned, dedicated, disposable probe is eligible.
			// Native ancestor/identity guards remain in force; no raw group signals.
			if (ownedProcess.groupId() !== subprocess.pid) throw new Error("Refusing cleanup of a non-dedicated probe");
			if (!(await ownedProcess.terminate({ gracefulMs: 30, timeoutMs: 2_000 }))) {
				throw new Error(`Ownership probe ${ownedProcess.pid} survived cleanup`);
			}
		}
		await subprocess.exited;
		// A historical bug may terminate the probe before its finally runs.
		// STOP still reaches every surviving fixture, including reparented workers.
		for (const role of ["sentinel", "leader", "worker"]) {
			const ready = Bun.file(path.join(directory, `${role}.json`));
			if (!(await ready.exists())) continue;
			const birth = (await ready.json()) as { pid: number; identity: string };
			const remaining = Process.fromPid(birth.pid);
			if (!remaining || remaining.identity() !== birth.identity) continue;
			expect(
				await remaining.waitForExit({ timeoutMs: 3_000 }),
				`${role} ${birth.pid} survived fixture cleanup`,
			).toBe(true);
			expect(remaining.status()).toBe(ProcessStatus.Exited);
		}
		await fs.rm(directory, { recursive: true, force: true });
	}
}

// PGID isolation is a POSIX contract. These tests need Bun and pi-natives, not Chrome.
describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("browser process ownership", () => {
	it("production spawn isolates the application PGID and preserves the sentinel through ordinary exit", async () => {
		await runOwnershipProbe("ordinary-exit");
	}, 35_000);

	it("birth-pinned termination removes the leader and stubborn worker but preserves the sentinel", async () => {
		await runOwnershipProbe("termination");
	}, 35_000);

	it("failed Puppeteer attachment cleans the real spawned application tree without signaling the sentinel", async () => {
		await runOwnershipProbe("attach-failure");
	}, 35_000);

	it("interrupted CDP startup cleans the real spawned application tree without signaling the sentinel", async () => {
		await runOwnershipProbe("startup-interrupt");
	}, 35_000);

	it("headless close timeout terminates the birth-pinned tree and preserves the sentinel", async () => {
		await runOwnershipProbe("headless-timeout");
	}, 35_000);

	it("headless close failure terminates the birth-pinned tree and preserves the sentinel", async () => {
		await runOwnershipProbe("headless-failure");
	}, 35_000);

	it("joined killing cleanup terminates an application left running by an earlier non-killing release", async () => {
		await runOwnershipProbe("joined-cleanup");
	}, 35_000);

	it("repeated release and kill cleanup retain the same birth identity and preserve the sentinel", async () => {
		await runOwnershipProbe("repeated-cleanup");
	}, 35_000);

	it("stale ownership never recaptures a live sentinel from subprocess or browser.process PID", async () => {
		await runOwnershipProbe("stale-identity");
	}, 35_000);

	it("foreign subprocess identity is refused without signaling either real process", async () => {
		await runOwnershipProbe("foreign-identity");
	}, 35_000);

	it("borrowed discovered connected and broker handles never signal the sentinel and missing ownership is reported", async () => {
		await runOwnershipProbe("borrowed-guards");
	}, 35_000);

	it("native self and ancestor ownership refusals identify the remaining disposable resource", async () => {
		await runOwnershipProbe("native-refusal");
	}, 35_000);

	it("native group termination refuses a shared PGID while removing only the owned leader and worker", async () => {
		await runOwnershipProbe("shared-group");
	}, 35_000);
});
