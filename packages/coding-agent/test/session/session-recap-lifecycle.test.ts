import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRecapEnabled, cfgRecapIdleSeconds } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { lookupLatestSessionRecap, resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	enableRpcSessionRecaps,
	readRpcSessionRecap,
	SessionRecapController,
} from "@oh-my-pi/pi-coding-agent/session/session-recap";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { mockSchedulerWaitWithClock } from "../helpers/mock-scheduler-clock";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 100; i++) await Promise.resolve();
}

describe("shared idle recap lifecycle", () => {
	let directory: string;
	let session: AgentSession;
	let auth: AuthStorage;
	let requests: { stream: AssistantMessageEventStream; signal: AbortSignal | undefined }[];
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalNoTitle = process.env.PI_NO_TITLE;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recap-lifecycle-"));
		setAgentDir(directory);
		process.env.PI_NO_TITLE = "1";
		resetSessionIndexForTests();
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("anthropic", "test-key");
		requests = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const message = createAssistantMessage("Main turn complete");
				stream.push({ type: "done", reason: "stop", message });
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
			settings: Settings.isolated({
				"recap.idleSeconds": 1,
				"compaction.enabled": false,
				"compaction.idleEnabled": false,
				"contextPromotion.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"async.enabled": false,
			}),
			modelRegistry: new ModelRegistry(auth, path.join(directory, "models.yml")),
			sideStreamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				requests.push({ stream, signal: options?.signal });
				return stream;
			},
		});
		vi.useFakeTimers();
		// Agent-loop cooperative yields also use scheduler.wait() plus a
		// performance.now() minimum-duration check. Advance that scheduler clock
		// together rather than parking prompt() on the idle-recap fake clock.
		mockSchedulerWaitWithClock();
		// Agent.syncContextBeforeModelCall cooperatively yields with Bun.sleep(0).
		// Awaiting prompt() under a stopped fake clock otherwise deadlocks before
		// the provider runs. Keep that zero-time yield asynchronous, while actual
		// elapsed-time waits (including the recap timeout) remain clock-controlled.
		const clockSleep = Bun.sleep.bind(Bun);
		vi.spyOn(Bun, "sleep").mockImplementation(duration => {
			if (duration === 0) return Promise.resolve();
			return clockSleep(duration);
		});
	});

	afterEach(async () => {
		vi.useRealTimers();
		for (const request of requests) request.stream.end();
		await session.dispose();
		auth.close();
		vi.restoreAllMocks();
		resetSessionIndexForTests();
		setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		if (originalNoTitle === undefined) delete process.env.PI_NO_TITLE;
		else process.env.PI_NO_TITLE = originalNoTitle;
		removeSyncWithRetries(directory);
	});

	async function beginRecap(): Promise<void> {
		enableRpcSessionRecaps(session);
		await session.prompt("Finish the work");
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
	}

	async function finishRecap(
		index = 0,
		text = "The implementation is complete; verification remains.",
	): Promise<void> {
		const message = createAssistantMessage(text);
		requests[index].stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		requests[index].stream.push({ type: "done", reason: "stop", message });
		await flushMicrotasks();
	}

	it("keeps persisted recaps attached to the journal when provider routing identity changes", async () => {
		await beginRecap();
		await finishRecap();
		const previousWireId = session.sessionId;
		const journalId = session.sessionManager.getSessionId();
		const recap = session.getSessionRecap().recap;
		session.freshSession();
		expect(session.sessionId).not.toBe(previousWireId);
		expect(session.sessionManager.getSessionId()).toBe(journalId);
		expect(() => readRpcSessionRecap(session, previousWireId)).toThrow("Session ID does not match");
		expect(readRpcSessionRecap(session, session.sessionId)).toMatchObject({
			sessionId: session.sessionId,
			recap,
		});
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
	});

	it("persists one terminal recap without mutating history or Busy, and reads never infer", async () => {
		await beginRecap();
		await session.sessionManager.flush();
		const id = session.sessionManager.getSessionId();
		const file = session.sessionManager.getSessionFile()!;
		const historyBefore = await Bun.file(file).text();
		const messagesBefore = JSON.stringify(session.messages);
		const sourceLeaf = session.sessionManager.getLeafId();
		expect(readRpcSessionRecap(session, id).generating).toBe(true);
		expect(session.isStreaming).toBe(false);
		await finishRecap();
		const state = readRpcSessionRecap(session, id);
		expect(state.recap).toMatchObject({ sourceLeafId: sourceLeaf, stale: false });
		expect(state.recap?.createdAt).toBeGreaterThan(1_000_000_000_000);
		expect(state.generating).toBe(false);
		for (let i = 0; i < 3; i++) readRpcSessionRecap(session, id);
		vi.advanceTimersByTime(20_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
		expect(JSON.stringify(session.messages)).toBe(messagesBefore);
		expect(await Bun.file(file).text()).toBe(historyBefore);
		expect(session.isStreaming).toBe(false);

		cfgRecapEnabled.set(session.settings, false);
		expect(readRpcSessionRecap(session, id).recap?.id).toBe(state.recap?.id);
		await session.prompt("New history");
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(readRpcSessionRecap(session, id).recap?.stale).toBe(true);
		expect(requests).toHaveLength(1);
	});

	it("never arms on activation, pure reads, or nonterminal settles; repeated terminal signals dedupe", async () => {
		await session.prompt("Finish before activation");
		const owner = new SessionRecapController(session);
		const disable = owner.enable({});
		try {
			owner.read();
			owner.handleEvent({ type: "agent_end", messages: [], isTerminal: false });
			vi.advanceTimersByTime(1_000);
			await flushMicrotasks();
			expect(requests).toHaveLength(0);
			owner.handleEvent({ type: "agent_end", messages: [], isTerminal: true });
			owner.handleEvent({ type: "agent_end", messages: [], isTerminal: true });
			vi.advanceTimersByTime(1_000);
			await flushMicrotasks();
			await finishRecap();
			owner.handleEvent({ type: "agent_end", messages: [], isTerminal: true });
			vi.advanceTimersByTime(1_000);
			await flushMicrotasks();
			expect(requests).toHaveLength(1);
			expect(owner.read().recap?.stale).toBe(false);
		} finally {
			disable();
		}
	});

	it("arms when enabled mid-idle without redelivering a persisted recap", async () => {
		cfgRecapEnabled.override(session.settings, false);
		const displayed: string[] = [];
		session.enableIdleRecaps({ onRecap: text => displayed.push(text) });
		await session.prompt("Complete work while recaps are disabled");
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(0);

		cfgRecapEnabled.override(session.settings, true);
		await flushMicrotasks();
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
		await finishRecap(0, "Recap body.");
		const saved = session.getSessionRecap().recap;
		expect(saved?.text).toBe("Recap body.");

		cfgRecapIdleSeconds.override(session.settings, 2);
		await flushMicrotasks();
		cfgRecapEnabled.override(session.settings, false);
		await flushMicrotasks();
		cfgRecapEnabled.override(session.settings, true);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
		expect(displayed).toEqual(["Recap body."]);
		expect(session.getSessionRecap().recap?.id).toBe(saved?.id);
	});

	it("restarts the pending delay when idleSeconds changes", async () => {
		enableRpcSessionRecaps(session);
		await session.prompt("Complete work");
		vi.advanceTimersByTime(500);
		cfgRecapIdleSeconds.override(session.settings, 2);
		await flushMicrotasks();
		vi.advanceTimersByTime(1_999);
		await flushMicrotasks();
		expect(requests).toHaveLength(0);
		vi.advanceTimersByTime(1);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
		await finishRecap();
		expect(session.getSessionRecap().recap?.stale).toBe(false);
	});

	it("cancels the pending delay when disabled and can rearm the same idle turn", async () => {
		enableRpcSessionRecaps(session);
		await session.prompt("Complete work");
		cfgRecapEnabled.override(session.settings, false);
		await flushMicrotasks();
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(0);
		cfgRecapEnabled.override(session.settings, true);
		await flushMicrotasks();
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		await finishRecap();
		expect(session.getSessionRecap().recap?.stale).toBe(false);
	});

	it("aborts inference on settings changes and drains ignored cancellation before rearming", async () => {
		await beginRecap();
		cfgRecapEnabled.override(session.settings, false);
		await flushMicrotasks();
		expect(requests[0].signal?.aborted).toBe(true);
		expect(session.getSessionRecap().generating).toBe(false);
		cfgRecapEnabled.override(session.settings, true);
		await flushMicrotasks();
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
		await finishRecap(0, "Cancelled reply");
		expect(session.getSessionRecap().recap).toBeNull();
		expect(requests).toHaveLength(2);
		await finishRecap(1, "Current reply");
		expect(session.getSessionRecap().recap?.text).toBe("Current reply");
	});

	it("does not arm from settings changes before an enabled host observes a terminal settle", async () => {
		await session.prompt("Complete before activation");
		enableRpcSessionRecaps(session);
		cfgRecapIdleSeconds.override(session.settings, 2);
		await flushMicrotasks();
		vi.advanceTimersByTime(2_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(0);
		expect(session.getSessionRecap().recap).toBeNull();
	});

	it.each(["queuedMessageCount", "isCompacting"] as const)(
		"guards settings-triggered inference and late replies while %s is active",
		async guard => {
			const displayed: string[] = [];
			session.enableIdleRecaps({ onRecap: text => displayed.push(text) });
			await session.prompt("Complete work");
			let blocked = true;
			Object.defineProperty(session, guard, {
				configurable: true,
				get: () => (guard === "queuedMessageCount" ? Number(blocked) : blocked),
			});
			try {
				cfgRecapIdleSeconds.override(session.settings, 2);
				await flushMicrotasks();
				vi.advanceTimersByTime(2_000);
				await flushMicrotasks();
				expect(requests).toHaveLength(0);
				blocked = false;
				cfgRecapIdleSeconds.override(session.settings, 1);
				await flushMicrotasks();
				vi.advanceTimersByTime(1_000);
				await flushMicrotasks();
				expect(requests).toHaveLength(1);
				blocked = true;
				await finishRecap(0, "No longer idle");
				expect(displayed).toEqual([]);
				expect(session.getSessionRecap().recap).toBeNull();
			} finally {
				Reflect.deleteProperty(session, guard);
			}
		},
	);

	it.each(["pending-timer", "in-flight-reply"] as const)(
		"detaches the host and settings listener during %s",
		async phase => {
			const displayed: string[] = [];
			const disable = session.enableIdleRecaps({ onRecap: text => displayed.push(text) });
			await session.prompt("Complete work");
			if (phase === "in-flight-reply") {
				vi.advanceTimersByTime(1_000);
				await flushMicrotasks();
				expect(requests[0].signal?.aborted).toBe(false);
			}
			disable();
			cfgRecapIdleSeconds.override(session.settings, 2);
			await flushMicrotasks();
			vi.advanceTimersByTime(2_000);
			await flushMicrotasks();
			if (phase === "in-flight-reply") {
				expect(requests[0].signal?.aborted).toBe(true);
				await finishRecap(0, "Detached reply");
			} else {
				expect(requests).toHaveLength(0);
			}
			expect(displayed).toEqual([]);
			expect(session.getSessionRecap()).toMatchObject({ enabled: false, recap: null });
		},
	);

	it.each(["new", "fork", "same-id-switch", "failed-switch", "dispose"] as const)(
		"rejects provider output arriving after %s even when abort is ignored",
		async transition => {
			await beginRecap();
			const originalId = session.sessionManager.getSessionId();
			const originalFile = session.sessionManager.getSessionFile()!;
			const observed: string[] = [];
			session.subscribeSessionTransition(phase => observed.push(phase));
			switch (transition) {
				case "new":
					await session.newSession();
					break;
				case "fork":
					await session.fork();
					break;
				case "same-id-switch":
					await session.switchSession(originalFile);
					break;
				case "failed-switch":
					session.setSessionBeforeSwitchReconciler(async () => {
						throw new Error("adoption rejected");
					});
					await expect(session.switchSession(originalFile)).rejects.toThrow("adoption rejected");
					break;
				case "dispose":
					session.beginDispose();
					break;
			}
			expect(requests[0].signal?.aborted).toBe(true);
			await finishRecap();
			expect(lookupLatestSessionRecap(originalId)).toBeUndefined();
			expect(lookupLatestSessionRecap(session.sessionManager.getSessionId())).toBeUndefined();
			if (transition !== "dispose") expect(observed).toEqual(["begin", "end"]);
		},
	);

	it("invalidates maintenance even when it leaves the same journal leaf in place", async () => {
		await beginRecap();
		const leaf = session.sessionManager.getLeafId();
		await session.dropImages();
		expect(session.sessionManager.getLeafId()).toBe(leaf);
		expect(requests[0].signal?.aborted).toBe(true);
		await finishRecap();
		expect(session.getSessionRecap().recap).toBeNull();
	});

	it("rejects a late reply after a same-provider/model replacement", async () => {
		await beginRecap();
		const currentModel = session.model!;
		// Routing metadata can change while provider/id remain equal. The final
		// ownership guard must compare the captured model object, not just its ID.
		session.agent.setModel({ ...currentModel });
		await finishRecap();
		expect(session.getSessionRecap().recap).toBeNull();
	});

	it("does not overlap a new terminal recap with an ignored-abort provider", async () => {
		await beginRecap();
		await session.prompt("Another completed turn");
		expect(requests[0].signal?.aborted).toBe(true);
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
		await finishRecap(0, "Obsolete reply");
		expect(session.getSessionRecap().recap).toBeNull();
		expect(requests).toHaveLength(2);
		await finishRecap(1, "Current reply");
		expect(session.getSessionRecap().recap).toMatchObject({ text: "Current reply", stale: false });
	});

	it.each(["pending-timer", "in-flight-reply"] as const)(
		"supersedes %s as soon as a new prompt is admitted for preprocessing",
		async phase => {
			const displayed: string[] = [];
			session.enableIdleRecaps({ onRecap: text => displayed.push(text) });
			await session.prompt("Complete the previous turn");
			if (phase === "in-flight-reply") {
				vi.advanceTimersByTime(1_000);
				await flushMicrotasks();
				expect(requests).toHaveLength(1);
			}
			const sourceLeaf = session.sessionManager.getLeafId();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const normalize = vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
				entered.resolve();
				await release.promise;
				return images;
			});
			const submitted = session.prompt("New work waiting on image preprocessing");
			try {
				await entered.promise;
				expect(session.hasAdmittedSubmission).toBe(true);
				expect(session.isStreaming).toBe(false);
				expect(session.sessionManager.getLeafId()).toBe(sourceLeaf);
				vi.advanceTimersByTime(1_000);
				await flushMicrotasks();
				if (phase === "pending-timer") {
					expect(requests).toHaveLength(0);
				} else {
					expect(requests[0].signal?.aborted).toBe(true);
					await finishRecap(0, "Obsolete recap from before submission");
				}
				expect(session.getSessionRecap().recap).toBeNull();
				expect(displayed).toEqual([]);
			} finally {
				release.resolve();
				await submitted;
				normalize.mockRestore();
			}
			// The newly submitted turn's terminal event still arms exactly once,
			// even though it is delivered before its admission finally unwinds.
			vi.advanceTimersByTime(1_000);
			await flushMicrotasks();
			const latestRequest = phase === "pending-timer" ? 0 : 1;
			expect(requests).toHaveLength(latestRequest + 1);
			await finishRecap(latestRequest, "Recap of the newly completed work");
			expect(session.getSessionRecap().recap).toMatchObject({
				text: "Recap of the newly completed work",
				stale: false,
			});
			expect(displayed).toEqual(["Recap of the newly completed work"]);
		},
	);

	it("honors the TUI draft gate before inference and before publishing a late reply", async () => {
		let draft = "pending draft";
		const displayed: string[] = [];
		session.enableIdleRecaps({ canGenerate: () => !draft, onRecap: text => displayed.push(text) });
		await session.prompt("Complete work");
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(0);
		draft = "";
		await session.prompt("Complete more work");
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		draft = "new input";
		await finishRecap();
		expect(displayed).toEqual([]);
		expect(session.getSessionRecap().recap).toBeNull();
		draft = "";
		await session.prompt("Finish final work");
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		await finishRecap(1, "Current status");
		expect(displayed).toEqual(["Current status"]);
	});

	it("does not inherit a parent's recap on fork and reloads the persisted row on resume", async () => {
		await beginRecap();
		await finishRecap();
		const parentId = session.sessionManager.getSessionId();
		const parentFile = session.sessionManager.getSessionFile()!;
		const parentRecap = session.getSessionRecap().recap!;
		await session.fork();
		expect(session.getSessionRecap().recap).toBeNull();
		expect(() => readRpcSessionRecap(session, parentId)).toThrow("Session ID does not match");
		await session.switchSession(parentFile);
		expect(session.getSessionRecap().recap?.id).toBe(parentRecap.id);
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(requests).toHaveLength(1);
	});
});
