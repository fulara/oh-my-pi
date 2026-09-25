import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { RpcActivity, type RpcActivitySession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-activity";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(ownerId: string | null = "Main") {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-activity-"));
	cleanups.push(() => fs.rm(cwd, { recursive: true, force: true }));
	const manager = new AsyncJobManager({ retentionMs: 300_000 });
	cleanups.push(async () => {
		await manager.dispose();
	});
	const transitions = new Set<(phase: "begin" | "end") => void>();
	let journalSessionId = "session-a";
	const session: RpcActivitySession = {
		sessionId: "session-a",
		asyncJobManager: manager,
		sessionManager: { getCwd: () => cwd, getSessionId: () => journalSessionId },
		getAgentId: () => ownerId ?? undefined,
		subscribeSessionTransition: listener => {
			transitions.add(listener);
			return () => {
				transitions.delete(listener);
			};
		},
	};
	const bus = new EventBus();
	const registry = new RpcSubagentRegistry(bus, () => {});
	cleanups.push(() => registry.dispose());
	const activity = new RpcActivity(session, registry);
	cleanups.push(() => activity.dispose());
	return {
		manager,
		session,
		activity,
		bus,
		registry,
		transition(next: string, journalId = next) {
			for (const listener of transitions) listener("begin");
			journalSessionId = journalId;
			Object.assign(session, { sessionId: next });
			for (const listener of transitions) listener("end");
		},
	};
}

function started(id: string, parentSessionId: string, sessionId = `${id}-session`): SubagentLifecyclePayload {
	return {
		id,
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		parentSessionId,
		sessionId,
		parentToolCallId: `call-${id}`,
	};
}

describe("passive RPC activity", () => {
	test("scopes jobs to logical session and owner; detail never consumes delivery", async () => {
		const { manager, activity } = await fixture();
		const own = manager.register("bash", "Build", async () => "built", { ownerId: "Main", toolCallId: "call-build" });
		manager.register("bash", "Foreign session", async () => "foreign secret", {
			ownerId: "Main",
			ownerSessionId: "session-b",
		});
		manager.register("bash", "Foreign owner", async () => "foreign peer", {
			ownerId: "Other",
			ownerSessionId: "session-a",
		});
		manager.register("bash", "Unproven legacy", async () => "legacy", { ownerId: "Main", ownerSessionId: null });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		const before = manager.getDeliveryState({ ownerId: "Main" });
		const snapshot = await activity.snapshot("session-a");
		expect(snapshot.items.map(item => item.id)).toEqual([own]);
		expect(snapshot.items[0]).toMatchObject({ status: "completed", toolCallId: "call-build", detailAvailable: true });
		expect((await activity.detail("session-a", snapshot.generation, "job", own)).text).toBe("built");
		expect(manager.isJobResultConsumed(own)).toBe(false);
		expect(manager.getDeliveryState({ ownerId: "Main" })).toEqual(before);
		expect(snapshot.sources.services.available).toBe(false);
	});

	test("missing owner fails closed instead of falling back to global jobs", async () => {
		const { manager, activity } = await fixture(null);
		manager.register("bash", "Private", async () => "private", { ownerId: "Main", ownerSessionId: "session-a" });
		await manager.waitForAll();
		const snapshot = await activity.snapshot("session-a");
		expect(snapshot.items).toEqual([]);
		expect(snapshot.sources.jobs.available).toBe(false);
	});

	test("retains fast terminal output without interfering with the original sink", async () => {
		const { manager, activity } = await fixture();
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const id = manager.register("bash", "Fast", async () => "normal completion", { ownerId: "Main" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		const snapshot = await activity.snapshot("session-a");
		expect(delivered).toEqual(["normal completion"]);
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect((await activity.detail("session-a", snapshot.generation, "job", id)).text).toBe("normal completion");
		expect(delivered).toEqual(["normal completion"]);
	});

	test("keeps bounded completion detail after normal manager eviction", async () => {
		const { manager, activity } = await fixture();
		const id = manager.register("bash", "Brief", async () => "retained completion", { ownerId: "Main" });
		await manager.waitForAll();
		manager.evictCompletedJobs({ ownerId: "Main" });
		const snapshot = await activity.snapshot("session-a");
		expect(manager.getJob(id)).toBeUndefined();
		expect(snapshot.items.map(item => item.id)).toEqual([id]);
		expect((await activity.detail("session-a", snapshot.generation, "job", id)).text).toBe("retained completion");
	});

	test("wire routing identity can rotate without changing durable ownership", async () => {
		const { manager, activity, transition } = await fixture();
		const id = manager.register("bash", "Durable", async () => "journal-owned", { ownerId: "Main" });
		await manager.waitForAll();
		const previous = await activity.snapshot("session-a");
		transition("provider-b", "session-a");
		const snapshot = await activity.snapshot("provider-b");
		expect(snapshot.sessionId).toBe("provider-b");
		expect(snapshot.generation).not.toBe(previous.generation);
		expect(snapshot.items.map(item => item.id)).toEqual([id]);
		expect(manager.getJob(id)?.ownerSessionId).toBe("session-a");
		await expect(activity.snapshot("session-a")).rejects.toThrow("logical session");
		await expect(activity.detail("provider-b", previous.generation, "job", id)).rejects.toThrow("generation");
	});

	test("bounds details by UTF-8 bytes and lines, omitting raw image and metadata objects", async () => {
		const { manager, activity } = await fixture();
		const output = Array.from({ length: 240 }, (_, i) => `${i} ${"漢🙂".repeat(300)}`).join("\n");
		const id = manager.register(
			"eval",
			"Unicode",
			async ({ reportProgress }) => {
				await reportProgress("progress", {
					output,
					images: [{ type: "image", mimeType: "image/png", data: "private-image" }],
					secret: "not-public",
				});
				return output;
			},
			{ ownerId: "Main" },
		);
		await manager.waitForAll();
		const snapshot = await activity.snapshot("session-a");
		const detail = await activity.detail("session-a", snapshot.generation, "job", id);
		expect(detail.truncated).toBe(true);
		expect(Buffer.byteLength(detail.text)).toBeLessThanOrEqual(65_536);
		expect(detail.text.split("\n").length).toBeLessThanOrEqual(200);
		expect(detail.text).not.toContain("�");
		expect(detail.text.endsWith("漢🙂")).toBe(true);
		expect(JSON.stringify({ snapshot, detail })).not.toContain("private-image");
		expect(JSON.stringify({ snapshot, detail })).not.toContain("not-public");
	});

	test("shows promotion and queue state without revealing foreground rows", async () => {
		const { manager, activity } = await fixture();
		const finish = Promise.withResolvers<string>();
		let markRunning = () => {};
		const id = manager.register(
			"bash",
			"Queued",
			async context => {
				markRunning = context.markRunning;
				return finish.promise;
			},
			{ ownerId: "Main", foreground: true, queued: true },
		);
		expect((await activity.snapshot("session-a")).items).toEqual([]);
		manager.backgroundJob(id);
		expect((await activity.snapshot("session-a")).items[0]).toMatchObject({ id, status: "running", queued: true });
		markRunning();
		expect((await activity.snapshot("session-a")).items[0]?.queued).toBe(false);
		finish.resolve("finished");
		await manager.waitForAll();
	});

	test("rejects stale generations and late old-session completions", async () => {
		const { manager, activity, transition } = await fixture();
		const finish = Promise.withResolvers<string>();
		const old = manager.register("bash", "Old", async () => finish.promise, { ownerId: "Main" });
		const previous = await activity.snapshot("session-a");
		transition("session-b");
		finish.resolve("old private output");
		await manager.waitForAll();
		const next = manager.register("bash", "New", async () => "new output", { ownerId: "Main" });
		await manager.waitForAll();
		const current = await activity.snapshot("session-b");
		expect(current.generation).not.toBe(previous.generation);
		expect(current.items.map(item => item.id)).toEqual([next]);
		expect(manager.getJob(old)?.ownerSessionId).toBe("session-a");
		await expect(activity.detail("session-a", previous.generation, "job", old)).rejects.toThrow();
		await expect(activity.detail("session-b", previous.generation, "job", next)).rejects.toThrow("generation");
		await expect(activity.detail("session-b", current.generation, "job", old)).rejects.toThrow("unavailable");
	});

	test("authorizes root descendants, isolates foreign buses, and deduplicates job agent IDs", async () => {
		const { manager, activity, bus, transition } = await fixture();
		const otherBus = new EventBus();
		otherBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("ForeignRoot", "session-a"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("Parent", "session-a"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("Child", "Parent-session"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("ForeignSession", "session-b"));
		const finish = Promise.withResolvers<string>();
		const id = manager.register("task", "Parent task", async () => finish.promise, {
			id: "different-job-id",
			agentId: "Parent",
			ownerId: "Main",
		});
		const snapshot = await activity.snapshot("session-a");
		expect(snapshot.items.map(item => item.id).sort()).toEqual(["Child", id].sort());
		transition("session-b");
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("LateOldStart", "session-a"));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, started("LateOldChild", "Parent-session"));
		expect((await activity.snapshot("session-b")).items).toEqual([]);
		finish.resolve("done");
		await manager.waitForAll();
	});

	test("deduplicated task jobs retain live agent detail without borrowing terminal or later wake output", async () => {
		const { manager, activity, bus } = await fixture();
		const start = started("Worker", "session-a");
		const finish = Promise.withResolvers<string>();
		const id = manager.register("task", "Live task", async () => finish.promise, {
			ownerId: "Main",
			agentId: "Worker",
			toolCallId: start.parentToolCallId,
		});
		const progress = (recentOutput: string[]): void => {
			bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				agent: "task",
				agentSource: "bundled",
				task: "work",
				parentToolCallId: start.parentToolCallId,
				progress: {
					id: "Worker",
					index: 0,
					agent: "task",
					agentSource: "bundled",
					status: "running",
					task: "work",
					recentTools: [],
					recentOutput,
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 2,
				},
			} satisfies SubagentProgressPayload);
		};
		try {
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, start);
			progress(["second line", "first line"]);
			const live = await activity.snapshot("session-a");
			expect(live.items.map(item => [item.kind, item.id, item.detailAvailable])).toEqual([["job", id, true]]);
			expect((await activity.detail("session-a", live.generation, "job", id)).text).toBe("first line\nsecond line");

			progress(["漢🙂".repeat(20_000)]);
			const bounded = await activity.detail("session-a", live.generation, "job", id);
			expect(bounded.truncated).toBe(true);
			expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(65_536);
			expect(bounded.text).not.toContain("�");

			finish.resolve("final task result");
			await manager.waitForAll();
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				...start,
				status: "completed",
			} satisfies SubagentLifecyclePayload);
			expect((await activity.detail("session-a", live.generation, "job", id)).text).toBe("final task result");

			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...start, parentSessionId: undefined });
			const wake = await activity.snapshot("session-a");
			expect(wake.items.find(item => item.kind === "agent")).toMatchObject({ id: "Worker", detailAvailable: false });
			await expect(activity.detail("session-a", wake.generation, "agent", "Worker")).rejects.toThrow(
				"not available",
			);
			progress(["new wake output"]);
			expect((await activity.detail("session-a", wake.generation, "agent", "Worker")).text).toBe("new wake output");
			expect((await activity.detail("session-a", wake.generation, "job", id)).text).toBe("final task result");
		} finally {
			finish.resolve("cleanup");
			await manager.waitForAll();
		}
	});

	test("an agent wake remains visible beside its previous completed task job", async () => {
		const { manager, activity, bus } = await fixture();
		const start = started("Worker", "session-a");
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, start);
		const id = manager.register("task", "First turn", async () => "first result", {
			ownerId: "Main",
			agentId: "Worker",
		});
		await manager.waitForAll();
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...start, status: "completed" } satisfies SubagentLifecyclePayload);
		expect((await activity.snapshot("session-a")).items.map(item => item.id)).toEqual([id]);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...start, parentSessionId: undefined });
		const snapshot = await activity.snapshot("session-a");
		expect(snapshot.items.map(item => [item.id, item.status])).toEqual([
			["Worker", "running"],
			[id, "completed"],
		]);
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...start, status: "completed" } satisfies SubagentLifecyclePayload);
		expect((await activity.snapshot("session-a")).items.map(item => [item.id, item.status])).toEqual([
			["Worker", "completed"],
			[id, "completed"],
		]);
	});

	test("preserves terminal agent progress with a bounded recent window and expiry", async () => {
		const { activity, bus } = await fixture();
		for (let index = 0; index < 24; index++) {
			const id = `Worker${index}`;
			const start = started(id, "session-a");
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, start);
			bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: "task",
				agentSource: "bundled",
				task: "work",
				parentToolCallId: start.parentToolCallId,
				progress: {
					id,
					index,
					agent: "task",
					agentSource: "bundled",
					status: "running",
					task: "work",
					recentTools: [],
					recentOutput: ["last line", "first line"],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 2,
				},
			} satisfies SubagentProgressPayload);
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				...start,
				status: "completed",
			} satisfies SubagentLifecyclePayload);
		}
		const snapshot = await activity.snapshot("session-a");
		expect(snapshot.items).toHaveLength(20);
		expect(snapshot.items.every(item => item.status === "completed")).toBe(true);
		const detail = await activity.detail("session-a", snapshot.generation, "agent", snapshot.items[0]!.id);
		expect(detail.text).toBe("first line\nlast line");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
		expect((await activity.snapshot("session-a")).items).toEqual([]);
	});

	test("disposed observers cannot expose cached or newly registered work", async () => {
		const { manager, activity } = await fixture();
		const id = manager.register("bash", "Done", async () => "result", { ownerId: "Main" });
		await manager.waitForAll();
		const snapshot = await activity.snapshot("session-a");
		activity.dispose();
		await expect(activity.snapshot("session-a")).rejects.toThrow("shutdown");
		await expect(activity.detail("session-a", snapshot.generation, "job", id)).rejects.toThrow("shutdown");
	});
});
