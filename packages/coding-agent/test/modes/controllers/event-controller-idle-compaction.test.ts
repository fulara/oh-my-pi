import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

import { cfgCompactionIdleEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createContext(options: { runIdleCompaction?: AgentSession["runIdleCompaction"] } = {}) {
	return createInteractiveModeContext({
		editor: { getText: () => "" },
		session: {
			isCompacting: false,
			isStreaming: false,
			runIdleCompaction: options.runIdleCompaction ?? (async () => {}),
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			messages: [createAssistantMessage()],
			getContextUsage: () => ({ tokens: 210, contextWindow: 1_000, percent: 21 }),
		},
	});
}

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn(async () => {});
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("arms idle compaction when it is enabled after the turn becomes idle", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });
		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });

		cfgCompactionIdleEnabled.set(settings, true);
		controller.refreshIdleCompactionTimer();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).toHaveBeenCalledTimes(1);
		controller.dispose();
	});
});
