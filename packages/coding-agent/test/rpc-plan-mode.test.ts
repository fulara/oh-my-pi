import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
const cleanupRoots: string[] = [];
const cleanupFns: Array<() => void> = [];

afterEach(async () => {
	for (const cleanup of cleanupFns.splice(0)) cleanup();
	await Promise.all(cleanupRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession(): Promise<AgentSession> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-plan-mode-"));
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
	const tools = await createTools(toolSession, ["read", "write"]);
	for (const tool of tools) toolRegistry.set(tool.name, tool);

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
	session = new AgentSession({ agent, sessionManager, settings, modelRegistry, toolRegistry });
	return session;
}

async function writeLocalPlan(session: AgentSession, localUrl: string, content: string): Promise<void> {
	const filePath = resolveRpcPlanPath(session, localUrl);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
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
			"# Runtime Plan\n\n- ship safely\n",
		);
		// The approved plan content must be persisted to the final local file above.
		// Upstream's execution prompt reads that file by path instead of embedding the
		// plan inline, so assert the durable prompt contract: approval marker + path.
		const serializedMessages = JSON.stringify(session.messages);
		expect(serializedMessages).toContain("Plan approved.");
		expect(serializedMessages).toContain("local://APPROVED.md");
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
});
