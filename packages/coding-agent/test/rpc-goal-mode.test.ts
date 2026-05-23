import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createFuraRpcRuntime } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cleanupRoots: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession(): Promise<AgentSession> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-goal-mode-"));
	cleanupRoots.push(root);

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"recipe.enabled": false,
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
		getGoalRuntime: () => session?.goalRuntime,
		getToolByName: name => toolRegistry.get(name),
	} as ToolSession;
	const tools = await createTools(toolSession, ["read"]);
	const goalTool = await HIDDEN_TOOLS.goal(toolSession);
	for (const tool of [...tools, goalTool].filter((tool): tool is AgentTool => tool !== null)) toolRegistry.set(tool.name, tool);

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

function goalEvents(events: AgentSessionEvent[]): Extract<AgentSessionEvent, { type: "goal_updated" }>[] {
	return events.filter((event): event is Extract<AgentSessionEvent, { type: "goal_updated" }> => {
		return event.type === "goal_updated";
	});
}

describe("Fura RPC goal-mode runtime", () => {
	it("creates, budgets, pauses, resumes, and drops a goal", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		const events: AgentSessionEvent[] = [];
		const unsubscribe = session.subscribe(event => events.push(event));
		const runtime = createFuraRpcRuntime(session);

		try {
			const created = await runtime.handleCommand({
				id: "goal-create",
				type: "goal_mode",
				op: "create",
				objective: "Ship the RPC goal handler",
				tokenBudget: 100,
			});
			expect(created).toMatchObject({
				id: "goal-create",
				type: "response",
				command: "goal_mode",
				success: true,
				data: {
					goalMode: {
						enabled: true,
						mode: "active",
						goal: { objective: "Ship the RPC goal handler", status: "active", tokenBudget: 100 },
					},
				},
			});
			expect(session.getActiveToolNames()).toEqual(["read", "goal"]);
			expect(goalEvents(events).at(-1)?.goal?.status).toBe("active");

			const budgeted = await runtime.handleCommand({
				id: "goal-budget",
				type: "goal_mode",
				op: "set_budget",
				tokenBudget: 25,
			});
			expect(budgeted).toMatchObject({
				id: "goal-budget",
				type: "response",
				command: "goal_mode",
				success: true,
				data: { goalMode: { goal: { tokenBudget: 25 } } },
			});

			const paused = await runtime.handleCommand({ id: "goal-pause", type: "goal_mode", op: "pause" });
			expect(paused).toMatchObject({
				id: "goal-pause",
				type: "response",
				command: "goal_mode",
				success: true,
				data: { goalMode: { enabled: false, goal: { status: "paused" } } },
			});
			expect(session.getActiveToolNames()).toEqual(["read"]);

			const resumed = await runtime.handleCommand({ id: "goal-resume", type: "goal_mode", op: "resume" });
			expect(resumed).toMatchObject({
				id: "goal-resume",
				type: "response",
				command: "goal_mode",
				success: true,
				data: { goalMode: { enabled: true, goal: { status: "active" } } },
			});
			expect(session.getActiveToolNames()).toEqual(["read", "goal"]);

			const dropped = await runtime.handleCommand({ id: "goal-drop", type: "goal_mode", op: "drop" });
			expect(dropped).toEqual({
				id: "goal-drop",
				type: "response",
				command: "goal_mode",
				success: true,
				data: { goalMode: null },
			});
			expect(session.getGoalModeState()).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
			expect(goalEvents(events).at(-1)).toMatchObject({
				goal: { status: "dropped" },
				state: { enabled: false, goal: { status: "dropped" } },
			});
		} finally {
			unsubscribe();
		}
	});

	it("rejects goal operations that require active mode", async () => {
		const session = await createSession();
		const runtime = createFuraRpcRuntime(session);

		const response = await runtime.handleCommand({
			id: "goal-budget-missing",
			type: "goal_mode",
			op: "set_budget",
			tokenBudget: 10,
		});

		expect(response).toEqual({
			id: "goal-budget-missing",
			type: "response",
			command: "goal_mode",
			success: false,
			error: "No active goal.",
		});
	});

	it("rejects goal creation while plan mode is active", async () => {
		const session = await createSession();
		const runtime = createFuraRpcRuntime(session);
		await runtime.handleCommand({ id: "plan-on", type: "set_plan_mode", enabled: true });

		const response = await runtime.handleCommand({
			id: "goal-during-plan",
			type: "goal_mode",
			op: "create",
			objective: "Should be rejected",
		});

		expect(response).toEqual({
			id: "goal-during-plan",
			type: "response",
			command: "goal_mode",
			success: false,
			error: "Exit plan mode first.",
		});
	});
});
