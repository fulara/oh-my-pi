import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createFuraRpcRuntime } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cleanupRoots: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession(toolNames: string[]): Promise<AgentSession> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-active-tools-"));
	cleanupRoots.push(root);

	const settings = Settings.isolated({
		"compaction.enabled": false,
	});
	const sessionManager = await SessionManager.continueRecent(root, path.join(root, "sessions"));
	const toolRegistry = new Map<string, AgentTool>();
	let session: AgentSession | undefined;
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
		getPlanModeState: () => session?.getPlanModeState(),
		getGoalModeState: () => session?.getGoalModeState(),
		getToolByName: name => toolRegistry.get(name),
	} as ToolSession;
	const tools = await createTools(toolSession, toolNames);
	for (const tool of tools) toolRegistry.set(tool.name, tool);

	const model = createMockModel({ responses: [{ content: ["ok"] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: model.model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: model.stream,
	});
	session = new AgentSession({ agent, sessionManager, settings, modelRegistry: {} as never, toolRegistry });
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
});
