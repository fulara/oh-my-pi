/**
 * Contract: a custom message steered into a streaming session (the collab-host
 * and skill-prompt path: `promptCustomMessage(..., { streamingBehavior: "steer" })`)
 * is always delivered — never silently stranded in the agent's steering queue.
 *
 * Two regression seams, both observed as "guest messages just disappear" in
 * collab sessions:
 *  1. A steer landing at the run's yield boundary (after the stop-boundary
 *     dequeue) must force another turn instead of stranding.
 *  2. A steer landing while the prompt unwinds (isStreaming stays true through
 *     post-prompt recovery, but the loop is already done) must be drained when
 *     the session settles.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const COLLAB_PROMPT_TYPE = "collab-prompt";

interface SteerHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
}

describe("AgentSession queued steer delivery", () => {
	let tempDir: string;
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeAll(async () => {
		fixtureDir = path.join(os.tmpdir(), `pi-steer-strand-fixture-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(fixtureDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-steer-strand-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	async function createSession(
		responses: MockResponse[],
		sessionManager = SessionManager.inMemory(),
	): Promise<SteerHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return { session, sessionManager, mock };
	}

	function steerCollabPrompt(target: AgentSession, text: string): Promise<boolean> {
		return target.promptCustomMessage(
			{
				customType: COLLAB_PROMPT_TYPE,
				content: text,
				display: true,
				details: { from: "guest" },
				attribution: "user",
			},
			{ streamingBehavior: "steer" },
		);
	}

	function nextUserMessage(target: AgentSession, expected: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = target.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const content = event.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("");
			if (text !== expected) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	/** Resolves with the entry text when a collab-prompt entry is persisted. */
	function nextCollabEntry(sessionManager: SessionManager): Promise<string> {
		const { promise, resolve } = Promise.withResolvers<string>();
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === COLLAB_PROMPT_TYPE) {
				resolve(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return promise;
	}

	it("delivers a collab steer that lands at the run's yield boundary", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack guest"] },
		]);
		const entryAppended = nextCollabEntry(sessionManager);

		let streamingAtInject: boolean | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// The session is still mid-prompt here, so this takes the steer path.
			streamingAtInject = session.isStreaming;
			await steerCollabPrompt(session, "guest steer at yield");
		});

		await session.prompt("hello");

		expect(streamingAtInject).toBe(true);
		expect(await entryAppended).toBe("guest steer at yield");
		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("drains a steer stranded in the agent queue when the session settles", async () => {
		const { session, sessionManager, mock } = await createSession([
			{ content: ["host answer"] },
			{ content: ["ack guest"] },
		]);
		const entryAppended = nextCollabEntry(sessionManager);

		// Inject from the wire agent_end subscriber: it fires synchronously while
		// the session settles (#promptInFlightCount just hit 0), after the agent
		// loop's final queue poll — a message queued here is invisible to the run
		// and must be picked up by the settle-time drain.
		const secondRunDone = Promise.withResolvers<void>();
		let agentEnds = 0;
		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			agentEnds++;
			if (agentEnds === 1) {
				session.agent.steer({
					role: "custom",
					customType: COLLAB_PROMPT_TYPE,
					content: "guest steer at settle",
					display: true,
					details: { from: "guest" },
					attribution: "user",
					timestamp: Date.now(),
				});
			} else if (agentEnds === 2) {
				secondRunDone.resolve();
			}
		});

		await session.prompt("hello");
		expect(await entryAppended).toBe("guest steer at settle");
		await secondRunDone.promise;

		expect(mock.calls.length).toBe(2);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("drains steering left after aborting an auto-continued queued turn", async () => {
		const { session, mock } = await createSession([
			{ content: ["initial response"] },
			{ content: ["first queued response"], delayMs: 1_000 },
			{ content: ["second queued response"] },
		]);
		await session.prompt("hello");
		expect(mock.calls.length).toBe(1);

		const firstDelivered = nextUserMessage(session, "first queued");
		await session.steer("first queued");
		await firstDelivered;
		expect(mock.calls.length).toBe(2);

		await session.steer("second queued");
		expect(session.getQueuedMessages().steering).toContain("second queued");

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "aborted"),
		).toBe(true);

		expect(mock.calls.length).toBe(3);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	it("dequeuing an ultrathink prompt mid-stream restores the text and drops its companion notice", async () => {
		const { session } = await createSession([{ content: ["host answer"] }]);
		let queuedShape: string[] | undefined;
		let clearedSteering: unknown;
		let hasQueuedAfterClear: boolean | undefined;
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// Real path: a magic-keyword prompt steered mid-stream enqueues the hidden
			// notice immediately before the user message.
			await session.prompt("ultrathink fix it", { streamingBehavior: "steer" });
			queuedShape = session.agent.peekSteeringQueue().map(m => (m.role === "custom" ? m.customType : m.role));
			// Alt+Up restore mid-flight: only the user's text returns; the companion
			// notice must not be left orphaned in the queue.
			const cleared = session.clearQueue();
			clearedSteering = cleared.steering;
			hasQueuedAfterClear = session.agent.hasQueuedMessages();
		});

		await session.prompt("hello");

		expect(queuedShape).toEqual(["ultrathink-notice", "user"]);
		expect(clearedSteering).toEqual([{ text: "ultrathink fix it", images: undefined }]);
		expect(hasQueuedAfterClear).toBe(false);
	});

	it("a fresh user prompt delivers queued steer and follow-up work", async () => {
		const { session } = await createSession([{ content: ["one"] }, { content: ["two"] }, { content: ["three"] }]);
		// Queue real pending work before the user's next send.
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "queued steer" }],
			steering: true,
			attribution: "user",
			timestamp: Date.now(),
		});
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "queued follow-up" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		await session.prompt("hello");
		await session.waitForIdle();

		// Sending a fresh prompt is the opportunity to drain everything: the steer folds
		// into the new turn and the follow-up runs as its continuation — nothing stranded.
		const userTexts = session.agent.state.messages
			.filter(message => message.role === "user")
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join(""),
			);
		expect(userTexts).toContain("hello");
		expect(userTexts).toContain("queued steer");
		expect(userTexts).toContain("queued follow-up");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("resumes a queued steer left behind a non-advisor custom transcript tail", async () => {
		const { session } = await createSession([{ content: ["first answer"] }, { content: ["resumed"] }]);
		await session.prompt("first");
		// A non-advisor custom (e.g. a flushed irc:incoming aside) is the literal transcript tail.
		// A queued steer must resume regardless of tail role — Agent.continue injects it via the
		// initial steering poll — so the old advisor-only look-back can no longer strand it.
		const aside = {
			role: "custom" as const,
			customType: "irc:incoming",
			content: "peer pinged you",
			display: true,
			attribution: "agent" as const,
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_start", message: aside });
		session.agent.emitExternalEvent({ type: "message_end", message: aside });

		const delivered = nextUserMessage(session, "resume me");
		await session.steer("resume me");
		await delivered;
		await session.waitForIdle();

		expect(session.agent.peekSteeringQueue()).toEqual([]);
	});

	it("correlates consumed prompt, steer, and follow-up messages through events and persisted reload without matching text", async () => {
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
		const { session, mock } = await createSession(
			[{ content: ["Initial answer"] }, { content: ["Queued work consumed"] }],
			sessionManager,
		);
		const ended: AgentMessage[] = [];
		session.setSteeringMode("all");
		session.setFollowUpMode("all");
		session.subscribe(event => {
			if (event.type === "message_end") ended.push(structuredClone(event.message));
		});
		const images: ImageContent[] = [
			{
				type: "image",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
				mimeType: "image/png",
			},
		];
		const duplicateText = "  duplicate ultrathink\n";
		const whitespaceText = " \n\t ";
		const queuedIds = ["client-steer", "client-prompt-steer", "client-follow-up", "client-prompt-follow-up"];
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			// Force equal submission timestamps: distinct client IDs, not text or
			// wall-clock precision, must keep duplicate submissions distinct on disk.
			const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
			try {
				await session.steer(duplicateText, undefined, { clientMessageId: queuedIds[0] });
				await session.prompt(duplicateText, { streamingBehavior: "steer", clientMessageId: queuedIds[1] });
				await session.followUp(whitespaceText, images, { clientMessageId: queuedIds[2] });
				await session.prompt(whitespaceText, {
					images,
					streamingBehavior: "followUp",
					clientMessageId: queuedIds[3],
				});
				await session.followUp("internal follow-up", undefined, {
					synthetic: true,
					clientMessageId: "client-hidden",
				});
			} finally {
				clock.mockRestore();
			}
			expect(ended.filter(message => message.role === "user").map(message => message.clientMessageId)).toEqual([
				"client-root",
			]);
		});

		await session.prompt("ultrathink start", { clientMessageId: "client-root" });
		await session.waitForIdle();
		await session.dispose();
		const expectedIds = ["client-root", ...queuedIds];
		const users = ended.filter(message => message.role === "user");
		expect(users.map(message => message.clientMessageId)).toEqual(expectedIds);
		expect(users.slice(1, 3).map(message => message.content)).toEqual([
			[{ type: "text", text: duplicateText }],
			[{ type: "text", text: duplicateText }],
		]);
		for (const message of users.slice(3)) {
			expect(message.content).toEqual([
				{ type: "text", text: whitespaceText },
				expect.objectContaining({ type: "image" }),
			]);
		}
		const companions = ended.filter(
			message => message.role === "custom" && message.customType === "ultrathink-notice",
		);
		expect(companions.some(message => message.role === "custom" && message.display === false)).toBe(true);
		expect(ended.filter(message => message.role !== "user").some(message => "clientMessageId" in message)).toBe(
			false,
		);
		for (const call of mock.calls) {
			const providerContent = JSON.stringify(call.context.messages.map(message => message.content));
			for (const id of expectedIds) expect(providerContent).not.toContain(id);
		}

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const reopened = await SessionManager.open(sessionFile);
		try {
			const persistedUsers = reopened
				.getBranch()
				.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message] : []));
			expect(persistedUsers.map(message => message.clientMessageId)).toEqual(expectedIds);
			expect(persistedUsers.map(message => message.content)).toEqual(users.map(message => message.content));
		} finally {
			await reopened.close();
		}
	});
});
