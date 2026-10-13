import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Process } from "@oh-my-pi/pi-natives";
import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import { ChildProcess, spawn } from "@oh-my-pi/pi-utils/ptree";

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
