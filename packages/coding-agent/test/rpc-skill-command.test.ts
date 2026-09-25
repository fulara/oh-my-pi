import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSkillPromptMessage } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { dispatchRpcSkillPrompt, runRpcSkillCommand, tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	convertToLlm,
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const RED_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const BLUE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

async function attachmentImage(data: string): Promise<ImageContent> {
	// Stay inside the model's no-resize bounds so byte/order loss is observable.
	const bytes = await new Bun.Image(Buffer.from(data, "base64")).resize(200, 200, { filter: "nearest" }).png().bytes();
	return { type: "image", mimeType: "image/png", data: Buffer.from(bytes).toBase64() };
}

describe("tryRunRpcSkillCommand", () => {
	test("dispatches registered /skill commands as skill prompt messages", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let message: Pick<CustomMessage, "attribution" | "content" | "customType" | "details" | "display"> | undefined;
		let options: { streamingBehavior?: "steer" | "followUp" | "aside" } | undefined;

		const handled = await tryRunRpcSkillCommand(
			{
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				async promptCustomMessage(nextMessage: typeof message, nextOptions?: typeof options) {
					message = nextMessage;
					options = nextOptions;
					return true;
				},
			},
			"/skill:reviewer focus on risks",
		);

		expect(handled).toEqual({ agentInvoked: true });
		expect(message?.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(message?.content).toContain("Review the supplied code carefully.");
		expect(message?.content).toContain(`[Skill directory: ${dir}]`);
		expect(message?.content).toContain("focus on risks");
		expect(message?.display).toBe(true);
		expect(message?.attribution).toBe("user");
		expect(options).toEqual({ streamingBehavior: "steer" });

		await removeWithRetries(dir);
	});

	test("honors the RPC prompt streaming behavior for registered /skill commands", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let options: { streamingBehavior?: "steer" | "followUp" | "aside" } | undefined;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage(nextMessage, nextOptions) {
						expect(nextMessage.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
						options = nextOptions;
						return true;
					},
				},
				"/skill:reviewer wait for the current turn",
				"followUp",
			);

			expect(handled).toEqual({ agentInvoked: true });
			expect(options?.streamingBehavior).toBe("followUp");
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("ignores unknown skill commands so normal prompt handling can continue", async () => {
		const handled = await tryRunRpcSkillCommand(
			{
				skillsSettings: { enableSkillCommands: true },
				skills: [],
				async promptCustomMessage() {
					throw new Error("should not dispatch unknown skills");
				},
			},
			"/skill:missing",
		);

		expect(handled).toBe(false);
	});

	test("does not steal builtin slash-command arguments that mention registered skills", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let dispatched = false;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage() {
						dispatched = true;
						return true;
					},
				},
				"/compact /skill:reviewer",
			);

			expect(handled).toBe(false);
			expect(dispatched).toBe(false);
		} finally {
			await removeWithRetries(dir);
		}
	});
});

async function settleUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	if (!condition()) throw new Error("condition not met while settling");
}

/** Prompt-result plumbing for an idle session; frames land in `frames`. */
function promptResultsFor(id: string, frames: object[] = []) {
	const results = new RpcPromptResults(
		{ isStreaming: false, hasAdmittedSubmission: false, queuedMessageCount: 0, hasPendingAsyncWork: () => false },
		frame => frames.push(frame),
	);
	return { ticket: results.begin(id), results };
}

describe("dispatchRpcSkillPrompt", () => {
	test("answers the prompt command before the skill dispatch completes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		const dispatchGate = Promise.withResolvers<void>();
		let promptCustomMessageCalls = 0;
		const result = await dispatchRpcSkillPrompt({
			...promptResultsFor("cmd-1"),
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				async promptCustomMessage() {
					promptCustomMessageCalls += 1;
					await dispatchGate.promise;
					return true;
				},
			},
			message: "/skill:reviewer go",
			streamingBehavior: undefined,
			onError: () => {},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});

		// The answer does not wait for the dispatch pipeline: with the gate
		// closed, awaiting the pipeline (usage preflight, compaction, provider
		// calls) would hang this call forever — it returns regardless.
		expect(result).toEqual({ agentInvoked: true });

		dispatchGate.resolve();
		await settleUntil(() => promptCustomMessageCalls === 1);
		expect(promptCustomMessageCalls).toBe(1);

		await removeWithRetries(dir);
	});

	test("returns null for non-skill messages", async () => {
		const result = await dispatchRpcSkillPrompt({
			...promptResultsFor("cmd-2"),
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [],
				async promptCustomMessage() {
					return true;
				},
			},
			message: "just a normal prompt",
			streamingBehavior: undefined,
			onError: () => {},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});
		expect(result).toBeNull();
	});

	test("a late dispatch failure surfaces through onError, not the answer", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nBody.\n");

		const errors: Error[] = [];
		await dispatchRpcSkillPrompt({
			...promptResultsFor("cmd-3"),
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				async promptCustomMessage() {
					throw new Error("dispatch pipeline exploded");
				},
			},
			message: "/skill:reviewer go",
			streamingBehavior: undefined,
			onError: error => errors.push(error),
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});

		await settleUntil(() => errors.length === 1);
		expect(errors.map(error => error.message)).toEqual(["dispatch pipeline exploded"]);

		await removeWithRetries(dir);
	});

	test("rejects before answering when the skill file cannot be read", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const missingSkillPath = path.join(dir, "SKILL.md");

		let promptCustomMessageCalls = 0;
		await expect(
			dispatchRpcSkillPrompt({
				...promptResultsFor("cmd-4"),
				session: {
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: missingSkillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage() {
						promptCustomMessageCalls += 1;
						return true;
					},
				},
				message: "/skill:reviewer go",
				streamingBehavior: undefined,
				onError: () => {},
				extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
			}),
		).rejects.toThrow();
		expect(promptCustomMessageCalls).toBe(0);

		await removeWithRetries(dir);
	});

	test("emits a non-invoked completion frame when the dispatch bails before the turn starts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nBody.\n");

		const frames: object[] = [];
		const result = await dispatchRpcSkillPrompt({
			...promptResultsFor("cmd-5", frames),
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				// Simulates the abort-overtakes-preflight race: promptCustomMessage
				// bails before agent.prompt() runs, so no agent_end is ever emitted.
				async promptCustomMessage() {
					return false;
				},
			},
			message: "/skill:reviewer go",
			streamingBehavior: undefined,
			onError: () => {},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});

		expect(result).toEqual({ agentInvoked: true });
		await settleUntil(() => frames.length === 1);
		expect(frames).toEqual([
			{ type: "prompt_result", id: "cmd-5", agentInvoked: false, status: "completed", sessionSettled: true },
		]);

		await removeWithRetries(dir);
	});

	test("persists exact client identities for consumed embedded skill prompts and duplicate queued skills", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-identity-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n");
		const images = await Promise.all([
			attachmentImage(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
			),
			attachmentImage(RED_PNG_BASE64),
		]);
		const skill = {
			name: "reviewer",
			description: "Review code",
			filePath: skillPath,
			baseDir: dir,
			source: "project",
		};
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: ["Initial answer"] }, { content: ["Queued work consumed"] }],
		});
		const sessionManager = SessionManager.create(dir, path.join(dir, "sessions"));
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(dir, "models.yml")),
			skills: [skill],
			skillsSettings: { enableSkillCommands: true },
		});
		session.setSteeringMode("all");
		session.setFollowUpMode("all");
		const consumed: CustomMessage<SkillPromptDetails>[] = [];
		const errors: Error[] = [];
		session.subscribe(event => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === SKILL_PROMPT_MESSAGE_TYPE
			) {
				consumed.push(structuredClone(event.message) as CustomMessage<SkillPromptDetails>);
			}
		});
		const dispatch = (clientMessageId: string, streamingBehavior: "steer" | "followUp") =>
			dispatchRpcSkillPrompt({
				id: `rpc-${clientMessageId}`,
				clientMessageId,
				session,
				message: "fix this /skill:reviewer",
				images,
				streamingBehavior,
				output: () => {},
				onError: error => errors.push(error),
				extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
			});
		const prebuilt = await buildSkillPromptMessage(skill, { args: "fix this" }, "user");
		prebuilt.details.clientMessageId = "untrusted-source-id";
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
			try {
				await dispatch("client-steer", "steer");
				// ACK is not queue admission: images normalize asynchronously.
				await settleUntil(() =>
					session.agent
						.peekSteeringQueue()
						.some(message => message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE),
				);
				await dispatch("client-follow-up", "followUp");
				// Source/prebuilt metadata cannot override runtime correlation or
				// claim an identity when the caller supplied none.
				await runRpcSkillCommand(session, { skill, args: "fix this" }, "steer", prebuilt, "runtime-id");
				await runRpcSkillCommand(session, { skill, args: "fix this" }, "steer", prebuilt);
			} finally {
				clock.mockRestore();
			}
			// The RPC acknowledgement precedes async queue preparation. Wait for
			// that preparation, while keeping the loop blocked before consumption.
			await settleUntil(
				() =>
					[...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue()].filter(
						message => message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE,
					).length === 4,
			);
			expect(consumed.map(message => message.details?.clientMessageId)).toEqual(["client-root"]);
		});
		try {
			await dispatch("client-root", "steer");
			await settleUntil(() => consumed.length === 5 || errors.length > 0);
			await session.waitForIdle();
			await session.dispose();
			expect(errors).toEqual([]);
			const expectedIds = ["client-root", "client-steer", "runtime-id", undefined, "client-follow-up"];
			expect(consumed.map(message => message.details?.clientMessageId)).toEqual(expectedIds);
			for (const message of consumed.filter(message =>
				["client-root", "client-steer", "client-follow-up"].includes(message.details?.clientMessageId ?? ""),
			)) {
				expect(Array.isArray(message.content)).toBe(true);
				if (typeof message.content === "string") throw new Error("RPC skill dropped image attachments");
				expect(message.content.filter(block => block.type === "image")).toEqual(images);
				expect(message.content[0]?.type).toBe("text");
			}
			const firstUserMessage = mock.calls[0]?.context.messages.find(message => message.role === "user");
			if (!firstUserMessage || typeof firstUserMessage.content === "string") {
				throw new Error("Provider request omitted the skill image content");
			}
			expect(firstUserMessage.content.filter(block => block.type === "image")).toEqual(images);
			for (const message of consumed) {
				expect(message.display).toBe(true);
				expect(message.attribution).toBe("user");
				expect(message.details?.args).toBe("fix this");
				expect(message.content).not.toContain("untrusted-source-id");
			}
			const steer = consumed.find(message => message.details?.clientMessageId === "client-steer")!;
			const followUp = consumed.find(message => message.details?.clientMessageId === "client-follow-up")!;
			expect(steer.timestamp).toBe(followUp.timestamp);
			expect(steer.content).toEqual(followUp.content);
			for (const call of mock.calls) {
				const providerContent = JSON.stringify(call.context.messages.map(message => message.content));
				for (const id of [...expectedIds, "untrusted-source-id"]) {
					if (id !== undefined) expect(providerContent).not.toContain(id);
				}
			}
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			const reopened = await SessionManager.open(sessionFile);
			try {
				const entries = reopened
					.getBranch()
					.flatMap(entry =>
						entry.type === "custom_message" && entry.customType === SKILL_PROMPT_MESSAGE_TYPE ? [entry] : [],
					);
				expect(entries.map(entry => (entry.details as SkillPromptDetails).clientMessageId)).toEqual(expectedIds);
				expect(entries.map(entry => entry.content)).toEqual(consumed.map(message => message.content));
			} finally {
				await reopened.close();
			}
		} finally {
			await session.dispose();
			authStorage.close();
			await removeWithRetries(dir);
		}
	});
});

describe("RPC skill attachment reads after idle", () => {
	let dir: string;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let mock: MockModel;
	let readTool: ReadTool;
	let red: ImageContent;
	let blue: ImageContent;
	let errors: Error[];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-attachments-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review images\n---\n\nInspect the supplied images.\n",
		);
		[red, blue] = await Promise.all([attachmentImage(RED_PNG_BASE64), attachmentImage(BLUE_PNG_BASE64)]);
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		mock = createMockModel({ handler: { content: ["Done"] } });
		errors = [];
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"images.autoResize": false,
			"images.describeForTextModels": false,
		});
		const sessionManager = SessionManager.create(dir, path.join(dir, "sessions"));
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(dir, "models.yml")),
			skills: [
				{ name: "reviewer", description: "Review images", filePath: skillPath, baseDir: dir, source: "project" },
			],
			skillsSettings: { enableSkillCommands: true },
		});
		readTool = new ReadTool({
			cwd: dir,
			hasUI: false,
			settings,
			sessionManager,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			getActiveModel: () => model,
			getImageAttachments: () => session.getImageAttachments(),
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await removeWithRetries(dir);
	});

	async function dispatch(images?: ImageContent[]): Promise<void> {
		const previousCalls = mock.calls.length;
		expect(
			await dispatchRpcSkillPrompt({
				id: `attachment-${previousCalls}`,
				session,
				message: "/skill:reviewer inspect",
				images,
				streamingBehavior: undefined,
				output: () => {},
				onError: error => errors.push(error),
				extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
			}),
		).toEqual({ agentInvoked: true });
		// The RPC acknowledgement precedes dispatch. Do not mistake it for idle.
		await settleUntil(() => mock.calls.length > previousCalls || errors.length > 0);
		await session.waitForIdle();
		expect(errors).toEqual([]);
	}

	function expectLatestProviderImages(expected: ImageContent[]): void {
		const call = mock.calls.at(-1);
		if (!call) throw new Error("Expected a controlled provider call");
		const imageGroups = call.context.messages.flatMap(message => {
			if (!Array.isArray(message.content)) return [];
			const images = message.content.filter(block => block.type === "image");
			return images.length > 0 ? [images] : [];
		});
		expect(imageGroups.at(-1) ?? []).toEqual(expected);
	}

	async function expectAttachmentReads(expected: ImageContent[]): Promise<void> {
		await session.waitForIdle();
		for (const [index, image] of expected.entries()) {
			const result = await readTool.execute(`read-${index}`, { path: `attachment://${index + 1}` });
			expect(result.content.filter(block => block.type === "image")).toEqual([image]);
		}
		await expect(
			readTool.execute("read-unavailable", { path: `attachment://${expected.length + 1}` }),
		).rejects.toThrow("Could not resolve image attachment");
	}

	test("reads a fresh BLUE RPC skill image after idle", async () => {
		await dispatch([blue]);
		expectLatestProviderImages([blue]);
		await expectAttachmentReads([blue]);
	});

	test("reads BLUE from the latest skill instead of an older ordinary RED image", async () => {
		await session.prompt("Inspect red", { images: [red] });
		await session.waitForIdle();
		expectLatestProviderImages([red]);
		await expectAttachmentReads([red]);
		await dispatch([blue]);
		expectLatestProviderImages([blue]);
		await expectAttachmentReads([blue]);
	});

	test.each(["user", "developer"] as const)("preserves ordinary %s image attachments", async role => {
		await dispatch([blue]);
		await session.prompt("Inspect red", { images: [red], synthetic: role === "developer" });
		await session.waitForIdle();
		expectLatestProviderImages([red]);
		await expectAttachmentReads([red]);
	});

	test("preserves multiple skill image order across later text-only prompts", async () => {
		await dispatch([blue, red]);
		expectLatestProviderImages([blue, red]);
		await expectAttachmentReads([blue, red]);
		await dispatch();
		await session.prompt("Continue without another image");
		await session.waitForIdle();
		expectLatestProviderImages([blue, red]);
		await expectAttachmentReads([blue, red]);
	});

	test.each([
		{ name: "hidden user skill", customType: SKILL_PROMPT_MESSAGE_TYPE, display: false, attribution: "user" },
		{ name: "autoload skill", customType: SKILL_PROMPT_MESSAGE_TYPE, display: false, attribution: "agent" },
		{ name: "visible agent skill", customType: SKILL_PROMPT_MESSAGE_TYPE, display: true, attribution: "agent" },
		{ name: "unattributed skill", customType: SKILL_PROMPT_MESSAGE_TYPE, display: true, attribution: undefined },
		{ name: "unrelated visible custom", customType: "test-injection", display: true, attribution: "user" },
	] as const)("excludes $name images from attachment reads", async ({ name: _name, ...message }) => {
		const injection = {
			...message,
			content: [{ type: "text" as const, text: "/skill:reviewer inspect this image" }, red],
		};
		await session.promptCustomMessage(injection);
		await session.waitForIdle();
		// These images may reach provider context, but are not user attachments.
		expectLatestProviderImages([red]);
		await expectAttachmentReads([]);
		await dispatch([blue]);
		await session.promptCustomMessage(injection);
		await session.waitForIdle();
		expectLatestProviderImages([red]);
		await expectAttachmentReads([blue]);
	});
});
