import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Process } from "@oh-my-pi/pi-natives";
import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import { type ChildProcess, spawn } from "@oh-my-pi/pi-utils/ptree";

// Real native escalation cannot use fake timers; readiness and exit are explicit.
const STUBBORN_CHILD =
	'process.on("SIGTERM", () => {}); Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("fixture")}); console.log("ready");';

interface OwnedChild {
	child: ChildProcess;
	handle: Process;
	identity: string;
}

async function ownedChild(): Promise<OwnedChild> {
	const child = spawn([process.execPath, "-e", STUBBORN_CHILD], { detached: true });
	const handle = Process.fromPid(child.pid);
	if (!handle || handle.ppid !== process.pid || child.proc.exitCode !== null) {
		throw new Error(`Fixture ownership unavailable for PID ${child.pid}; cleanup refused`);
	}
	try {
		const reader = child.stdout.getReader();
		try {
			const ready = await withTimeout(reader.read(), 2000, "Owned fixture did not become ready");
			expect(new TextDecoder().decode(ready.value)).toContain("ready");
		} finally {
			reader.releaseLock();
		}
		return { child, handle, identity: handle.identity() };
	} catch (error) {
		await handle.terminate({ group: false, gracefulMs: -1 });
		await withTimeout(child.proc.exited, 2000, "Failed fixture did not exit");
		throw error;
	}
}

describe("ptree cleanup requires the original process identity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.skipIf(process.platform === "win32")("does not acquire a foreign identity from a late PID lookup", async () => {
		const sentinel = await ownedChild();
		let victim: OwnedChild | undefined;
		try {
			victim = await ownedChild();
			// A regressed lookup cannot signal even this disposable foreign sentinel.
			spyOn(sentinel.handle, "terminate").mockResolvedValue(false);
			spyOn(Process, "fromPid").mockReturnValue(sentinel.handle);
			victim.child.kill(undefined, 50);
			await withTimeout(victim.child.exited, 2000, "Owned victim did not exit");
			expect(victim.child.proc.signalCode).toBe("SIGKILL");
			expect(sentinel.child.proc.exitCode).toBeNull();
			expect(sentinel.handle.identity()).toBe(sentinel.identity);
		} finally {
			vi.restoreAllMocks();
			for (const owned of [victim, sentinel]) {
				if (!owned) continue;
				await owned.handle.terminate({ group: false, gracefulMs: -1 });
				await withTimeout(owned.child.proc.exited, 2000, "Owned fixture cleanup did not exit");
			}
		}
	});

	it.skipIf(process.platform === "win32")("reports native cleanup failure without a numeric fallback", async () => {
		const owned = await ownedChild();
		const reported = Promise.withResolvers<Record<string, unknown> | undefined>();
		try {
			spyOn(logger, "warn").mockImplementation((_message, context) => reported.resolve(context));
			spyOn(Process.prototype, "terminate").mockRejectedValue(new Error("native fixture refusal"));
			owned.child.kill(undefined, -1);
			const resource = await withTimeout(reported.promise, 2000, "Native cleanup refusal was not reported");
			expect(resource?.pid).toBe(owned.child.pid);
			expect(owned.child.proc.exitCode).toBeNull();
			expect(owned.handle.identity()).toBe(owned.identity);
		} finally {
			vi.restoreAllMocks();
			await owned.handle.terminate({ group: false, gracefulMs: -1 });
			await withTimeout(owned.child.proc.exited, 2000, "Native refusal fixture cleanup did not exit");
		}
	});
});

describe.skipIf(process.platform !== "linux")("ptree subreaper kill without a usable native process handle", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Exits on its own, so a command the fallback cannot reach ends without a leak.
	const SHORT_CHILD = 'console.log("ready"); setTimeout(() => {}, 2000);';

	it.each([
		[
			"the handle lookup throws",
			() => {
				throw new Error("Value is not an instance of class `Process`");
			},
		],
		[
			"the handle cannot list its children",
			() =>
				({
					children: () => {
						throw new Error("Value is not an instance of class `Process`");
					},
				}) as unknown as Process,
		],
	])("signals the subreaper directly when %s", async (_name, fromPid) => {
		for (const [stop, signalCode] of [
			[(child: ChildProcess) => child.kill(undefined, 50), "SIGTERM"],
			[(child: ChildProcess) => child.kill(undefined, -1), "SIGKILL"],
			[(child: ChildProcess) => child[Symbol.dispose](), "SIGTERM"],
		] as const) {
			const child = spawn([process.execPath, "-e", SHORT_CHILD], { subreaper: true });
			const reader = child.stdout.getReader();
			await reader.read(); // "ready": the subreaper has launched the command
			reader.releaseLock();
			const lookup = spyOn(Process, "fromPid").mockImplementation(fromPid);

			// The stop must neither throw nor report success without signalling:
			// a kill that never signals leaves `exited` pending until the test times out.
			stop(child);
			await child.exited.catch(() => {});
			lookup.mockRestore();
			expect(child.proc.signalCode).toBe(signalCode);
		}
	});

	it("never leaves the subreaper or its command stopped when the stop fails while they are frozen", async () => {
		// The first children() read reports nothing, so the stop freezes the tree and
		// reads again; that read throws. The resume must still run, so the fallback's
		// SIGTERM ends the subreaper (a stopped one would only die at the SIGKILL)
		// and the command is not left stopped for ever.
		for (const [gracefulMs, signalCode] of [
			[50, "SIGTERM"],
			[-1, "SIGKILL"],
		] as const) {
			const child = spawn([process.execPath, "-e", SHORT_CHILD], { subreaper: true });
			const reader = child.stdout.getReader();
			await reader.read(); // "ready": the subreaper has launched the command
			reader.releaseLock();
			const root = Process.fromPid(child.pid);
			const command = root?.children()[0];
			if (!root || !command) throw new Error("failed to capture the subreaper process tree");
			try {
				let reads = 0;
				const failingSecondRead = {
					children: (): Process[] => {
						if (++reads === 1) return [];
						throw new Error("Value is not an instance of class `Process`");
					},
					killTree: (signal?: number) => root.killTree(signal),
				} as unknown as Process;
				const lookup = spyOn(Process, "fromPid").mockImplementation(pid =>
					pid === child.pid ? failingSecondRead : null,
				);

				child.kill(undefined, gracefulMs);
				await child.exited.catch(() => {});
				lookup.mockRestore();

				expect(reads).toBe(2);
				expect(child.proc.signalCode).toBe(signalCode);
				// procfs reports size 0, so read it with readFile rather than a sized Bun.file read.
				const state = (await fs.readFile(`/proc/${command.pid}/stat`, "utf8")).split(") ")[1]?.[0];
				expect(state, `command ${command.pid} left stopped`).not.toBe("T");
			} finally {
				command.killTree(9);
			}
		}
	});
});
