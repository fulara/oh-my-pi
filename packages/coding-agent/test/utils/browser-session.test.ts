import { afterEach, describe, expect, it, vi } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import * as launchModule from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { captureBrowserSession } from "@oh-my-pi/pi-coding-agent/utils/browser-session";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import type { Browser, LaunchOptions, PuppeteerNode } from "puppeteer-core";

const request = {
	url: "https://www.perplexity.ai/auth/signin",
	cookieNames: ["__Secure-next-auth.session-token", "next-auth.session-token"],
};
const profiles: string[] = [];
const subprocesses: Array<{ subprocess: ChildProcess; exited: Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(
		subprocesses.splice(0).map(async ({ subprocess, exited }) => {
			if (subprocess.exitCode === null && subprocess.signalCode === null) subprocess.stdin?.end();
			await exited;
		}),
	);
	vi.restoreAllMocks();
	await Promise.all(profiles.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function browserFixture() {
	// An independent watchdog bounds this disposable child if the runner dies.
	// Synchronization uses stdin EOF and the exit promise, never clock delays.
	const subprocess = spawn(
		process.execPath,
		[
			"-e",
			'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setTimeout(() => process.exit(0), 30_000);',
		],
		{ detached: true, stdio: ["pipe", "ignore", "ignore"] },
	);
	const exited = new Promise<void>(resolve => subprocess.once("exit", () => resolve()));
	subprocesses.push({ subprocess, exited });
	const pid = subprocess.pid;
	if (pid === undefined) throw new Error("Disposable sign-in fixture did not spawn");
	const readCookies = vi.fn(async () => ({
		cookies: [
			{ name: "csrf", value: "other-cookie" },
			{ name: "next-auth.session-token", value: "alternate-session" },
			{ name: "__Secure-next-auth.session-token", value: "secret-session" },
		],
	}));
	const page = Object.assign(new EventEmitter(), {
		goto: vi.fn(async () => null),
		bringToFront: async () => {},
		createCDPSession: async () => ({ send: readCookies }),
	});
	const browser = Object.assign(new EventEmitter(), {
		connected: true,
		createBrowserContext: async () => ({ newPage: async () => page }),
		process: () => subprocess,
		close: vi.fn(async () => {
			subprocess.stdin.end();
			await exited;
			browser.connected = false;
			browser.emit("disconnected");
		}),
	});
	const launchBrowser = async (options: LaunchOptions) => {
		const dir = options.args?.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
		if (!dir) throw new Error("An owned browser profile is required");
		profiles.push(dir);
		await Bun.write(path.join(dir, "test-browser-state"), "temporary state");
		return browser as unknown as Browser;
	};
	const launch = vi.fn(launchBrowser);
	vi.spyOn(launchModule, "ensureChromiumExecutable").mockResolvedValue("/fake/chromium");
	const load = vi.spyOn(launchModule, "loadPuppeteer").mockResolvedValue({ launch } as unknown as PuppeteerNode);
	return { browser, subprocess, pid, page, readCookies, launch, launchBrowser, load };
}

async function expectProfilesRemoved() {
	for (const profile of profiles) await expect(fs.stat(profile)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("browser session capture", () => {
	it("prefers the secure cookie and removes the owned browser state", async () => {
		const fixture = browserFixture();
		await expect(captureBrowserSession(request)).resolves.toBe("secret-session");
		expect(fixture.readCookies).toHaveBeenCalledWith("Network.getCookies", { urls: [request.url] });
		expect(fixture.browser.connected).toBe(false);
		await expectProfilesRemoved();
	});

	it("terminates the retained sign-in process when close fails and PID lookup is unavailable", async () => {
		const fixture = browserFixture();
		const owned = Process.fromPid(fixture.pid);
		if (!owned || owned.ppid !== process.pid) throw new Error("Cannot pin disposable sign-in fixture");
		fixture.browser.close.mockRejectedValue(new Error("CDP close failed"));
		fixture.readCookies.mockImplementation(async () => {
			// Lose discovery after startup; only the original identity may authorize cleanup.
			vi.spyOn(Process, "fromPid").mockReturnValue(null);
			return { cookies: [{ name: request.cookieNames[0]!, value: "secret-session" }] };
		});

		await expect(captureBrowserSession(request)).resolves.toBe("secret-session");
		expect(owned.status()).toBe(ProcessStatus.Exited);
		await expectProfilesRemoved();
	});

	it("reports an unpinned live sign-in resource and preserves its profile without signaling", async () => {
		const fixture = browserFixture();
		const owned = Process.fromPid(fixture.pid);
		if (!owned || owned.ppid !== process.pid) throw new Error("Cannot pin disposable sign-in fixture");
		vi.spyOn(Process, "fromPid").mockReturnValue(null);

		await expect(captureBrowserSession(request)).rejects.toThrow(
			`Sign-in browser cleanup refused (PID ${fixture.pid})`,
		);
		expect(owned.status()).toBe(ProcessStatus.Running);
		for (const profile of profiles) expect((await fs.stat(profile)).isDirectory()).toBe(true);
	});

	it("captures an unprefixed Perplexity session when the secure cookie is absent", async () => {
		const fixture = browserFixture();
		fixture.readCookies.mockResolvedValue({
			cookies: [
				{ name: "csrf", value: "other-cookie" },
				{ name: "next-auth.session-token", value: "alternate-session" },
			],
		});
		await expect(captureBrowserSession(request, AbortSignal.timeout(1_000))).resolves.toBe("alternate-session");
		expect(fixture.browser.connected).toBe(false);
		await expectProfilesRemoved();
	});

	it("ignores an empty preferred cookie when the alternate session is available", async () => {
		const fixture = browserFixture();
		fixture.readCookies.mockResolvedValue({
			cookies: [
				{ name: "__Secure-next-auth.session-token", value: "" },
				{ name: "next-auth.session-token", value: "alternate-session" },
			],
		});
		await expect(captureBrowserSession(request, AbortSignal.timeout(1_000))).resolves.toBe("alternate-session");
		expect(fixture.browser.connected).toBe(false);
		await expectProfilesRemoved();
	});

	it("does not launch a browser for an already cancelled login", async () => {
		const fixture = browserFixture();
		const controller = new AbortController();
		controller.abort();
		await expect(captureBrowserSession(request, controller.signal)).rejects.toBeInstanceOf(LoginCancelledError);
		expect(fixture.load).not.toHaveBeenCalled();
	});

	it("cleans up a browser whose launch resolves after cancellation", async () => {
		const fixture = browserFixture();
		const started = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		fixture.launch.mockImplementation(async options => {
			const browser = await fixture.launchBrowser(options);
			started.resolve();
			await resume.promise;
			return browser;
		});
		const controller = new AbortController();
		const result = captureBrowserSession(request, controller.signal);
		await started.promise;
		controller.abort();
		resume.resolve();
		await expect(result).rejects.toBeInstanceOf(LoginCancelledError);
		expect(fixture.browser.connected).toBe(false);
		await expectProfilesRemoved();
	});

	it("cancels a pending navigation and closes the owned browser", async () => {
		const fixture = browserFixture();
		const started = Promise.withResolvers<void>();
		const navigation = Promise.withResolvers<null>();
		fixture.page.goto.mockImplementation(() => {
			started.resolve();
			return navigation.promise;
		});
		const controller = new AbortController();
		try {
			const result = captureBrowserSession(request, controller.signal);
			await started.promise;
			controller.abort();
			await expect(result).rejects.toBeInstanceOf(LoginCancelledError);
			expect(fixture.browser.connected).toBe(false);
			await expectProfilesRemoved();
		} finally {
			navigation.resolve(null);
		}
	});

	it("reports a closed login window instead of waiting for a session", async () => {
		const fixture = browserFixture();
		fixture.page.goto.mockImplementation(async () => {
			fixture.page.emit("close");
			return null;
		});
		await expect(captureBrowserSession(request)).rejects.toThrow(/window closed/i);
		expect(fixture.browser.connected).toBe(false);
		await expectProfilesRemoved();
	});

	it("surfaces cookie-read failures instead of silently retrying", async () => {
		const fixture = browserFixture();
		const failure = new Error("CDP request failed");
		fixture.readCookies.mockRejectedValue(failure);
		await expect(captureBrowserSession(request)).rejects.toBe(failure);
		expect(fixture.browser.connected).toBe(false);
		await expectProfilesRemoved();
	});

	it("times out a login without a session and removes the browser state", async () => {
		const fixture = browserFixture();
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
		const waiting = Promise.withResolvers<void>();
		fixture.readCookies.mockImplementation(async () => {
			waiting.resolve();
			return { cookies: [] };
		});
		const result = captureBrowserSession(request);
		await waiting.promise;
		timeout.abort();
		await expect(result).rejects.toThrow(/timed out/i);
		expect(fixture.browser.connected).toBe(false);
		await expectProfilesRemoved();
	});
});
