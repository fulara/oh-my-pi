/**
 * Fura fork: a launched headless Chromium is cleaned up only through the process
 * identity pinned at launch. Without it the profile is kept and cleanup refuses.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";

async function makeProfileDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
	await Bun.write(path.join(dir, "SingletonLock"), "lock");
	await Bun.write(path.join(dir, "Default", "Preferences"), "{}");
	return dir;
}

describe("headless Chromium pinned cleanup", () => {
	it("preserves the profile when the browser has no retained process ownership", async () => {
		const dir = await makeProfileDir();
		const handle = {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			refCount: 1,
			userDataDir: dir,
			browser: { connected: true, close: () => Promise.resolve() },
			stealth: { browserSession: null, override: null },
		} as unknown as BrowserHandle;
		try {
			await expect(releaseBrowser(handle, { kill: false })).rejects.toBeInstanceOf(Error);
			expect(fs.existsSync(path.join(dir, "SingletonLock"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "Default", "Preferences"))).toBe(true);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("kills an owned-profile browser through its pinned identity without a graceful close and removes its profile", async () => {
		const dir = await makeProfileDir();
		// Stands in for a Chromium whose graceful shutdown never finishes.
		const chromium = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"]);
		let closeCalls = 0;
		const handle = {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			refCount: 1,
			userDataDir: dir,
			pid: chromium.pid,
			ownedProcess: Process.fromPid(chromium.pid),
			ownedProcessExited: chromium.exited.then(() => undefined),
			browser: {
				connected: true,
				close: () => {
					closeCalls++;
					return Promise.withResolvers<void>().promise;
				},
			},
			stealth: { browserSession: null, override: null },
		} as unknown as BrowserHandle;
		try {
			await releaseBrowser(handle, { kill: false });
			await chromium.exited;
			expect(closeCalls).toBe(0);
			expect(fs.existsSync(dir)).toBe(false);
		} finally {
			chromium.kill("SIGKILL");
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
