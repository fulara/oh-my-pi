/**
 * Host background jobs: `host_tool_result.background` registers a `host` job
 * owned by the calling agent, `host_job_settle` completes it through the normal
 * async-result delivery, and cancelling it emits `host_job_cancel`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import { RpcActivity } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-activity";
import { RpcHostJobs } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-host-jobs";
import type {
	RpcHostJobCancelFrame,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord, removeWithRetries } from "@oh-my-pi/pi-utils";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AsyncJobManager.resetForTests();
});

interface Harness {
	session: AgentSession;
	manager: AsyncJobManager;
	mock: MockModel;
	activity: RpcActivity;
	tool: AgentTool;
	bridge: RpcHostToolBridge;
	hostJobs: RpcHostJobs;
	calls: RpcHostToolCallRequest[];
	cancels: RpcHostJobCancelFrame[];
}

async function harness(): Promise<Harness> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const mock = createMockModel({ handler: () => ({ content: ["Noted"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("anthropic", "test-key");
	const manager = new AsyncJobManager({ retentionMs: 60_000 });
	cleanups.push(async () => {
		await manager.dispose();
	});
	AsyncJobManager.setInstance(manager);
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: "Main",
		asyncJobManager: manager,
	});
	cleanups.push(() => session.dispose());
	const activity = new RpcActivity(session);
	cleanups.push(() => activity.dispose());

	const calls: RpcHostToolCallRequest[] = [];
	const cancels: RpcHostJobCancelFrame[] = [];
	const hostJobs = new RpcHostJobs(session, frame => cancels.push(frame));
	const bridge = new RpcHostToolBridge(
		(frame: RpcHostToolCallRequest | RpcHostToolCancelRequest) => {
			if (frame.type === "host_tool_call") calls.push(frame);
		},
		(background, toolCallId) => hostJobs.start(background, toolCallId),
	);
	const [tool] = bridge.setTools([
		{
			name: "fura_session_send",
			description: "Message a session",
			parameters: { type: "object", properties: {} },
		},
	]);
	if (!tool) throw new Error("Expected a host tool adapter");
	return { session, manager, mock, activity, tool, bridge, hostJobs, calls, cancels };
}

/** Run the host tool and answer its call with a background result. */
async function startHostJob(h: Harness, toolCallId: string, jobId: string, label = "Session Reviewer") {
	const execution = h.tool.execute(toolCallId, {});
	const request = h.calls.at(-1);
	if (!request) throw new Error("Expected host_tool_call frame");
	h.bridge.handleResult({
		type: "host_tool_result",
		id: request.id,
		result: { content: [{ type: "text", text: `Started background job ${jobId}` }] },
		background: { jobId, label },
	});
	return execution;
}

function modelSaw(mock: MockModel, text: string): boolean {
	return mock.calls.some(call =>
		call.context.messages.some(message =>
			typeof message.content === "string"
				? message.content.includes(text)
				: message.content.some(content => content.type === "text" && content.text.includes(text)),
		),
	);
}

async function settleOwnedJobs(session: AgentSession, manager: AsyncJobManager): Promise<void> {
	await manager.waitForOwnerJobs("Main", { excludeSuppressed: true });
	await manager.drainDeliveries({ filter: { ownerId: "Main" } });
	await session.waitForRunEnd();
}

describe("RPC host background jobs", () => {
	it("registers an owned host job visible in activity and job snapshots", async () => {
		const h = await harness();
		const result = await startHostJob(h, "toolu_send", "fura-session-1");

		expect(result).toEqual({ content: [{ type: "text", text: "Started background job fura-session-1" }] });
		const job = h.manager.getJob("fura-session-1");
		expect(job).toMatchObject({
			type: "host",
			status: "running",
			label: "Session Reviewer",
			ownerId: "Main",
			ownerSessionId: h.session.sessionManager.getSessionId(),
			toolCallId: "toolu_send",
		});
		expect(h.session.getAsyncJobSnapshot()?.running).toEqual([
			expect.objectContaining({ id: "fura-session-1", type: "host", label: "Session Reviewer", ownerId: "Main" }),
		]);
		expect(h.session.wakeSources).toBeDefined();

		const activity = await h.activity.snapshot(h.session.sessionId);
		expect(activity.items).toContainEqual(
			expect.objectContaining({
				id: "fura-session-1",
				kind: "job",
				label: "Session Reviewer",
				status: "running",
				toolCallId: "toolu_send",
			}),
		);
	});

	it("delivers a settled result as an async completion that wakes the idle owner", async () => {
		const h = await harness();
		await startHostJob(h, "toolu_send", "fura-session-1");
		expect(h.session.isStreaming).toBe(false);

		h.hostJobs.settle("fura-session-1", "Session Reviewer finished: REVIEW ALL GREEN", false);
		await settleOwnedJobs(h.session, h.manager);

		expect(h.manager.getJob("fura-session-1")).toMatchObject({
			status: "completed",
			resultText: "Session Reviewer finished: REVIEW ALL GREEN",
		});
		expect(modelSaw(h.mock, "REVIEW ALL GREEN")).toBe(true);
		expect(
			h.session.messages.some(message => message.role === "custom" && message.customType === "async-result"),
		).toBe(true);
		expect(h.session.wakeSources).toBeUndefined();
		expect(h.cancels).toEqual([]);
	});

	it("delivers an error settle as a failed job", async () => {
		const h = await harness();
		await startHostJob(h, "toolu_send", "fura-session-1");

		h.hostJobs.settle("fura-session-1", "Session Reviewer exited: CHILD CRASHED", true);
		await settleOwnedJobs(h.session, h.manager);

		expect(h.manager.getJob("fura-session-1")).toMatchObject({
			status: "failed",
			errorText: "Session Reviewer exited: CHILD CRASHED",
		});
		expect(modelSaw(h.mock, "CHILD CRASHED")).toBe(true);
	});

	it("rejects settling an unknown or already settled job", async () => {
		const h = await harness();
		expect(() => h.hostJobs.settle("missing", "text", false)).toThrow('No running host job "missing"');

		await startHostJob(h, "toolu_send", "fura-session-1");
		h.hostJobs.settle("fura-session-1", "done", false);
		expect(() => h.hostJobs.settle("fura-session-1", "again", false)).toThrow('No running host job "fura-session-1"');
		await settleOwnedJobs(h.session, h.manager);
		expect(h.manager.getJob("fura-session-1")?.resultText).toBe("done");
	});

	it("emits host_job_cancel when the agent cancels the job; a late settle fails without delivery", async () => {
		const h = await harness();
		await startHostJob(h, "toolu_send", "fura-session-1");

		expect(h.session.cancelAsyncJob("fura-session-1")).toBe(true);
		expect(h.cancels).toEqual([{ type: "host_job_cancel", jobId: "fura-session-1" }]);
		await h.manager.getJob("fura-session-1")?.promise;
		expect(h.manager.getJob("fura-session-1")?.status).toBe("cancelled");

		expect(() => h.hostJobs.settle("fura-session-1", "LATE RESULT", false)).toThrow(
			'No running host job "fura-session-1"',
		);
		await settleOwnedJobs(h.session, h.manager);
		expect(h.mock.calls).toHaveLength(0);
		expect(h.cancels).toHaveLength(1);
	});

	it("emits host_job_cancel when the owning session shuts down", async () => {
		const h = await harness();
		await startHostJob(h, "toolu_send", "fura-session-1");

		await h.session.dispose();
		expect(h.cancels).toEqual([{ type: "host_job_cancel", jobId: "fura-session-1" }]);
		expect(h.manager.getJob("fura-session-1")?.status).toBe("cancelled");
	});

	it("rejects a background result whose job id is already registered", async () => {
		const h = await harness();
		await startHostJob(h, "toolu_first", "fura-session-1");

		await expect(startHostJob(h, "toolu_second", "fura-session-1", "Other")).rejects.toThrow(
			'Background job id "fura-session-1" is already registered',
		);
		expect(h.manager.getAllJobs()).toHaveLength(1);
		expect(h.manager.getJob("fura-session-1")).toMatchObject({
			label: "Session Reviewer",
			toolCallId: "toolu_first",
		});
	});

	it("rejects a malformed background request without starting a job", async () => {
		const h = await harness();
		const execution = h.tool.execute("toolu_send", {});
		const request = h.calls.at(-1);
		if (!request) throw new Error("Expected host_tool_call frame");
		h.bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: { content: [{ type: "text", text: "started" }] },
			background: { jobId: " ", label: "Session" },
		});

		await expect(execution).rejects.toThrow("host_tool_result.background.jobId");
		expect(h.manager.getAllJobs()).toHaveLength(0);
	});
});

type Frame = Record<string, unknown>;

/** A raw JSONL peer for `runRpcMode`: host background jobs have no `RpcClient` surface. */
class RawRpcPeer {
	readonly frames: Frame[] = [];
	#proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	#changed = Promise.withResolvers<void>();
	#closed = false;
	#nextId = 1;

	constructor(cwd: string) {
		this.#proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "host-jobs-rpc-agent.ts")], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void this.#read();
	}

	async #read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			for await (const chunk of this.#proc.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
					const line = buffer.slice(0, index).trim();
					buffer = buffer.slice(index + 1);
					if (line) this.frames.push(JSON.parse(line));
				}
				this.#notify();
			}
		} finally {
			this.#closed = true;
			this.#notify();
		}
	}

	#notify(): void {
		const changed = this.#changed;
		this.#changed = Promise.withResolvers<void>();
		changed.resolve();
	}

	send(frame: Frame): void {
		this.#proc.stdin.write(`${JSON.stringify(frame)}\n`);
		this.#proc.stdin.flush();
	}

	/** First frame from index `from` on that matches; the test timeout bounds the wait. */
	async waitFor(predicate: (frame: Frame) => boolean, from = 0): Promise<Frame> {
		for (;;) {
			const found = this.frames.slice(from).find(predicate);
			if (found) return found;
			if (this.#closed) throw new Error(`RPC peer exited; saw ${this.frames.map(f => f.type).join(",")}`);
			await this.#changed.promise;
		}
	}

	async command(frame: Frame): Promise<Frame> {
		const id = `cmd-${this.#nextId++}`;
		this.send({ ...frame, id });
		return this.waitFor(candidate => candidate.type === "response" && candidate.id === id);
	}

	async stop(): Promise<void> {
		this.#proc.kill();
		await this.#proc.exited;
	}
}

describe("RPC host background jobs over runRpcMode", () => {
	it("starts a host job from a tool result, reports it, and wakes the idle agent on host_job_settle", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-host-jobs-"));
		cleanups.push(() => removeWithRetries(directory));
		const peer = new RawRpcPeer(directory);
		cleanups.push(() => peer.stop());
		await peer.waitFor(frame => frame.type === "ready");

		const tools = await peer.command({
			type: "set_host_tools",
			tools: [
				{
					name: "fura_session_send",
					description: "Message a Fura session",
					parameters: { type: "object", properties: {} },
					loadMode: "essential",
				},
			],
		});
		expect(tools).toMatchObject({ success: true });

		peer.send({ id: "prompt-1", type: "prompt", message: "delegate the review" });
		const call = await peer.waitFor(frame => frame.type === "host_tool_call");
		expect(call).toMatchObject({ toolName: "fura_session_send" });
		peer.send({
			type: "host_tool_result",
			id: call.id,
			result: { content: [{ type: "text", text: "Started turn as background job fura-session-e2e" }] },
			background: { jobId: "fura-session-e2e", label: "Session Reviewer" },
		});
		const promptResult = await peer.waitFor(frame => frame.type === "prompt_result" && frame.id === "prompt-1");
		expect(promptResult).toMatchObject({ status: "completed", sessionSettled: false });

		const state = await peer.command({ type: "get_state" });
		expect(state.data).toMatchObject({ hasPendingAsyncWork: true });
		const sessionId = isRecord(state.data) ? state.data.sessionId : undefined;
		expect(typeof sessionId).toBe("string");
		const activity = await peer.command({ type: "get_activity", sessionId });
		expect(activity.data).toMatchObject({
			items: expect.arrayContaining([
				expect.objectContaining({
					id: "fura-session-e2e",
					kind: "job",
					label: "Session Reviewer",
					status: "running",
				}),
			]),
		});

		expect(await peer.command({ type: "host_job_settle", jobId: "missing", text: "x" })).toMatchObject({
			type: "response",
			command: "host_job_settle",
			success: false,
			error: 'No running host job "missing"',
		});
		const settledFrom = peer.frames.length;
		expect(
			await peer.command({ type: "host_job_settle", jobId: "fura-session-e2e", text: "HOST RESULT GREEN" }),
		).toMatchObject({ type: "response", command: "host_job_settle", success: true });
		expect(
			await peer.command({ type: "host_job_settle", jobId: "fura-session-e2e", text: "HOST RESULT AGAIN" }),
		).toMatchObject({ success: false, error: 'No running host job "fura-session-e2e"' });

		await peer.waitFor(frame => frame.type === "session_settled", settledFrom);
		const last = await peer.command({ type: "get_last_assistant_text" });
		expect(last.data).toEqual({ text: "Woken by HOST RESULT GREEN" });
		expect(peer.frames.some(frame => frame.type === "host_job_cancel")).toBe(false);
	}, 60_000);
});
