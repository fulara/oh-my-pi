import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createUserMessage } from "./helpers";

function userTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(message =>
		message.role !== "user"
			? []
			: typeof message.content === "string"
				? [message.content]
				: message.content.filter(part => part.type === "text").map(part => part.text),
	);
}

const isUser = (message: AgentMessage) => message.role === "user";

describe("authoritative pending input", () => {
	it("removes only viewed identities, including identical text and repeated object submissions", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, steeringMode: "all" });
		const message = createUserMessage("same text");
		agent.steer(message);
		agent.steer(message);
		const viewed = agent.getPendingMessages();
		expect(new Set(viewed.map(item => item.id)).size).toBe(2);
		agent.steer(createUserMessage("later arrival"));
		const results = agent.removePendingMessages([viewed[0].id, "unknown"], isUser);
		expect(results.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
			{ id: viewed[0].id, outcome: "removed" },
			{ id: "unknown", outcome: "notFound" },
		]);
		expect(agent.getPendingMessages().map(item => item.id)).toContain(viewed[1].id);
		expect(agent.removePendingMessages([viewed[0].id], isUser)[0].outcome).toBe("notFound");
		await agent.continue();
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["same text", "later arrival"]);
		expect(agent.removePendingMessages([viewed[1].id], isUser)[0].outcome).toBe("tooLate");
	});

	it("removes owned hidden companions while retaining unrelated internal work and another user's companions", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, steeringMode: "all" });
		const removedCompanion: AgentMessage = { role: "developer", content: "removed image description", timestamp: 1 };
		const keptCompanion: AgentMessage = { role: "developer", content: "kept image description", timestamp: 2 };
		const internal: AgentMessage = { role: "developer", content: "internal work", timestamp: 3 };
		agent.steer(createUserMessage("remove"), { companions: [removedCompanion] });
		agent.steer(internal);
		agent.steer(createUserMessage("keep"), { companions: [keptCompanion] });
		const pending = agent.getPendingMessages();
		const removed = pending.find(item => userTexts([item.message])[0] === "remove")!;
		const protectedInternal = pending.find(item => item.message === internal)!;
		expect(
			agent.removePendingMessages([removed.id, protectedInternal.id], isUser).map(result => result.outcome),
		).toEqual(["removed", "notFound"]);
		await agent.continue();
		expect(agent.state.messages).not.toContain(removedCompanion);
		expect(agent.state.messages).toContain(keptCompanion);
		expect(agent.state.messages).toContain(internal);
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["keep"]);
	});

	it("cancels a preparation race without committing removed input or cancelling retained work", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, steeringMode: "all" });
		const started = Promise.withResolvers<AbortSignal>();
		const stalePreparation = Promise.withResolvers<void>();
		let firstPreparation = true;
		let staleCommits = 0;
		agent.prepareQueuedMessages = async (_messages, signal) => {
			if (!firstPreparation) return { commit: () => [] };
			firstPreparation = false;
			started.resolve(signal);
			await stalePreparation.promise;
			return {
				commit: () => {
					staleCommits++;
					return [createUserMessage("stale context")];
				},
			};
		};
		agent.steer(createUserMessage("remove before claim"));
		agent.steer(createUserMessage("keep in batch"));
		agent.followUp(createUserMessage("keep other queue"));
		const viewed = agent.getPendingMessages();
		const running = agent.continue();
		const signal = await started.promise;
		expect(agent.getPendingMessages().find(item => item.id === viewed[0].id)?.removable).toBe(true);
		agent.removePendingMessages([viewed[0].id], isUser);
		expect(signal.aborted).toBe(true);
		await running;
		stalePreparation.resolve();
		await Promise.resolve();
		expect(staleCommits).toBe(0);
		expect(userTexts(mock.calls.at(-1)!.context.messages)).toEqual(["keep in batch", "keep other queue"]);
	});

	it("removing the last input during preprocessing settles its idle drain without a model call or error", async () => {
		const mock = createMockModel({ handler: { content: ["must not run"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		agent.followUp(createUserMessage("remove last"), {
			prepare: async signal => {
				started.resolve(signal);
				await release.promise;
				return { message: createUserMessage("late") };
			},
		});
		const id = agent.getPendingMessages()[0].id;
		const running = agent.continue();
		const signal = await started.promise;
		expect(agent.removePendingMessages([id], isUser)[0].outcome).toBe("removed");
		expect(signal.aborted).toBe(true);
		await running;
		release.resolve();
		await Promise.resolve();
		expect(mock.calls).toEqual([]);
		expect(agent.state.messages).toEqual([]);
		expect(agent.state.error).toBeUndefined();
	});

	it("does not cancel or repeat another input's normalization when removing its batch peer", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model }, steeringMode: "all" });
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		let preparations = 0;
		agent.steer(createUserMessage("keep"), {
			prepare: async signal => {
				preparations++;
				started.resolve(signal);
				await release.promise;
				return { message: createUserMessage("normalized keep") };
			},
		});
		agent.steer(createUserMessage("remove peer"));
		const removedId = agent.getPendingMessages()[1].id;
		const running = agent.continue();
		const signal = await started.promise;
		agent.removePendingMessages([removedId], isUser);
		expect(signal.aborted).toBe(false);
		release.resolve();
		await running;
		expect(preparations).toBe(1);
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["normalized keep"]);
	});

	it("preserves identity and original preview across asynchronous preprocessing", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		agent.steer(createUserMessage("original"), {
			preview: { text: "full submitted text", clientMessageId: "client-1" },
			prepare: async () => {
				started.resolve();
				await release.promise;
				return { message: createUserMessage("normalized") };
			},
		});
		const original = agent.getPendingMessages()[0];
		let preparedIdentity: string | undefined;
		agent.prepareQueuedMessages = () => {
			const prepared = agent.getPendingMessages()[0];
			preparedIdentity = prepared.id;
			expect(prepared.preview).toEqual({ text: "full submitted text", clientMessageId: "client-1" });
			return { commit: () => [] };
		};
		const running = agent.continue();
		await started.promise;
		expect(agent.getPendingMessages()[0].id).toBe(original.id);
		release.resolve();
		await running;
		expect(preparedIdentity).toBe(original.id);
		expect(userTexts(mock.calls[0].context.messages)).toEqual(["normalized"]);
		expect(agent.removePendingMessages([original.id], isUser)[0].outcome).toBe("tooLate");
	});

	it("removing a later preparation never drops an already-dequeued delivery", async () => {
		const mock = createMockModel({ handler: { content: ["done"] } });
		const agent = new Agent({ streamFn: mock.stream, initialState: { model: mock.model } });
		const preparing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const steering = createUserMessage("claimed earlier");
		const followUp = createUserMessage("remove later");
		agent.setOnBeforeYield(() => {
			agent.setOnBeforeYield(undefined);
			agent.steer(steering);
			agent.followUp(followUp);
		});
		agent.prepareQueuedMessages = async messages => {
			if (messages.includes(followUp)) {
				preparing.resolve();
				await release.promise;
			}
			return { commit: () => [] };
		};
		const running = agent.prompt("ordinary");
		await preparing.promise;
		const pending = agent.getPendingMessages();
		const claimed = pending.find(item => item.message === steering)!;
		const removable = pending.find(item => item.message === followUp)!;
		expect(claimed).toMatchObject({ state: "claimed", removable: false });
		expect(agent.removePendingMessages([claimed.id, removable.id], isUser).map(result => result.outcome)).toEqual([
			"tooLate",
			"removed",
		]);
		release.resolve();
		await running;
		expect(userTexts(mock.calls.at(-1)!.context.messages)).toEqual(["ordinary", "claimed earlier"]);
	});

	it.each([false, true])(
		"never offers provider-taken input for removal after abort requeue (accepted=%s)",
		async accepted => {
			const claimed = Promise.withResolvers<void>();
			const agent = new Agent({
				streamFn: async (_model, _context, options) => {
					const live = options?.liveSteering;
					const signal = options?.signal;
					if (!live || !signal) throw new Error("Missing live steering");
					const stream = new AssistantMessageEventStream();
					signal.addEventListener("abort", () => stream.fail(new Error("aborted")), { once: true });
					await live.wait(signal);
					const claim = await live.claim(signal);
					if (!claim) throw new Error("Missing claim");
					if (accepted) claim.accept();
					claimed.resolve();
					return stream;
				},
			});
			const running = agent.prompt("ordinary");
			agent.steer(createUserMessage("provider-owned"));
			const id = agent.getPendingMessages()[0].id;
			await claimed.promise;
			expect(agent.getPendingMessages()[0]).toMatchObject({ id, state: "claimed", removable: false });
			expect(agent.removePendingMessages([id], isUser)[0].outcome).toBe("tooLate");
			agent.abort();
			await running;
			expect(agent.getPendingMessages()[0]).toMatchObject({ id, state: "claimed", removable: false });
			expect(agent.removePendingMessages([id], isUser)[0].outcome).toBe("tooLate");
			expect(userTexts(agent.peekSteeringQueue())).toEqual(["provider-owned"]);
		},
	);
});
