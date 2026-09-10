import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createFuraRpcRuntime, resolveRpcPlanPath } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcPlanReviewEvent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";

const cleanupRoots: string[] = [];
const cleanupFns: Array<() => void> = [];

afterEach(async () => {
	for (const cleanup of cleanupFns.splice(0)) cleanup();
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession(
	extraTools: AgentTool[] = [],
	builtInToolNames: string[] = ["read", "write"],
	options: { root?: string; sessionFile?: string } = {},
): Promise<AgentSession> {
	const root = options.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-plan-mode-")));
	if (!options.root) cleanupRoots.push(root);

	const settings = Settings.isolated({
		"compaction.enabled": false,
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
		getToolByName: name => toolRegistry.get(name),
	} as ToolSession;
	const tools = await createTools(toolSession, ["read", "write"]);
	for (const tool of [...tools, ...extraTools]) toolRegistry.set(tool.name, tool);

	const model = createMockModel({ responses: [{ content: ["approved execution"] }] });
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	cleanupFns.push(() => authStorage.close());
	authStorage.setRuntimeApiKey("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
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
		modelRegistry,
		toolRegistry,
		builtInToolNames,
		...(extraTools.length > 0
			? {
					builtInToolNames: ["read", "write"],
					xdev: {
						tools: toolRegistry,
						mountedNames: new Set(extraTools.map(tool => tool.name)),
						builtInNames: new Set(builtInToolNames),
						isActive: name => agent.state.tools.some(tool => tool.name === name),
					} satisfies XdevState,
				}
			: {}),
	});
	sessionRef.current = session;
	return session;
}

async function writeLocalPlan(session: AgentSession, localUrl: string, content: string): Promise<void> {
	const filePath = resolveRpcPlanPath(session, localUrl);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
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

describe("Fura RPC plan-mode runtime", () => {
	it("enables, reviews, and approves a plan while preserving context", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		await writeLocalPlan(session, "local://PLAN.md", "# Runtime Plan\n\n- ship safely\n");

		const frames: unknown[] = [];
		const runtime = createFuraRpcRuntime(session, frame => frames.push(frame));
		const enabled = await runtime.handleCommand({
			id: "plan-on",
			type: "set_plan_mode",
			enabled: true,
			workflow: "parallel",
		});

		expect(enabled).toMatchObject({
			id: "plan-on",
			type: "response",
			command: "set_plan_mode",
			success: true,
			data: { planMode: { enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" } },
		});
		expect(session.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);

		const proposalHandler = session.peekPlanProposalHandler();
		expect(proposalHandler).toBeFunction();
		if (!proposalHandler) throw new Error("plan proposal handler was not registered");
		const proposalResult = await proposalHandler("Reviewed Runtime Plan");
		await runtime.handleSessionEvent({
			type: "tool_execution_end",
			toolCallId: "propose-1",
			toolName: "write",
			args: {},
			result: proposalResult,
			isError: false,
		} as AgentEvent);

		const reviewFrame = frames.find((frame): frame is RpcPlanReviewEvent => {
			return typeof frame === "object" && frame !== null && (frame as { type?: string }).type === "plan_review";
		});
		expect(reviewFrame).toMatchObject({
			type: "plan_review",
			planFilePath: "local://PLAN.md",
			finalPlanFilePath: "local://Reviewed-Runtime-Plan.md",
			title: "Reviewed-Runtime-Plan",
			content: "# Runtime Plan\n\n- ship safely\n",
		});
		// Approval must dispatch the latest reviewed file, not the earlier proposal.
		await writeLocalPlan(session, "local://PLAN.md", "# Runtime Plan\n\n- ship the reviewed change\n");

		const agentEnded = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end") {
				unsubscribe();
				agentEnded.resolve();
			}
		});
		const waitForAgentEnd = Promise.race([
			agentEnded.promise,
			new Promise<never>((_, reject) =>
				setTimeout(() => {
					unsubscribe();
					reject(new Error("approved plan execution did not dispatch"));
				}, 2_000),
			),
		]);

		const approved = await runtime.handleCommand({
			id: "approve",
			type: "approve_plan_mode",
			finalPlanFilePath: "local://APPROVED.md",
			preserveContext: true,
			compactBeforeExecute: false,
		});
		expect(approved).toEqual({
			id: "approve",
			type: "response",
			command: "approve_plan_mode",
			success: true,
			data: {
				finalPlanFilePath: "local://APPROVED.md",
				contextPreserved: true,
				executionDispatched: true,
			},
		});
		await waitForAgentEnd;

		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);
		await expect(fs.readFile(resolveRpcPlanPath(session, "local://APPROVED.md"), "utf8")).resolves.toBe(
			"# Runtime Plan\n\n- ship the reviewed change\n",
		);
		const executionMessages = JSON.stringify(convertToLlm(session.messages));
		expect(executionMessages).toContain("ship the reviewed change");
		expect(executionMessages).not.toContain("ship safely");
		expect(executionMessages).toContain("local://APPROVED.md");
	});

	it("keeps read active for approved plan execution when pre-plan tools omitted it", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["resolve"]);
		expect(session.getActiveToolNames()).not.toContain("read");
		await writeLocalPlan(session, "local://PLAN.md", "# Runtime Plan\n\n- execute from disk\n");

		const runtime = createFuraRpcRuntime(session, () => {});
		const enabled = await runtime.handleCommand({
			id: "plan-on-no-read",
			type: "set_plan_mode",
			enabled: true,
		});
		expect(enabled).toMatchObject({
			id: "plan-on-no-read",
			type: "response",
			command: "set_plan_mode",
			success: true,
		});

		const agentEnded = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "agent_end") {
				unsubscribe();
				agentEnded.resolve();
			}
		});

		const approved = await runtime.handleCommand({
			id: "approve-no-read",
			type: "approve_plan_mode",
			finalPlanFilePath: "local://APPROVED-NO-READ.md",
			preserveContext: true,
			compactBeforeExecute: false,
		});
		expect(approved).toEqual({
			id: "approve-no-read",
			type: "response",
			command: "approve_plan_mode",
			success: true,
			data: {
				finalPlanFilePath: "local://APPROVED-NO-READ.md",
				contextPreserved: true,
				executionDispatched: true,
			},
		});
		await agentEnded.promise;

		expect(session.getActiveToolNames()).toContain("read");
	});

	it("rolls back plan approval when the new session is cancelled", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		await writeLocalPlan(session, "local://PLAN.md", "# Cancelled Plan\n");
		const runtime = createFuraRpcRuntime(session, () => {});
		await runtime.handleCommand({ id: "plan-on-cancel", type: "set_plan_mode", enabled: true });
		session.newSession = async () => false;

		const approved = await runtime.handleCommand({
			id: "approve-cancelled",
			type: "approve_plan_mode",
			finalPlanFilePath: "local://CANCELLED.md",
			preserveContext: false,
		});

		expect(approved).toEqual({
			id: "approve-cancelled",
			type: "response",
			command: "approve_plan_mode",
			success: true,
			data: {
				finalPlanFilePath: "local://CANCELLED.md",
				contextPreserved: false,
				executionDispatched: false,
			},
		});
		expect(session.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(session.peekPlanProposalHandler()).toBeFunction();
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		await expect(fs.readFile(resolveRpcPlanPath(session, "local://PLAN.md"), "utf8")).resolves.toBe(
			"# Cancelled Plan\n",
		);
		await expect(fs.stat(resolveRpcPlanPath(session, "local://CANCELLED.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rolls back plan approval when the new session fails before switching", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		await writeLocalPlan(session, "local://PLAN.md", "# Failed Plan\n");
		const runtime = createFuraRpcRuntime(session, () => {});
		await runtime.handleCommand({ id: "plan-on-failure", type: "set_plan_mode", enabled: true });
		session.newSession = async () => {
			throw new Error("session transition failed");
		};

		const approved = await runtime.handleCommand({
			id: "approve-failed",
			type: "approve_plan_mode",
			finalPlanFilePath: "local://FAILED.md",
			preserveContext: false,
		});

		expect(approved).toMatchObject({
			id: "approve-failed",
			type: "response",
			command: "approve_plan_mode",
			success: false,
			error: "session transition failed",
		});
		expect(session.getPlanModeState()).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(session.peekPlanProposalHandler()).toBeFunction();
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		await expect(fs.readFile(resolveRpcPlanPath(session, "local://PLAN.md"), "utf8")).resolves.toBe(
			"# Failed Plan\n",
		);
		await expect(fs.stat(resolveRpcPlanPath(session, "local://FAILED.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("passes approved plan compaction through internal guidance", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		await writeLocalPlan(session, "local://PLAN.md", "# Compact Plan\n");
		const compactCalls: Parameters<AgentSession["compact"]>[] = [];
		session.compact = async (...args) => {
			compactCalls.push(args);
			return {} as never;
		};
		session.prompt = async () => true;
		const runtime = createFuraRpcRuntime(session, () => {});
		await runtime.handleCommand({ id: "plan-on-compact", type: "set_plan_mode", enabled: true });

		const approved = await runtime.handleCommand({
			id: "approve-compact",
			type: "approve_plan_mode",
			finalPlanFilePath: "local://Compact-Plan.md",
			preserveContext: true,
			compactBeforeExecute: true,
		});

		expect(approved).toMatchObject({
			success: true,
			data: { compactionOutcome: "ok", executionDispatched: true },
		});
		expect(compactCalls).toHaveLength(1);
		expect(compactCalls[0]?.[0]).toBeUndefined();
		expect(compactCalls[0]?.[1]?.internalGuidance).toContain("local://Compact-Plan.md");
	});

	it("preserves mounted discoverable tools when leaving plan mode", async () => {
		const session = await createSession([makeDiscoverableTool("report_issue")]);
		await session.setActiveToolPresentation(["read", "write", "report_issue"], ["report_issue"]);
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(session.getMountedXdevToolNames()).toContain("report_issue");

		const runtime = createFuraRpcRuntime(session, () => {});
		await runtime.handleCommand({ id: "plan-on-mounted", type: "set_plan_mode", enabled: true });
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(session.getMountedXdevToolNames()).toContain("report_issue");

		await runtime.handleCommand({ id: "plan-off-mounted", type: "set_plan_mode", enabled: false });
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(session.getMountedXdevToolNames()).toContain("report_issue");
	});

	it("rehydrates persisted plan mode without duplicating its mode entry", async () => {
		const session = await createSession();
		await session.setActiveToolsByName(["read"]);
		session.sessionManager.appendModeChange("plan", { planFilePath: "local://RESTORED.md" });
		const root = session.sessionManager.getCwd();
		await session.sessionManager.ensureOnDisk();
		const sessionFile = session.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await session.dispose();

		const resumedSession = await createSession([], ["read", "write"], { root, sessionFile: sessionFile! });
		const entriesBefore = resumedSession.sessionManager.getBranch().length;
		const runtime = createFuraRpcRuntime(resumedSession);
		await runtime.reconcileSessionMode();

		expect(resumedSession.getPlanModeState()).toEqual({
			enabled: true,
			planFilePath: "local://RESTORED.md",
			workflow: "parallel",
			reentry: true,
		});
		expect(resumedSession.getActiveToolNames()).toEqual(["read", "write"]);
		expect(resumedSession.sessionManager.getBranch()).toHaveLength(entriesBefore);
	});

	it("does not activate a shadowing non-built-in write tool in plan mode", async () => {
		const session = await createSession([], ["read"]);
		await session.setActiveToolsByName(["read"]);

		const runtime = createFuraRpcRuntime(session);
		const response = await runtime.handleCommand({ id: "plan-shadow-write", type: "set_plan_mode", enabled: true });

		expect(response).toMatchObject({ success: true });
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("rejects RPC fork while a prompt is streaming", async () => {
		let forkCalled = false;
		const runtime = createFuraRpcRuntime({
			isStreaming: true,
			async fork() {
				forkCalled = true;
				return true;
			},
		} as unknown as AgentSession);

		const response = await runtime.handleCommand({ id: "fork-busy", type: "fork" });

		expect(response).toEqual({
			id: "fork-busy",
			type: "response",
			command: "fork",
			success: false,
			error: "Cannot fork while a prompt is in progress.",
		});
		expect(forkCalled).toBe(false);
	});
});
