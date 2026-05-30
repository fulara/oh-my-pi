import type { AgentEvent, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcPlanReviewEvent,
	RpcResponse,
} from "../../../src/modes/rpc/rpc-types";

type ReadyFrame = { type: "ready" };
type RpcContractFrame =
	| ReadyFrame
	| RpcCommand
	| RpcResponse
	| AgentEvent
	| RpcExtensionUIRequest
	| RpcHostToolCallRequest
	| RpcHostToolCancelRequest
	| RpcHostToolResult
	| RpcHostToolUpdate
	| RpcHostUriRequest
	| RpcHostUriCancelRequest
	| RpcHostUriResult
	| RpcPlanReviewEvent;

export type RpcContractFixture = {
	name: string;
	category: "command" | "lifecycle" | "response" | "event" | "extension" | "host-tool" | "host-uri";
	frame: RpcContractFrame;
};

const usage = {
	input: 120,
	output: 45,
	cacheRead: 10,
	cacheWrite: 5,
	totalTokens: 180,
	cost: {
		input: 0.00036,
		output: 0.000675,
		cacheRead: 0.00003,
		cacheWrite: 0.000075,
		total: 0.00114,
	},
};

const model = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
} satisfies NonNullable<Extract<RpcResponse, { command: "get_state"; success: true }>["data"]["model"]>;

const planMode = {
	enabled: true,
	planFilePath: "local://PLAN.md",
	workflow: "parallel",
	reentry: false,
} satisfies NonNullable<Extract<RpcResponse, { command: "set_plan_mode"; success: true }>["data"]["planMode"]>;

const goalMode = {
	enabled: true,
	mode: "active",
	goal: {
		id: "goal-1",
		objective: "Ship goal-mode projection",
		status: "active",
		tokenBudget: 50000,
		tokensUsed: 1200,
		timeUsedSeconds: 90,
		createdAt: 1770000000000,
		updatedAt: 1770000009000,
	},
} satisfies NonNullable<Extract<RpcResponse, { command: "goal_mode"; success: true }>["data"]["goalMode"]>;

const readToolResult = {
	content: [{ type: "text", text: "fn main() {}" }],
	details: { path: "src/main.rs" },
} satisfies AgentToolResult<{ path: string }>;

const assistantTextMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Hello from OMP RPC." }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage,
	stopReason: "stop",
	timestamp: 1770000000000,
} satisfies Extract<AgentEvent, { type: "message_end" }>["message"];

const assistantThinkingMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "Reasoning summary", thinkingSignature: "sig-1" },
		{ type: "redactedThinking", data: "encrypted-redacted-thinking" },
		{ type: "text", text: "Final answer." },
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage,
	stopReason: "stop",
	timestamp: 1770000001000,
} satisfies Extract<AgentEvent, { type: "message_end" }>["message"];

const userMessage = {
	role: "user",
	content: [{ type: "text", text: "Please inspect the repo." }],
	timestamp: 1770000002000,
} satisfies Extract<AgentEvent, { type: "message_end" }>["message"];

const toolCallAssistantMessage = {
	role: "assistant",
	content: [
		{ type: "text", text: "Reading file." },
		{
			type: "toolCall",
			id: "toolu_read_1",
			name: "read",
			arguments: { path: "src/main.rs", sel: "1-80" },
			intent: "Reading entrypoint",
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage,
	stopReason: "toolUse",
	timestamp: 1770000003000,
} satisfies Extract<AgentEvent, { type: "message_end" }>["message"];

const toolResultMessage = {
	role: "toolResult",
	toolCallId: "toolu_read_1",
	toolName: "read",
	content: [{ type: "text", text: "fn main() {}" }],
	details: { path: "src/main.rs" },
	isError: false,
	timestamp: 1770000004000,
} satisfies Extract<AgentEvent, { type: "message_end" }>["message"];

export const rpcContractFixtures = [
	{
		name: "ready",
		category: "lifecycle",
		frame: { type: "ready" } satisfies ReadyFrame,
	},
	{
		name: "command-get-state",
		category: "command",
		frame: { id: "cmd-state-1", type: "get_state" } satisfies Extract<RpcCommand, { type: "get_state" }>,
	},
	{
		name: "command-fork",
		category: "command",
		frame: { id: "cmd-fork-1", type: "fork" } satisfies Extract<RpcCommand, { type: "fork" }>,
	},
	{
		name: "command-set-host-uri-schemes",
		category: "command",
		frame: {
			id: "cmd-uri-schemes-1",
			type: "set_host_uri_schemes",
			schemes: [
				{ scheme: "notion", description: "Remote markdown pages", immutable: true },
				{ scheme: "db", description: "Writable database records", writable: true },
			],
		} satisfies Extract<RpcCommand, { type: "set_host_uri_schemes" }>,
	},
	{
		name: "command-set-plan-mode",
		category: "command",
		frame: {
			id: "cmd-plan-1",
			type: "set_plan_mode",
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
		} satisfies Extract<RpcCommand, { type: "set_plan_mode" }>,
	},
	{
		name: "command-approve-plan-mode",
		category: "command",
		frame: {
			id: "cmd-plan-approve-1",
			type: "approve_plan_mode",
			planFilePath: "local://PLAN.md",
			finalPlanFilePath: "local://Fura_RPC_Protocol_Plan.md",
			preserveContext: true,
			compactBeforeExecute: false,
		} satisfies Extract<RpcCommand, { type: "approve_plan_mode" }>,
	},
	{
		name: "command-set-active-tools",
		category: "command",
		frame: {
			id: "cmd-tools-1",
			type: "set_active_tools",
			toolNames: ["read", "todo_write", "task"],
		} satisfies Extract<RpcCommand, { type: "set_active_tools" }>,
	},
	{
		name: "command-goal-mode-create",
		category: "command",
		frame: {
			id: "cmd-goal-create-1",
			type: "goal_mode",
			op: "create",
			objective: "Ship goal-mode projection",
			tokenBudget: 50000,
		} satisfies Extract<RpcCommand, { type: "goal_mode"; op: "create" }>,
	},
	{
		name: "command-goal-mode-set-budget",
		category: "command",
		frame: {
			id: "cmd-goal-budget-1",
			type: "goal_mode",
			op: "set_budget",
			tokenBudget: 75000,
		} satisfies Extract<RpcCommand, { type: "goal_mode" }>,
	},
	{
		name: "host-uri-request-read",
		category: "host-uri",
		frame: {
			type: "host_uri_request",
			id: "uri-read-1",
			operation: "read",
			url: "notion://page/abc123",
		} satisfies RpcHostUriRequest,
	},
	{
		name: "host-uri-request-write",
		category: "host-uri",
		frame: {
			type: "host_uri_request",
			id: "uri-write-1",
			operation: "write",
			url: "db://records/42",
			content: '{"status":"done"}',
		} satisfies RpcHostUriRequest,
	},
	{
		name: "host-uri-cancel",
		category: "host-uri",
		frame: {
			type: "host_uri_cancel",
			id: "uri-cancel-1",
			targetId: "uri-read-1",
		} satisfies RpcHostUriCancelRequest,
	},
	{
		name: "host-uri-result-success",
		category: "host-uri",
		frame: {
			type: "host_uri_result",
			id: "uri-read-1",
			content: "# Document\n\nFetched over host URI.",
			contentType: "text/markdown",
			notes: ["resolved from remote workspace"],
			immutable: true,
		} satisfies RpcHostUriResult,
	},
	{
		name: "host-uri-result-error",
		category: "host-uri",
		frame: {
			type: "host_uri_result",
			id: "uri-write-1",
			isError: true,
			error: "Permission denied for db://records/42",
		} satisfies RpcHostUriResult,
	},
	{
		name: "host-tool-call",
		category: "host-tool",
		frame: {
			type: "host_tool_call",
			id: "host-call-1",
			toolCallId: "toolu_host_1",
			toolName: "browser.open",
			arguments: { url: "https://example.com" },
		} satisfies RpcHostToolCallRequest,
	},
	{
		name: "host-tool-cancel",
		category: "host-tool",
		frame: {
			type: "host_tool_cancel",
			id: "host-cancel-1",
			targetId: "host-call-1",
		} satisfies RpcHostToolCancelRequest,
	},
	{
		name: "host-tool-update",
		category: "host-tool",
		frame: {
			type: "host_tool_update",
			id: "host-call-1",
			partialResult: {
				content: [{ type: "text", text: "Loading page…" }],
				details: { progress: 50 },
			},
		} satisfies RpcHostToolUpdate,
	},
	{
		name: "host-tool-result",
		category: "host-tool",
		frame: {
			type: "host_tool_result",
			id: "host-call-1",
			result: {
				content: [{ type: "text", text: "Opened https://example.com" }],
				details: { url: "https://example.com" },
			},
			isError: false,
		} satisfies RpcHostToolResult,
	},
	{
		name: "event-agent-start",
		category: "event",
		frame: { type: "agent_start" } satisfies Extract<AgentEvent, { type: "agent_start" }>,
	},
	{
		name: "event-agent-end",
		category: "event",
		frame: { type: "agent_end", messages: [userMessage, assistantTextMessage] } satisfies Extract<
			AgentEvent,
			{ type: "agent_end" }
		>,
	},
	{
		name: "event-message-update-text",
		category: "event",
		frame: {
			type: "message_update",
			message: assistantTextMessage,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Hello from OMP RPC.",
				partial: assistantTextMessage,
			},
		} satisfies Extract<AgentEvent, { type: "message_update" }>,
	},
	{
		name: "event-message-end-text",
		category: "event",
		frame: { type: "message_end", message: assistantTextMessage } satisfies Extract<
			AgentEvent,
			{ type: "message_end" }
		>,
	},
	{
		name: "event-message-end-thinking",
		category: "event",
		frame: { type: "message_end", message: assistantThinkingMessage } satisfies Extract<
			AgentEvent,
			{ type: "message_end" }
		>,
	},
	{
		name: "event-message-end-tool-call",
		category: "event",
		frame: { type: "message_end", message: toolCallAssistantMessage } satisfies Extract<
			AgentEvent,
			{ type: "message_end" }
		>,
	},
	{
		name: "event-message-end-tool-result",
		category: "event",
		frame: { type: "message_end", message: toolResultMessage } satisfies Extract<AgentEvent, { type: "message_end" }>,
	},
	{
		name: "event-tool-execution-start",
		category: "event",
		frame: {
			type: "tool_execution_start",
			toolCallId: "toolu_read_1",
			toolName: "read",
			args: { path: "src/main.rs", sel: "1-80" },
			intent: "Reading entrypoint",
		} satisfies Extract<AgentEvent, { type: "tool_execution_start" }>,
	},
	{
		name: "event-tool-execution-update",
		category: "event",
		frame: {
			type: "tool_execution_update",
			toolCallId: "toolu_read_1",
			toolName: "read",
			args: { path: "src/main.rs", sel: "1-80" },
			partialResult: {
				content: [{ type: "text", text: "partial output" }],
				details: { async: { state: "running" } },
			},
		} satisfies Extract<AgentEvent, { type: "tool_execution_update" }>,
	},
	{
		name: "event-tool-execution-end",
		category: "event",
		frame: {
			type: "tool_execution_end",
			toolCallId: "toolu_read_1",
			toolName: "read",
			result: readToolResult,
			isError: false,
		} satisfies Extract<AgentEvent, { type: "tool_execution_end" }>,
	},
	{
		name: "event-plan-review",
		category: "event",
		frame: {
			type: "plan_review",
			sessionId: "session-123",
			planFilePath: "local://PLAN.md",
			finalPlanFilePath: "local://Fura_RPC_Protocol_Plan.md",
			title: "Fura_RPC_Protocol_Plan",
			content: "# Plan\n\nImplement the approved design.",
		} satisfies RpcPlanReviewEvent,
	},
	{
		name: "response-get-state",
		category: "response",
		frame: {
			id: "rpc-state-1",
			type: "response",
			command: "get_state",
			success: true,
			data: {
				model,
				thinkingLevel: Effort.Medium,
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "one-at-a-time",
				interruptMode: "immediate",
				sessionFile: "/tmp/omp/session.jsonl",
				sessionId: "session-1",
				sessionName: "Fixture session",
				autoCompactionEnabled: true,
				messageCount: 4,
				queuedMessageCount: 0,
				todoPhases: [],
				planMode,
				goalMode,
				systemPrompt: ["You are a reliable coding agent."],
				dumpTools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
				contextUsage: { tokens: 1234, contextWindow: 200000, percent: 0.617 },
			},
		} satisfies Extract<RpcResponse, { command: "get_state"; success: true }>,
	},
	{
		name: "response-get-available-models",
		category: "response",
		frame: {
			id: "rpc-models-1",
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: [model] },
		} satisfies Extract<RpcResponse, { command: "get_available_models"; success: true }>,
	},
	{
		name: "response-get-messages",
		category: "response",
		frame: {
			id: "rpc-messages-1",
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: [userMessage, toolCallAssistantMessage, toolResultMessage, assistantThinkingMessage] },
		} satisfies Extract<RpcResponse, { command: "get_messages"; success: true }>,
	},
	{
		name: "response-get-session-stats",
		category: "response",
		frame: {
			id: "rpc-stats-1",
			type: "response",
			command: "get_session_stats",
			success: true,
			data: {
				sessionFile: "/tmp/omp/session.jsonl",
				sessionId: "session-1",
				userMessages: 1,
				assistantMessages: 2,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: 4,
				tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
				premiumRequests: 1,
				cost: 0.00123,
			},
		} satisfies Extract<RpcResponse, { command: "get_session_stats"; success: true }>,
	},
	{
		name: "response-fork",
		category: "response",
		frame: {
			id: "rpc-fork-1",
			type: "response",
			command: "fork",
			success: true,
			data: { cancelled: false },
		} satisfies Extract<RpcResponse, { command: "fork"; success: true }>,
	},
	{
		name: "response-set-plan-mode",
		category: "response",
		frame: {
			id: "rpc-plan-set-1",
			type: "response",
			command: "set_plan_mode",
			success: true,
			data: { planMode },
		} satisfies Extract<RpcResponse, { command: "set_plan_mode"; success: true }>,
	},
	{
		name: "response-approve-plan-mode",
		category: "response",
		frame: {
			id: "rpc-plan-approve-1",
			type: "response",
			command: "approve_plan_mode",
			success: true,
			data: {
				finalPlanFilePath: "local://Fura_RPC_Protocol_Plan.md",
				contextPreserved: true,
				compactionOutcome: "ok",
				executionDispatched: true,
			},
		} satisfies Extract<RpcResponse, { command: "approve_plan_mode"; success: true }>,
	},
	{
		name: "response-set-active-tools",
		category: "response",
		frame: {
			id: "rpc-tools-1",
			type: "response",
			command: "set_active_tools",
			success: true,
			data: { toolNames: ["read", "todo_write", "task"] },
		} satisfies Extract<RpcResponse, { command: "set_active_tools"; success: true }>,
	},
	{
		name: "response-goal-mode",
		category: "response",
		frame: {
			id: "rpc-goal-1",
			type: "response",
			command: "goal_mode",
			success: true,
			data: { goalMode },
		} satisfies Extract<RpcResponse, { command: "goal_mode"; success: true }>,
	},
	{
		name: "response-error",
		category: "response",
		frame: {
			id: "rpc-error-1",
			type: "response",
			command: "prompt",
			success: false,
			error: "Agent is already processing",
		} satisfies Extract<RpcResponse, { success: false }>,
	},
	{
		name: "extension-ui-request-confirm",
		category: "extension",
		frame: {
			type: "extension_ui_request",
			id: "dialog-1",
			method: "confirm",
			title: "Continue?",
			message: "Approve the operation?",
			timeout: 30000,
		} satisfies RpcExtensionUIRequest,
	},
] satisfies RpcContractFixture[];
