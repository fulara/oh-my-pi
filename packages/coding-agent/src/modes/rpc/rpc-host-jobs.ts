/**
 * Host background jobs: work an RPC host runs for the agent after a host tool
 * call returned. The call's `host_tool_result.background` registers a `host`
 * job owned by the calling agent; `host_job_settle` completes it through the
 * normal async-result delivery. A cancel by the agent's job tools, or a session
 * switch, reset or shutdown tells the host with `host_job_cancel`, as does a
 * job that could not be registered (no job manager, job limit reached).
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AsyncJobManagerApi } from "../../async/job-manager";
import type { RpcHostJobCancelFrame, RpcHostToolBackground } from "./rpc-types";

export interface RpcHostJobsSession {
	readonly asyncJobManager: AsyncJobManagerApi | undefined;
	readonly sessionManager: { getSessionId(): string };
	getAgentId(): string | undefined;
}

interface PendingHostJob {
	resolve: (text: string) => void;
	reject: (error: Error) => void;
}

/** Validates the wire shape of `host_tool_result.background`; returns the error text, if any. */
export function hostToolBackgroundError(value: unknown): string | undefined {
	if (!isRecord(value)) return "host_tool_result.background must be an object";
	const { jobId, label } = value;
	if (typeof jobId !== "string" || jobId.length === 0 || jobId.trim() !== jobId) {
		return "host_tool_result.background.jobId must be a non-empty string without surrounding whitespace";
	}
	if (typeof label !== "string") return "host_tool_result.background.label must be a string";
	return undefined;
}

export class RpcHostJobs {
	#session: RpcHostJobsSession;
	#output: (frame: RpcHostJobCancelFrame) => void;
	#pending = new Map<string, PendingHostJob>();

	constructor(session: RpcHostJobsSession, output: (frame: RpcHostJobCancelFrame) => void) {
		this.#session = session;
		this.#output = output;
	}

	/**
	 * Register a running `host` job for the agent that made tool call `toolCallId`.
	 * Throws when it cannot; unless the id names a live job, the host is first told
	 * with `host_job_cancel` so it does not run work nobody owns.
	 */
	start(background: RpcHostToolBackground, toolCallId: string): void {
		const { jobId, label } = background;
		const manager = this.#session.asyncJobManager;
		if (!manager) {
			this.#output({ type: "host_job_cancel", jobId });
			throw new Error("Background jobs are unavailable in this session");
		}
		if (this.#pending.has(jobId) || manager.getJob(jobId)) {
			throw new Error(`Background job id "${jobId}" is already registered`);
		}
		try {
			manager.register(
				"host",
				label,
				({ signal }) => {
					const { promise, resolve, reject } = Promise.withResolvers<string>();
					const entry: PendingHostJob = { resolve, reject };
					const onAbort = () => {
						if (this.#pending.get(jobId) !== entry) return;
						this.#pending.delete(jobId);
						this.#output({ type: "host_job_cancel", jobId });
						reject(new Error(`Host job ${jobId} was cancelled`));
					};
					this.#pending.set(jobId, entry);
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
					return promise.finally(() => signal.removeEventListener("abort", onAbort));
				},
				{
					id: jobId,
					ownerId: this.#session.getAgentId(),
					ownerSessionId: this.#session.sessionManager.getSessionId(),
					toolCallId,
				},
			);
		} catch (error) {
			this.#output({ type: "host_job_cancel", jobId });
			throw error;
		}
	}

	/** Complete a running host job; throws for an unknown, cancelled or already settled job. */
	settle(jobId: string, text: string, isError: boolean): void {
		const entry = this.#pending.get(jobId);
		if (!entry) throw new Error(`No running host job "${jobId}"`);
		this.#pending.delete(jobId);
		if (isError) entry.reject(new Error(text));
		else entry.resolve(text);
	}
}
