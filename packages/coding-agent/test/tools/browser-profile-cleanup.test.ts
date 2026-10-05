/**
 * Regression test for issue #7058: on Windows, puppeteer-core deletes its temp
 * Chrome profile with an unretried `rm()` from an eager process-exit hook, so an
 * EBUSY on the still-locked profile surfaces as an unhandled rejection that
 * crashes OMP. OMP now owns the profile directory and removes it itself with a
 * lock-tolerant, warn-and-leave cleanup.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeUserDataDir } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as piUtils from "@oh-my-pi/pi-utils";

async function makeProfileDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
	await Bun.write(path.join(dir, "SingletonLock"), "lock");
	await Bun.write(path.join(dir, "Default", "Preferences"), "{}");
	return dir;
}

describe("headless Chromium profile cleanup (issue #7058)", () => {
	afterEach(() => {
		spyOn(piUtils, "removeWithRetries").mockRestore();
		spyOn(piUtils.logger, "warn").mockRestore();
	});

	it("removes an owned profile directory", async () => {
		const dir = await makeProfileDir();
		await removeUserDataDir(dir);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("warns and leaves the directory instead of throwing when it stays locked (EBUSY)", async () => {
		const dir = await makeProfileDir();
		const ebusy = Object.assign(new Error(`EBUSY: resource busy or locked, rm '${dir}'`), { code: "EBUSY" });
		const removeSpy = spyOn(piUtils, "removeWithRetries").mockRejectedValue(ebusy);
		try {
			await removeUserDataDir(dir);
			expect(fs.existsSync(dir)).toBe(true);
		} finally {
			removeSpy.mockRestore();
			// Real removal so the fixture does not leak.
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves the profile when the browser has no retained process ownership", async () => {
		const dir = await makeProfileDir();
		const handle = {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			refCount: 1,
			userDataDir: dir,
			browser: {
				connected: true,
				close: () => Promise.resolve(),
			},
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
});
