import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createFuraRpcRuntime } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
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
