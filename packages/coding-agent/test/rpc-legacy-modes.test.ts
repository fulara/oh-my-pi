import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcGoalController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import { createFuraRpcRuntime } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cleanupRoots: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession(root: string, sessionFile?: string): Promise<AgentSession> {
	const settings = Settings.isolated({ "compaction.enabled": false, "goal.enabled": true });
	const sessionManager = sessionFile
		? await SessionManager.open(sessionFile, path.join(root, "sessions"))
		: await SessionManager.continueRecent(root, path.join(root, "sessions"));
	const toolRegistry = new Map<string, AgentTool>();
	const sessionRef: { current?: AgentSession } = {};
	const toolSession = {
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
		getToolByName: (name: string) => toolRegistry.get(name),
	} as ToolSession;
	const tools = await createTools(toolSession, ["read", "write"]);
	const goalTool = await HIDDEN_TOOLS.goal(toolSession);
	for (const tool of [...tools, goalTool].filter((tool): tool is AgentTool => tool !== null)) {
		toolRegistry.set(tool.name, tool);
	}
	const model = createMockModel({ responses: [{ content: ["ok"] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: model.model, systemPrompt: ["Test"], tools, messages: [] },
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
	});
	sessionRef.current = session;
	return session;
}

describe("RPC legacy mode journals", () => {
	for (const mode of ["plan", "plan_paused", "goal", "goal_paused"] as const) {
		it(`does not apply fork mode restoration to a legacy ${mode} journal`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-legacy-modes-"));
			cleanupRoots.push(root);
			const session = await createSession(root);
			const planFilePath = path.join(root, "legacy-plan.md");
			const planContent = "# Legacy plan\n\nKeep this artifact unchanged.\n";
			await fs.writeFile(planFilePath, planContent);
			const goal = {
				id: "legacy-goal",
				objective: "Keep native Goal behavior",
				status: mode === "goal" ? "active" : "paused",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			session.sessionManager.appendModeChange(mode, mode.startsWith("goal") ? { goal } : { planFilePath });
			await session.sessionManager.ensureOnDisk();
			const sessionFile = session.sessionManager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await session.dispose();
			const journal = await fs.readFile(sessionFile!, "utf8");
			const resumedSession = await createSession(root, sessionFile!);
			const runtime = createFuraRpcRuntime(resumedSession);
			try {
				await runtime.reconcileSession();
				expect(resumedSession.getPlanModeState()).toBeUndefined();
				expect(resumedSession.getGoalModeState()).toBeUndefined();
				expect(resumedSession.getActiveToolNames()).toEqual(["read", "write"]);
				expect(resumedSession.sessionManager.buildSessionContext().mode).toBe(mode);
				expect(await fs.readFile(sessionFile!, "utf8")).toBe(journal);
				expect(await fs.readFile(planFilePath, "utf8")).toBe(planContent);

				// Native upstream Goal reconciliation still owns its journal semantics.
				const nativeGoal = new RpcGoalController(resumedSession);
				await nativeGoal.reconcile();
				await nativeGoal.settled();
				await runtime.reconcileSession();
				if (mode.startsWith("goal")) {
					expect(resumedSession.getGoalModeState()).toMatchObject({
						enabled: false,
						goal: { id: "legacy-goal", status: "paused" },
					});
					expect(resumedSession.getActiveToolNames()).toEqual(["read", "write", "goal"]);
				} else {
					expect(resumedSession.getGoalModeState()).toBeUndefined();
					expect(resumedSession.getActiveToolNames()).toEqual(["read", "write"]);
					expect(await fs.readFile(sessionFile!, "utf8")).toBe(journal);
				}
			} finally {
				await runtime.dispose();
				await resumedSession.dispose();
			}
		});
	}
});
