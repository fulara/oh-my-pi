/**
 * Two concurrent `prompt()` calls must serialize instead of racing dispatch.
 *
 * `prompt()` checks `isStreaming` at the top, but image normalization (and the
 * vision-description call) suspend before `#promptWithMessage` increments the
 * in-flight count. Two callers that both saw an idle session — the CLI initial
 * message of an `omp "prompt"` launch and a submission typed right after the
 * startup composer opens its submit gate — used to both dispatch: the loser
 * died with AgentBusyError and the prompts could land out of order. The
 * post-await re-check queues the loser as a steer into the winner's turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("AgentSession concurrent prompt dispatch", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
	});

	function createSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: createMockModel({
				responses: [{ content: ["First done"] }, { content: ["Second done"] }, { content: ["Third done"] }],
			}).stream,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	}

	it.each(["steer", "followUp"] as const)(
		"retains consumed client identity when preprocessing queues a concurrent %s prompt",
		async streamingBehavior => {
			createSession();
			const consumedIds: (string | undefined)[] = [];
			session.subscribe(event => {
				if (event.type === "message_end" && event.message.role === "user") {
					consumedIds.push(event.message.clientMessageId);
				}
			});

			// Neither call is awaited before the other starts: both pass the
			// top-of-prompt isStreaming check because the pre-dispatch awaits
			// suspend before the in-flight count increments.
			const first = session.prompt("initial CLI prompt", {
				streamingBehavior,
				clientMessageId: "client-first",
			});
			const second = session.prompt("typed during preflight", {
				streamingBehavior,
				clientMessageId: "client-second",
			});

			// Pre-fix, the loser reached agent.prompt() on a busy agent and this
			// rejected with AgentBusyError.
			await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
			await session.waitForIdle();
			expect(consumedIds).toEqual(["client-first", "client-second"]);
			expect(
				session.sessionManager
					.getBranch()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "user" ? [entry.message.clientMessageId] : [],
					),
			).toEqual(["client-first", "client-second"]);

			const users = session.messages.filter(message => message.role === "user");
			const textOf = (message: (typeof users)[number]): string =>
				typeof message.content === "string"
					? message.content
					: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
			const firstIndex = users.findIndex(message => textOf(message) === "initial CLI prompt");
			const secondIndex = users.findIndex(message => textOf(message) === "typed during preflight");
			expect(firstIndex).toBeGreaterThanOrEqual(0);
			expect(secondIndex).toBeGreaterThanOrEqual(0);
			// The first dispatch keeps its turn; the loser queues into it.
			expect(firstIndex).toBeLessThan(secondIndex);
			// Steering must interrupt; follow-up must retain its non-interrupting mode.
			// Before the re-check, idle-retry incorrectly launched a detached turn.
			expect(users[secondIndex]?.steering).toBe(streamingBehavior === "steer" ? true : undefined);
		},
	);
});
