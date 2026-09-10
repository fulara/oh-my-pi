import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSkillPromptMessage } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import {
	dispatchRpcSkillPrompt,
	RpcExtensionUserMessageTracker,
	runRpcSkillCommand,
	tryRunRpcSkillCommand,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

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
			id: "cmd-1",
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
			output: () => {},
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
			id: "cmd-2",
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [],
				async promptCustomMessage() {
					return true;
				},
			},
			message: "just a normal prompt",
			streamingBehavior: undefined,
			output: () => {},
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
			id: "cmd-3",
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
			output: () => {},
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
				id: "cmd-4",
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
				output: () => {},
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
			id: "cmd-5",
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
			output: frame => frames.push(frame),
			onError: () => {},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});

		expect(result).toEqual({ agentInvoked: true });
		await settleUntil(() => frames.length === 1);
		expect(frames).toEqual([{ type: "prompt_result", id: "cmd-5", agentInvoked: false }]);

		await removeWithRetries(dir);
	});

	test("persists exact client identities for consumed embedded skill prompts and duplicate queued skills", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-identity-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code.\n");
		const skill = {
			name: "reviewer",
			description: "Review code",
			filePath: skillPath,
			baseDir: dir,
			source: "project",
		};
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
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
				streamingBehavior,
				output: () => {},
				onError: error => errors.push(error),
				extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
			});
		const prebuilt = await buildSkillPromptMessage(skill, "fix this", "user");
		prebuilt.details.clientMessageId = "untrusted-source-id";
		let injected = false;
		session.agent.setOnBeforeYield(async () => {
			if (injected) return;
			injected = true;
			const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
			try {
				await dispatch("client-steer", "steer");
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
