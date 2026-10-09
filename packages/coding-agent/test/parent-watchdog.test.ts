import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { readLines } from "@oh-my-pi/pi-utils";

const FIXTURE = path.join(import.meta.dir, "fixtures", "parent-watchdog-orphan.ts");

describe("startParentWatchdog", () => {
	// Issue #14340: an IPC worker whose main thread was pinned inside a
	// synchronous native call (onnxruntime inference) outlived its dead parent
	// as a multi-GiB PPID-1 orphan, because the parent-liveness watchdog ran on
	// that same starved event loop.
	it("kills an orphaned process whose main thread is blocked", async () => {
		const middle = Bun.spawn([process.execPath, FIXTURE], {
			detached: true,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		const candidateOwner = Process.fromPid(middle.pid);
		let owner: Process | null = null;
		let child: Process | null = null;
		let pipeOpen = true;
		try {
			expect(candidateOwner).not.toBeNull();
			expect(candidateOwner?.ppid).toBe(process.pid);
			if (process.platform !== "win32") expect(candidateOwner?.groupId()).toBe(middle.pid);
			// The fixture keeps its parent alive until we pin the exact child
			// instance it owns. Never discover a numeric PID after orphaning.
			let born: { pid: number; identity: string; ownerIdentity: string } | undefined;
			for await (const line of readLines(middle.stdout)) {
				born = JSON.parse(new TextDecoder().decode(line));
				break;
			}
			expect(born).toBeDefined();
			expect(candidateOwner?.identity()).toBe(born!.ownerIdentity);
			owner = candidateOwner;
			const candidate = Process.fromPid(born!.pid);
			expect(candidate).not.toBeNull();
			expect(candidate?.identity()).toBe(born!.identity);
			expect(candidate?.ppid).toBe(middle.pid);
			child = candidate;
			middle.stdin.write("orphan\n");
			middle.stdin.end();
			pipeOpen = false;
			await middle.exited;
			if (process.platform === "win32") expect(middle.exitCode).toBe(1);
			else expect(middle.signalCode).toBe("SIGKILL");
			expect(await child!.waitForExit({ timeoutMs: 5_000 })).toBe(true);
		} finally {
			// EOF also releases an unarmed fixture on assertion/startup failure.
			if (pipeOpen) middle.stdin.end();
			await child?.terminate({ group: false, gracefulMs: 100, timeoutMs: 2_000 });
			await owner?.terminate({ group: false, gracefulMs: 100, timeoutMs: 2_000 });
			await middle.exited;
		}
	}, 15_000);
});
