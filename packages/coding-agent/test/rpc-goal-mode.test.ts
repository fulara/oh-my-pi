import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createFuraRpcRuntime } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";

const cleanupRoots: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession(
	options: { root?: string; sessionFile?: string; extraTools?: AgentTool[] } = {},
): Promise<AgentSession> {
	const root = options.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-goal-mode-")));
	if (!options.root) cleanupRoots.push(root);

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
	});
	const sessionManager = options.sessionFile
		? await SessionManager.open(options.sessionFile, path.join(root, "sessions"))
		: await SessionManager.continueRecent(root, path.join(root, "sessions"));
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
		getGoalRuntime: () => sessionRef.current?.goalRuntime,
		getToolByName: name => toolRegistry.get(name),
	} as ToolSession;
	const tools = await createTools(toolSession, ["read", "write"]);
	const goalTool = await HIDDEN_TOOLS.goal(toolSession);
	const extraTools = options.extraTools ?? [];
	for (const tool of [...tools, goalTool, ...extraTools].filter((tool): tool is AgentTool => tool !== null))
		toolRegistry.set(tool.name, tool);

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
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: {} as never,
		toolRegistry,
		builtInToolNames: ["read", "write"],
		...(extraTools.length > 0
			? {
					xdev: {
						tools: toolRegistry,
						mountedNames: new Set(extraTools.map(tool => tool.name)),
						builtInNames: new Set(["read", "write"]),
						isActive: name => agent.state.tools.some(tool => tool.name === name),
					} satisfies XdevState,
				}
			: {}),
	});
	sessionRef.current = session;
	return session;
}

function goalEvents(events: AgentSessionEvent[]): Extract<AgentSessionEvent, { type: "goal_updated" }>[] {
	return events.filter((event): event is Extract<AgentSessionEvent, { type: "goal_updated" }> => {
		return event.type === "goal_updated";
	});
}

function makeDiscoverableTool(name: string): AgentTool {
	const tool: AgentTool & { loadMode?: "discoverable" } = {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		loadMode: "discoverable",
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
	return tool;
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

	it("preserves mounted discoverable tools across goal activation and pause", async () => {
		const session = await createSession({ extraTools: [makeDiscoverableTool("report_issue")] });
		await session.setActiveToolPresentation(["read", "write", "report_issue"], ["report_issue"]);
		const runtime = createFuraRpcRuntime(session);

		await runtime.handleCommand({
			id: "goal-create-mounted",
			type: "goal_mode",
			op: "create",
			objective: "Keep mounted tools",
		});
		expect(session.getActiveToolNames()).toEqual(["read", "write", "goal"]);
		expect(session.getMountedXdevToolNames()).toEqual(["report_issue"]);

		await runtime.handleCommand({ id: "goal-pause-mounted", type: "goal_mode", op: "pause" });
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(session.getMountedXdevToolNames()).toEqual(["report_issue"]);
	});

	it("restores tools and clears goal state after tool-driven completion", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		const runtime = createFuraRpcRuntime(session);
		await runtime.handleCommand({
			id: "goal-create-complete",
			type: "goal_mode",
			op: "create",
			objective: "Finish cleanly",
		});

		await session.goalRuntime.completeGoalFromTool();
		expect(session.getGoalModeState()).toMatchObject({
			enabled: false,
			mode: "exiting",
			reason: "completed",
		});

		await runtime.handleSessionEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.sessionManager.buildSessionContext().mode).toBe("none");
		expect(
			session.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === "goal-completed"),
		).toBe(true);
	});

	it("rehydrates persisted active goal state when an RPC session resumes", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		const originalRuntime = createFuraRpcRuntime(session);
		await originalRuntime.handleCommand({
			id: "goal-create-resume",
			type: "goal_mode",
			op: "create",
			objective: "Survive process restart",
		});
		const root = session.sessionManager.getCwd();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await session.dispose();

		const resumedSession = await createSession({ root, sessionFile: sessionFile! });
		await resumedSession.setActiveToolsByName(["read"]);
		const resumedRuntime = createFuraRpcRuntime(resumedSession);
		await resumedRuntime.reconcileSessionMode();

		expect(resumedSession.getGoalModeState()).toMatchObject({
			enabled: true,
			mode: "active",
			goal: { objective: "Survive process restart", status: "active" },
		});
		expect(resumedSession.getActiveToolNames()).toEqual(["read", "goal"]);
	});

	it("keeps paused goals inactive after interruption and process restart", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		const runtime = createFuraRpcRuntime(session);
		await runtime.handleCommand({
			id: "goal-create-paused",
			type: "goal_mode",
			op: "create",
			objective: "Pause cleanly",
		});

		await session.goalRuntime.onTaskAborted({ reason: "interrupted" });
		const pausedState = session.getGoalModeState();
		expect(pausedState).toMatchObject({ enabled: false, goal: { status: "paused" } });
		await runtime.handleSessionEvent({
			type: "goal_updated",
			goal: pausedState?.goal ?? null,
			state: pausedState!,
		});
		expect(session.getActiveToolNames()).toEqual(["read"]);

		const root = session.sessionManager.getCwd();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await session.dispose();

		const resumedSession = await createSession({ root, sessionFile: sessionFile! });
		await resumedSession.setActiveToolsByName(["read"]);
		const resumedRuntime = createFuraRpcRuntime(resumedSession);
		await resumedRuntime.reconcileSessionMode();
		expect(resumedSession.getGoalModeState()).toMatchObject({
			enabled: false,
			goal: { objective: "Pause cleanly", status: "paused" },
		});
		expect(resumedSession.getActiveToolNames()).toEqual(["read"]);
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
