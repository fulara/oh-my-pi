// Integration test: runBoundedProbe spawns and kills a real subprocess, so the
// timeout/abort teardown is inherently wall-clock bound. Fake timers cannot
// advance a child process's execution or resolve its `exited` promise, so the
// real-timer exception in ts-no-test-timers applies here.
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { probeCandidates, runBoundedProbe } from "../../src/eval/probe";

// A cross-platform "hangs forever" command: re-invoke the running Bun to sleep.
const bun = process.execPath;
const HANG = [bun, "-e", "await Bun.sleep(60_000)"];
const IGNORE_TERM = [bun, "-e", 'process.on("SIGTERM", () => {}); await Bun.sleep(60_000)'];
const baseEnv = (): Record<string, string | undefined> => ({ ...process.env });

describe("runBoundedProbe", () => {
	test("a hung probe is bounded by its timeout instead of hanging (regression: #9466)", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, { cwd: process.cwd(), env: baseEnv(), timeoutMs: 300 });
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("force-kills a probe that ignores SIGTERM when its timeout expires", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(IGNORE_TERM, {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 300,
		});
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("kills descendants spawned by an interpreter shim", async () => {
		const pidFile = join(tmpdir(), `omp-probe-grandchild-${process.pid}-${Date.now()}.pid`);
		let grandchild: Process | null = null;
		const controller = new AbortController();
		const wrapper = [
			bun,
			"-e",
			`const child=Bun.spawn([process.execPath,"-e","await Bun.sleep(10_000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});await Bun.write(${JSON.stringify(pidFile)},JSON.stringify({pid:child.pid,parent:process.pid}));await child.exited`,
		];
		const pending = runBoundedProbe(wrapper, {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		try {
			const deadline = Date.now() + 2_000;
			while (!(await Bun.file(pidFile).exists())) {
				if (Date.now() > deadline) throw new Error("Shim did not reach its readiness handshake");
				await Bun.sleep(10);
			}
			const record = await Bun.file(pidFile).json();
			const parent = Process.fromPid(record.parent);
			const candidate = Process.fromPid(record.pid);
			if (!parent || parent.ppid !== process.pid || !candidate || candidate.ppid !== parent.pid) {
				throw new Error("Cannot establish ownership of the shim worker");
			}
			grandchild = candidate;
			controller.abort();
			expect(await pending).toEqual({ exitCode: null, timedOut: false, aborted: true });
			expect(grandchild.status()).toBe(ProcessStatus.Exited);
		} finally {
			controller.abort();
			await pending;
			await grandchild?.terminate({ group: false, gracefulMs: -1 });
			await rm(pidFile, { force: true });
		}
	});

	test("an already-aborted signal short-circuits without spawning", async () => {
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.abort(),
		});
		expect(result).toEqual({ exitCode: null, timedOut: false, aborted: true });
	});

	test("an in-flight probe is killed when its signal aborts", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.timeout(100),
		});
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("a fast probe reports its real exit code", async () => {
		const ok = await runBoundedProbe([bun, "-e", "process.exit(0)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(ok).toEqual({ exitCode: 0, timedOut: false, aborted: false });

		const failing = await runBoundedProbe([bun, "-e", "process.exit(3)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(failing).toEqual({ exitCode: 3, timedOut: false, aborted: false });
	});
});

describe("probeCandidates", () => {
	test("shares one discovery deadline across hung candidates instead of paying it per candidate", async () => {
		const start = Date.now();
		const result = await probeCandidates(
			[
				{ command: HANG, env: baseEnv(), label: "cand-a" },
				{ command: HANG, env: baseEnv(), label: "cand-b" },
				{ command: HANG, env: baseEnv(), label: "cand-c" },
			],
			{ cwd: process.cwd(), timeoutMs: 300 },
		);
		const elapsed = Date.now() - start;
		expect(result).toEqual({ ok: false, aborted: false, failures: expect.any(Array) });
		// One 300ms budget total, not 3×: the whole discovery stays well under the
		// combined per-candidate cost it would incur without a shared deadline.
		expect(elapsed).toBeLessThan(900);
	});

	test("returns the first candidate that exits 0 and skips the rest", async () => {
		const result = await probeCandidates(
			[
				{ command: [bun, "-e", "process.exit(1)"], env: baseEnv(), label: "bad" },
				{ command: [bun, "-e", "process.exit(0)"], env: baseEnv(), label: "good" },
				{ command: HANG, env: baseEnv(), label: "would-hang" },
			],
			{ cwd: process.cwd(), timeoutMs: 5_000 },
		);
		expect(result).toEqual({ ok: true, index: 1 });
	});
});
