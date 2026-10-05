import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import type { OAuthBrowserSessionRequest } from "@oh-my-pi/pi-ai/oauth/types";
import { Process } from "@oh-my-pi/pi-natives";
import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import type { Browser } from "puppeteer-core";
import { gracefulKillTreeOnce, waitForBrowserProcessExit } from "../tools/browser/attach";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { ensureChromiumExecutable, loadPuppeteer, removeUserDataDir } from "../tools/browser/launch";

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Own an isolated sign-in browser; return one cookie value in preference order, never the cookie jar. */
export async function captureBrowserSession(
	request: OAuthBrowserSessionRequest,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) throw new LoginCancelledError();
	if (new URL(request.url).protocol !== "https:") throw new Error("Browser sign-in requires an HTTPS URL.");

	const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const closed = new AbortController();
	const waiting = AbortSignal.any([lifetime, closed.signal]);
	let browser: Browser | undefined;
	let ownedProcess: Process | undefined;
	let browserPid: number | undefined;
	let browserExited: Promise<void> | undefined;
	let userDataDir: string | undefined;
	let capturedCookie: string | undefined;
	let captureError: unknown;
	let captureFailed = false;
	try {
		const [puppeteer, executablePath] = await untilAborted(lifetime, () =>
			Promise.all([loadPuppeteer(), ensureChromiumExecutable()]),
		);
		userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sso-profile-"));
		lifetime.throwIfAborted();
		// Do not race launch: retain ownership even if cancellation happens before it resolves.
		// Unlike general browser tooling, authentication keeps sandbox and TLS checks enabled.
		browser = await puppeteer.launch({
			executablePath,
			headless: false,
			defaultViewport: null,
			pipe: true,
			ignoreDefaultArgs: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
			args: [`--user-data-dir=${userDataDir}`],
			signal: lifetime,
			timeout: 30_000,
		});
		const child = browser.process();
		browserPid = child?.pid;
		const pinned = browserPid === undefined ? null : Process.fromPid(browserPid);
		if (!pinned || pinned.ppid !== process.pid || child?.exitCode !== null || child.signalCode !== null) {
			throw new ToolError(`Cannot establish ownership of sign-in browser (PID ${browserPid ?? "unavailable"}).`);
		}
		ownedProcess = pinned;
		browserExited = new Promise<void>(resolve => child.once("exit", () => resolve()));
		lifetime.throwIfAborted();
		browser.once("disconnected", () => closed.abort());
		const context = await untilAborted(waiting, () => browser!.createBrowserContext());
		const page = await untilAborted(waiting, () => context.newPage());
		page.once("close", () => closed.abort());
		await untilAborted(waiting, () => page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
		await untilAborted(waiting, () => page.bringToFront());
		const cdp = await untilAborted(waiting, () => page.createCDPSession());
		capture: while (true) {
			// Chromium applies domain/path/secure matching, including HttpOnly cookies.
			const { cookies } = await untilAborted(waiting, () => cdp.send("Network.getCookies", { urls: [request.url] }));
			waiting.throwIfAborted();
			for (const name of request.cookieNames) {
				const session = cookies.find(cookie => cookie.name === name && cookie.value);
				if (session) {
					capturedCookie = session.value;
					break capture;
				}
			}
			await untilAborted(waiting, () => Bun.sleep(250));
		}
	} catch (error) {
		captureFailed = true;
		captureError = signal?.aborted
			? new LoginCancelledError()
			: timeout.aborted
				? new Error("Browser sign-in timed out. Start login again.")
				: closed.signal.aborted
					? new Error("Login window closed before sign-in completed.")
					: error;
	}
	try {
		if (browser) {
			if (!ownedProcess) {
				const message = `Sign-in browser cleanup refused (PID ${browserPid ?? "unavailable"}): no birth-pinned process identity; the resource may still be running. Profile retained at ${userDataDir ?? "(unavailable)"}.`;
				logger.warn(message, { pid: browserPid, userDataDir });
				throw new ToolError(message);
			}
			try {
				await withTimeout(browser.close(), 5_000, "Timed out closing sign-in browser");
			} catch {
				logger.warn("Sign-in browser did not close cleanly", { pid: ownedProcess.pid });
				await gracefulKillTreeOnce(ownedProcess);
			}
			if (browserExited) await waitForBrowserProcessExit(ownedProcess, browserExited);
		}
		if (userDataDir) await removeUserDataDir(userDataDir);
	} catch (cleanupError) {
		if (captureFailed) {
			throw new AggregateError(
				[captureError, cleanupError],
				`Browser sign-in and owned resource cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
			);
		}
		throw cleanupError;
	}
	if (captureFailed) throw captureError;
	return capturedCookie!;
}
