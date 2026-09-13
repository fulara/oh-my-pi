import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createFuraRpcRuntime, RpcInputDispatcher } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcBtwUpdateFrame, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cleanupRoots: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession(
	toolNames: string[],
	model: MockModel = createMockModel({ responses: [{ content: ["ok"] }] }),
): Promise<AgentSession> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-active-tools-"));
	cleanupRoots.push(root);

	const settings = Settings.isolated({
		"compaction.enabled": false,
	});
	const sessionManager = await SessionManager.continueRecent(root, path.join(root, "sessions"));
	const toolRegistry = new Map<string, AgentTool>();
	const sessionRef: { current?: AgentSession } = {};
	const toolSession: ToolSession = {
		cwd: root,
		hasUI: false,
		skipPythonPreflight: true,
		enableLsp: false,
		settings,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getSessionId: () => sessionManager.getSessionId(),
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getPlanModeState: () => sessionRef.current?.getPlanModeState(),
		getGoalModeState: () => sessionRef.current?.getGoalModeState(),
		getToolByName: name => toolRegistry.get(name),
	} as ToolSession;
	const tools = await createTools(toolSession, toolNames);
	for (const tool of tools) toolRegistry.set(tool.name, tool);

	const initialMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "Original conversation" }],
		timestamp: Date.now(),
	};
	sessionManager.appendMessage(initialMessage);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: model.model,
			systemPrompt: ["Test"],
			messages: [initialMessage],
		},
		convertToLlm,
		streamFn: model.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: { resolver: () => async () => "test-key" } as never,
		toolRegistry,
		sideStreamFn: model.stream,
	});
	sessionRef.current = session;
	return session;
}

describe("Fura RPC active-tool runtime", () => {
	it("returns the actual active tool set after upstream filtering", async () => {
		const session = await createSession(["read", "bash", "resolve"]);
		await session.setActiveToolsByName(["read", "bash"]);

		const runtime = createFuraRpcRuntime(session);
		const response = await runtime.handleCommand({
			id: "active-tools-1",
			type: "set_active_tools",
			toolNames: ["read", "not_registered"],
		});

		expect(response).toEqual({
			id: "active-tools-1",
			type: "response",
			command: "set_active_tools",
			success: true,
			data: { toolNames: ["read"] },
		});
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.agent.state.tools.map(tool => tool.name)).toEqual(["read"]);
	});

	it("fork delegates to the upstream session fork API", async () => {
		const session = await createSession(["read"]);
		const previousSessionFile = session.sessionFile;
		expect(previousSessionFile).toBeTruthy();

		const runtime = createFuraRpcRuntime(session);
		const response = await runtime.handleCommand({ id: "fork-1", type: "fork" });

		expect(response).toEqual({
			id: "fork-1",
			type: "response",
			command: "fork",
			success: true,
			data: { cancelled: false },
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.sessionFile).not.toBe(previousSessionFile);
	});

	it("streams a BTW snapshot without mutating the source and promotes it to a new session", async () => {
		const model = createMockModel({ responses: [{ content: ["Side answer"] }] });
		const session = await createSession(["read"], model);
		const sourceSessionFile = session.sessionFile;
		const sourceEntries = session.sessionManager.getEntries();
		const completed = Promise.withResolvers<void>();
		const frames: Array<RpcBtwUpdateFrame | RpcResponse> = [];
		const runtime = createFuraRpcRuntime(session, frame => {
			const typedFrame = frame as RpcBtwUpdateFrame | RpcResponse;
			frames.push(typedFrame);
			if (typedFrame.type === "btw_update" && typedFrame.state === "completed") completed.resolve();
		});

		const start = await runtime.handleCommand({
			id: "btw-start-1",
			type: "btw_start",
			btwId: "btw-1",
			question: "Why this change?",
		});
		expect(start).toEqual({
			id: "btw-start-1",
			type: "response",
			command: "btw_start",
			success: true,
			data: { btwId: "btw-1" },
		});
		await completed.promise;

		const updates = frames.filter((frame): frame is RpcBtwUpdateFrame => frame.type === "btw_update");
		expect(updates.map(update => update.state)).toEqual(["started", "streaming", "completed"]);
		expect(updates.at(-1)).toEqual({
			type: "btw_update",
			btwId: "btw-1",
			state: "completed",
			answer: "Side answer",
			canPromote: true,
		});
		expect(session.sessionManager.getEntries()).toEqual(sourceEntries);
		expect(session.sessionFile).toBe(sourceSessionFile);

		const promote = await runtime.handleCommand({
			id: "btw-promote-1",
			type: "btw_promote",
			btwId: "btw-1",
		});
		expect(promote).toMatchObject({
			id: "btw-promote-1",
			type: "response",
			command: "btw_promote",
			success: true,
			data: { btwId: "btw-1" },
		});
		if (!promote?.success || promote.command !== "btw_promote") {
			throw new Error("Expected successful BTW promotion");
		}
		expect(promote.data.sessionFile).not.toBe(sourceSessionFile);
		expect(session.sessionFile).toBe(sourceSessionFile);
		const promotedLines = (await fs.readFile(promote.data.sessionFile, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const promotedMessages = promotedLines
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as { role: string; content: unknown });
		expect(promotedMessages.map(message => message.role)).toEqual(["user", "user", "assistant"]);
		expect(JSON.stringify(promotedMessages.at(-2)?.content)).toContain("Why this change?");
		expect(JSON.stringify(promotedMessages.at(-1)?.content)).toContain("Side answer");
	});

	it("cancels a running BTW request without touching the source transcript", async () => {
		const model = createMockModel({
			handler: (_context, options) => {
				const pending = Promise.withResolvers<never>();
				options?.signal?.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
				return pending.promise;
			},
		});
		const session = await createSession(["read"], model);
		const sourceEntries = session.sessionManager.getEntries();
		const started = Promise.withResolvers<void>();
		const frames: Array<RpcBtwUpdateFrame | RpcResponse> = [];
		const runtime = createFuraRpcRuntime(session, frame => {
			const typedFrame = frame as RpcBtwUpdateFrame | RpcResponse;
			frames.push(typedFrame);
			if (typedFrame.type === "btw_update" && typedFrame.state === "started") started.resolve();
		});

		await runtime.handleCommand({
			id: "btw-start-cancel",
			type: "btw_start",
			btwId: "btw-cancel",
			question: "Cancel me",
		});
		await started.promise;
		const cancel = await runtime.handleCommand({
			id: "btw-cancel-1",
			type: "btw_cancel",
			btwId: "btw-cancel",
		});

		expect(cancel).toEqual({
			id: "btw-cancel-1",
			type: "response",
			command: "btw_cancel",
			success: true,
			data: { btwId: "btw-cancel" },
		});
		expect(frames).toContainEqual({
			type: "btw_update",
			btwId: "btw-cancel",
			state: "cancelled",
		});
		expect(session.sessionManager.getEntries()).toEqual(sourceEntries);
		await runtime.handleCommand({ id: "btw-release-1", type: "btw_release", btwId: "btw-cancel" });
	});

	it("rejects BTW promotion after the source conversation advances", async () => {
		const session = await createSession(["read"], createMockModel({ responses: [{ content: ["Snapshot answer"] }] }));
		const completed = Promise.withResolvers<void>();
		const frames: Array<RpcBtwUpdateFrame | RpcResponse> = [];
		const runtime = createFuraRpcRuntime(session, frame => {
			const typedFrame = frame as RpcBtwUpdateFrame | RpcResponse;
			frames.push(typedFrame);
			if (typedFrame.type === "btw_update" && typedFrame.state === "completed") completed.resolve();
		});

		await runtime.handleCommand({
			id: "btw-start-stale",
			type: "btw_start",
			btwId: "btw-stale",
			question: "Can this be promoted?",
		});
		await completed.promise;
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Advance the source" }],
			timestamp: Date.now(),
		});

		const promote = await runtime.handleCommand({
			id: "btw-promote-stale",
			type: "btw_promote",
			btwId: "btw-stale",
		});
		expect(promote).toEqual({
			id: "btw-promote-stale",
			type: "response",
			command: "btw_promote",
			success: false,
			error: "The source conversation advanced after this BTW request started.",
			code: "btw_source_advanced",
		});
		await runtime.handleCommand({ id: "btw-release-stale", type: "btw_release", btwId: "btw-stale" });
	});
});

const flushBtw = () => {
	const flushed = Promise.withResolvers<void>();
	setImmediate(flushed.resolve);
	return flushed.promise;
};

function btwAnswer(text: string): { replyText: string; assistantMessage: AssistantMessage } {
	return {
		replyText: text,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "mock",
			provider: "mock",
			model: "mock",
			stopReason: "stop",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

async function createBtwLifecycleHarness() {
	const session = await createSession([]);
	const frames: object[] = [];
	const cancelled = Promise.withResolvers<void>();
	const runtime = createFuraRpcRuntime(
		session,
		frame => {
			frames.push(frame);
			const update = frame as RpcBtwUpdateFrame;
			if (update.type === "btw_update" && update.state === "cancelled") cancelled.resolve();
		},
		undefined,
		() => dispatcher.cancelPendingBtw(),
	);
	const maintenance = Promise.withResolvers<void>();
	const compactStarted = Promise.withResolvers<void>();
	const dispatcher = new RpcInputDispatcher({
		deps: {
			handleCommand: async command => {
				if (command.type === "compact") {
					compactStarted.resolve();
					await maintenance.promise;
					return { id: command.id, type: "response", command: "compact", success: false, error: "fixture" };
				}
				const response = await runtime.handleCommand(command);
				if (!response) throw new Error(`Unexpected command: ${command.type}`);
				return response;
			},
			output: frame => frames.push(frame),
			errorResponse: (id, command, error) => ({ id, type: "response", command, success: false, error }),
			pendingExtensionRequests: new Map(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
		},
	});
	const turn = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
	let signal: AbortSignal | undefined;
	let delta: ((text: string) => void) | undefined;
	const run = spyOn(session, "runEphemeralTurn").mockImplementation(args => {
		signal = args.signal;
		delta = args.onTextDelta;
		return turn.promise;
	});
	const sourceAbort = spyOn(session, "abort");
	const start = (btwId = "owned") =>
		dispatcher.dispatch({ id: `start-${btwId}`, type: "btw_start", btwId, question: `Question ${btwId}` });
	return {
		session,
		frames,
		runtime,
		dispatcher,
		maintenance,
		compactStarted,
		cancelled,
		turn,
		run,
		sourceAbort,
		start,
		get signal() {
			return signal;
		},
		lateDelta: () => delta?.("Late output"),
	};
}

describe("Fura RPC BTW lifecycle", () => {
	for (const control of ["btw_cancel", "btw_release"] as const) {
		it(`${control} prevents a queued BTW behind compact from ever dispatching`, async () => {
			const h = await createBtwLifecycleHarness();
			h.dispatcher.dispatch({ type: "compact" });
			await h.compactStarted.promise;
			h.start();
			h.dispatcher.dispatch({ id: "close", type: control, btwId: "owned" });
			await flushBtw();
			const framesBeforeUnblock = [...h.frames];
			h.maintenance.resolve();
			await h.dispatcher.drain();
			await flushBtw();
			expect(framesBeforeUnblock).toContainEqual({
				id: "close",
				type: "response",
				command: control,
				success: true,
				data: { btwId: "owned" },
			});
			expect(h.run).not.toHaveBeenCalled();
			expect(h.frames).toContainEqual(
				expect.objectContaining({
					id: "start-owned",
					command: "btw_start",
					success: false,
				}),
			);
			expect(h.sourceAbort).not.toHaveBeenCalled();
		});

		it(`${control} overtakes compact but keeps a cancelled transport occupied until it drains`, async () => {
			const h = await createBtwLifecycleHarness();
			const sourceEntries = h.session.sessionManager.getEntries();
			h.start();
			await h.dispatcher.drain();
			h.dispatcher.dispatch({ type: "compact" });
			await h.compactStarted.promise;
			h.dispatcher.dispatch({ id: "close", type: control, btwId: "owned" });
			await flushBtw();
			const abortedBeforeUnblock = h.signal?.aborted;
			h.maintenance.resolve();
			await h.dispatcher.drain();
			const overlap = await h.runtime.handleCommand({
				type: "btw_start",
				btwId: "overlap",
				question: "Must wait for drain",
			});
			h.lateDelta();
			h.turn.resolve(btwAnswer("Late answer"));
			await flushBtw();
			expect(abortedBeforeUnblock).toBe(true);
			expect(overlap).toMatchObject({ command: "btw_start", success: false, code: "btw_active" });
			expect(h.frames).not.toContainEqual(expect.objectContaining({ state: "streaming", delta: "Late output" }));
			expect(h.frames).not.toContainEqual(expect.objectContaining({ state: "completed" }));
			expect(h.sourceAbort).not.toHaveBeenCalled();
			expect(h.session.sessionManager.getEntries()).toEqual(sourceEntries);
			expect(
				await h.runtime.handleCommand({
					type: "btw_start",
					btwId: "next",
					question: "After drain",
				}),
			).toMatchObject({ success: true });
			await flushBtw();
		});
	}

	it("unknown BTW controls cannot poison a later request with the same ID", async () => {
		const h = await createBtwLifecycleHarness();
		h.dispatcher.dispatch({ type: "btw_cancel", btwId: "owned" });
		h.dispatcher.dispatch({ type: "btw_release", btwId: "owned" });
		await h.dispatcher.drain();
		h.start();
		await h.dispatcher.drain();
		expect(h.run).toHaveBeenCalledTimes(1);
		h.turn.resolve(btwAnswer("Independent answer"));
		await flushBtw();
	});

	it("RPC shutdown discards queued BTW before draining ordinary commands", async () => {
		const h = await createBtwLifecycleHarness();
		h.dispatcher.dispatch({ type: "compact" });
		await h.compactStarted.promise;
		h.start();
		h.dispatcher.closeBtw();
		await h.runtime.dispose();
		h.maintenance.resolve();
		await h.dispatcher.drain();
		expect(h.run).not.toHaveBeenCalled();
		expect(h.frames).toContainEqual(expect.objectContaining({ command: "compact" }));
		expect(h.sourceAbort).not.toHaveBeenCalled();
	});

	for (const boundary of ["shutdown", "session transition"] as const) {
		it(`${boundary} aborts and drains owned BTW and suppresses late output without source abort`, async () => {
			const h = await createBtwLifecycleHarness();
			h.start();
			await h.dispatcher.drain();
			let settled = false;
			const cleanup = boundary === "shutdown" ? h.runtime.dispose() : h.runtime.reconcileSessionMode();
			void cleanup.then(() => {
				settled = true;
			});
			await flushBtw();
			const abortedBeforeDrain = h.signal?.aborted;
			const settledBeforeDrain = settled;
			h.lateDelta();
			h.turn.resolve(btwAnswer("Late answer"));
			await cleanup;
			expect(abortedBeforeDrain).toBe(true);
			expect(settledBeforeDrain).toBe(false);
			expect(h.frames).not.toContainEqual(expect.objectContaining({ state: "completed" }));
			expect(h.frames).not.toContainEqual(expect.objectContaining({ state: "streaming", delta: "Late output" }));
			expect(h.sourceAbort).not.toHaveBeenCalled();
			if (boundary === "shutdown") {
				expect(
					await h.runtime.handleCommand({
						type: "btw_start",
						btwId: "after-close",
						question: "Too late",
					}),
				).toMatchObject({ success: false });
			}
		});
	}

	it("pins main context at BTW start and excludes previous side Q/A from the next independent BTW", async () => {
		const model = createMockModel({
			responses: [{ content: ["First side answer"] }, { content: ["Second side answer"] }],
		});
		const session = await createSession([], model);
		const firstDone = Promise.withResolvers<void>();
		const secondDone = Promise.withResolvers<void>();
		const runtime = createFuraRpcRuntime(session, frame => {
			const update = frame as RpcBtwUpdateFrame;
			if (update.type === "btw_update" && update.state === "completed") {
				(update.btwId === "first" ? firstDone : secondDone).resolve();
			}
		});
		const start = runtime.handleCommand({ type: "btw_start", btwId: "first", question: "First side question" });
		session.sessionManager.appendMessage({ role: "user", content: "Main advanced", timestamp: 2 });
		await start;
		await firstDone.promise;
		expect(JSON.stringify(model.calls[0]?.context.messages)).toContain("Original conversation");
		expect(JSON.stringify(model.calls[0]?.context.messages)).not.toContain("Main advanced");
		await runtime.handleCommand({ type: "btw_release", btwId: "first" });
		expect(
			await runtime.handleCommand({
				type: "btw_start",
				btwId: "second",
				question: "Second independent question",
			}),
		).toMatchObject({ success: true });
		await secondDone.promise;
		const secondContext = JSON.stringify(model.calls[1]?.context.messages);
		expect(secondContext).toContain("Main advanced");
		expect(secondContext).not.toContain("First side question");
		expect(secondContext).not.toContain("First side answer");
		expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("First side question");
		expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("Second side answer");
		await runtime.handleCommand({ type: "btw_release", btwId: "second" });
	});
});

async function prepareBtwTransition(session: AgentSession, kind: "new" | "resume" | "fork" | "branch") {
	switch (kind) {
		case "new":
			return () => session.newSession();
		case "fork":
			return () => session.fork();
		case "branch": {
			const entryId = session.sessionManager.getLeafId()!;
			return () => session.branch(entryId);
		}
		case "resume": {
			const destination = SessionManager.create(session.sessionManager.getCwd(), path.dirname(session.sessionFile!));
			destination.appendMessage({ role: "user", content: "Destination conversation", timestamp: 3 });
			await destination.ensureOnDisk();
			return () => session.switchSession(destination.getSessionFile()!, { preserveLocalCwd: true });
		}
	}
}

describe("Fura RPC BTW real session transitions", () => {
	for (const kind of ["new", "resume", "fork", "branch"] as const) {
		it(`${kind} aborts and drains BTW before changing source identity or context`, async () => {
			const h = await createBtwLifecycleHarness();
			// Mirror the live mode-restoration callback; invoke the real session API, not this callback.
			h.session.setSessionSwitchReconciler(() => h.runtime.reconcileSessionMode());
			const change = await prepareBtwTransition(h.session, kind);
			const sourceFile = h.session.sessionFile;
			const sourceId = h.session.sessionId;
			const messages = structuredClone(h.session.agent.state.messages);
			h.start();
			await h.dispatcher.drain();
			const changing = change();
			await h.cancelled.promise;
			const fileAtCancellation = h.session.sessionFile;
			const idAtCancellation = h.session.sessionId;
			const messagesAtCancellation = structuredClone(h.session.agent.state.messages);
			const sourceAbortAtCancellation = h.sourceAbort.mock.calls.length;
			h.lateDelta();
			h.turn.resolve(btwAnswer("Late source answer"));
			await changing;
			expect(fileAtCancellation).toBe(sourceFile);
			expect(idAtCancellation).toBe(sourceId);
			expect(messagesAtCancellation).toEqual(messages);
			expect(sourceAbortAtCancellation).toBe(0);
			expect(h.signal?.aborted).toBe(true);
			expect(h.session.sessionId).not.toBe(sourceId);
			expect(h.frames).not.toContainEqual(expect.objectContaining({ state: "completed" }));
			expect(h.frames).not.toContainEqual(expect.objectContaining({ state: "streaming", delta: "Late output" }));
		});

		it(`${kind} rejects a BTW drain timeout without changing source identity or context`, async () => {
			const h = await createBtwLifecycleHarness();
			h.session.setSessionSwitchReconciler(() => h.runtime.reconcileSessionMode());
			const change = await prepareBtwTransition(h.session, kind);
			const sourceFile = h.session.sessionFile;
			const sourceId = h.session.sessionId;
			const messages = structuredClone(h.session.agent.state.messages);
			const model = h.session.model;
			const systemPrompt = h.session.systemPrompt;
			const tools = h.session.getActiveToolNames();
			h.start();
			await h.dispatcher.drain();
			vi.useFakeTimers();
			try {
				const changing = change().then(
					() => ({ rejected: false, error: undefined }),
					error => ({ rejected: true, error }),
				);
				await h.cancelled.promise;
				vi.advanceTimersByTime(3_000);
				const outcome = await changing;
				expect(outcome.rejected).toBe(true);
				expect(outcome.error).toBeInstanceOf(Error);
				expect(h.session.sessionFile).toBe(sourceFile);
				expect(h.session.sessionId).toBe(sourceId);
				expect(h.session.agent.state.messages).toEqual(messages);
				expect(h.session.model).toBe(model);
				expect(h.session.systemPrompt).toEqual(systemPrompt);
				expect(h.session.getActiveToolNames()).toEqual(tools);
				expect(h.sourceAbort).not.toHaveBeenCalled();
			} finally {
				h.turn.resolve(btwAnswer("Drained after rejected transition"));
				vi.useRealTimers();
				await flushBtw();
			}
			expect(
				await h.runtime.handleCommand({
					type: "btw_start",
					btwId: "after-timeout",
					question: "Still usable after drain",
				}),
			).toMatchObject({ success: true });
			await flushBtw();
		});
	}

	it("extension-driven fork invalidates BTW starts queued behind compact", async () => {
		const h = await createBtwLifecycleHarness();
		h.session.setSessionSwitchReconciler(() => h.runtime.reconcileSessionMode());
		h.dispatcher.dispatch({ type: "compact" });
		await h.compactStarted.promise;
		h.start();
		await h.session.fork();
		h.maintenance.resolve();
		await h.dispatcher.drain();
		h.turn.resolve(btwAnswer("Must never start in the destination"));
		await flushBtw();
		expect(h.run).not.toHaveBeenCalled();
		expect(h.frames).toContainEqual(expect.objectContaining({ id: "start-owned", success: false }));
	});
});

describe("Fura RPC BTW transition admission", () => {
	for (const outcome of ["success", "failure"] as const) {
		it(`blocks direct and queued BTW through held fork and reopens after ${outcome}`, async () => {
			const h = await createBtwLifecycleHarness();
			h.session.setSessionSwitchReconciler(() => h.runtime.reconcileSessionMode());
			const mutationEntered = Promise.withResolvers<void>();
			const releaseMutation = Promise.withResolvers<void>();
			const originalFork = h.session.sessionManager.fork.bind(h.session.sessionManager);
			spyOn(h.session.sessionManager, "fork").mockImplementation(async () => {
				mutationEntered.resolve();
				await releaseMutation.promise;
				if (outcome === "failure") throw new Error("Fork write failed");
				return originalFork();
			});
			h.dispatcher.dispatch({ type: "compact" });
			await h.compactStarted.promise;
			const changing = h.session.fork().then(
				() => ({ rejected: false }),
				() => ({ rejected: true }),
			);
			await mutationEntered.promise;
			const during = await h.runtime.handleCommand({
				type: "btw_start",
				btwId: "during",
				question: "Must not enter partially switched context",
			});
			h.start("queued-during");
			// Ensure RED also drains any incorrectly accepted turn instead of hanging in post-reconciliation.
			h.turn.resolve(btwAnswer("Should only run after transition"));
			await flushBtw();
			releaseMutation.resolve();
			expect((await changing).rejected).toBe(outcome === "failure");
			h.maintenance.resolve();
			await h.dispatcher.drain();
			const after = await h.runtime.handleCommand({
				type: "btw_start",
				btwId: "after",
				question: "Usable once transition settles",
			});
			await flushBtw();
			expect(during).toMatchObject({ success: false });
			expect(h.frames).toContainEqual(expect.objectContaining({ id: "start-queued-during", success: false }));
			expect(after).toMatchObject({ success: true });
		});
	}
});
