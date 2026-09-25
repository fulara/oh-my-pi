import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { truncateTail } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../../async/job-manager";
import { inspectSessionServiceLogs, inspectSessionServices } from "../../launch/services";
import type { RpcSubagentRegistry } from "./rpc-subagents";
import type {
	ActivityItem,
	ActivitySourceState,
	ActivityStatus,
	RpcSubagentSnapshot,
	SessionActivityDetail,
	SessionActivitySnapshot,
} from "./rpc-types";

const RECENT_LIMIT = 20;
const RECENT_MS = 5 * 60 * 1_000;
const DETAIL_BYTES = 64 * 1_024;
const DETAIL_LINES = 200;
const TERMINAL: Partial<Record<ActivityStatus, true>> = {
	completed: true,
	failed: true,
	cancelled: true,
	exited: true,
	aborted: true,
};

export interface RpcActivitySession {
	readonly sessionId: string;
	readonly asyncJobManager: AsyncJobManager | undefined;
	sessionManager: { getCwd(): string; getSessionId(): string };
	getAgentId(): string | undefined;
	subscribeSessionTransition(listener: (phase: "begin" | "end") => void): () => void;
}

interface BoundedText {
	text: string;
	truncated: boolean;
}

interface ActivityEntry {
	item: ActivityItem;
	detail?: BoundedText;
	agentId?: string;
	serviceName?: string;
}

/** Bounds apply to the serialized text, after terminal/control sanitization. */
function boundedText(text: string): BoundedText {
	const tail = truncateTail(text, { maxBytes: DETAIL_BYTES, maxLines: DETAIL_LINES });
	const clean = sanitizeText(tail.content);
	const bounded = truncateTail(clean, { maxBytes: DETAIL_BYTES, maxLines: DETAIL_LINES });
	return { text: bounded.content, truncated: Boolean(tail.truncated || bounded.truncated) };
}

function jobText(job: AsyncJob): BoundedText | undefined {
	const text = job.errorText ?? job.resultText ?? job.latestDetails?.output;
	return typeof text === "string" ? boundedText(text) : undefined;
}

function label(text: string): string {
	return sanitizeText(truncateTail(text, { maxBytes: 512, maxLines: 1 }).content);
}

function unavailable(error: string): ActivitySourceState {
	return { available: false, error };
}

/** Passive, generation-scoped projection. Never acknowledges delivery or owns process lifecycle. */
export class RpcActivity {
	#session: RpcActivitySession;
	#subagents: RpcSubagentRegistry | undefined;
	#sessionId: string;
	#journalSessionId: string;
	#generation: string = crypto.randomUUID();
	#transitioning = false;
	#disposed = false;
	#entries = new Map<string, ActivityEntry>();
	// Identity witnesses survive the bounded recent view so a parked child's next turn
	// remains attributable. They never cross a logical session transition.
	#agentSessions = new Map<string, string>();
	#unsubscribers: Array<() => void> = [];
	#unbindOwner: (() => void) | undefined;

	constructor(session: RpcActivitySession, subagents?: RpcSubagentRegistry) {
		this.#session = session;
		this.#subagents = subagents;
		this.#sessionId = session.sessionId;
		this.#journalSessionId = session.sessionManager.getSessionId();
		this.#bindOwner();
		if (session.asyncJobManager) {
			this.#unsubscribers.push(session.asyncJobManager.subscribe(job => this.#observeJob(job)));
		}
		if (subagents) this.#unsubscribers.push(subagents.subscribe(snapshot => this.#observeAgent(snapshot)));
		this.#unsubscribers.push(
			session.subscribeSessionTransition(phase => {
				this.#transitioning = phase === "begin";
				this.#generation = crypto.randomUUID();
				this.#entries.clear();
				this.#unbindOwner?.();
				this.#unbindOwner = undefined;
				if (phase === "end") {
					if (this.#journalSessionId !== session.sessionManager.getSessionId()) {
						this.#agentSessions.clear();
						this.#subagents?.clear();
					}
					this.#sessionId = session.sessionId;
					this.#journalSessionId = session.sessionManager.getSessionId();
					this.#bindOwner();
				}
			}),
		);
	}

	#bindOwner(): void {
		const ownerId = this.#session.getAgentId();
		if (ownerId) this.#unbindOwner = this.#session.asyncJobManager?.bindOwnerSession(ownerId, this.#journalSessionId);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generation = crypto.randomUUID();
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#unbindOwner?.();
		this.#entries.clear();
		this.#agentSessions.clear();
	}

	#assertSession(sessionId: string, generation = this.#generation): void {
		if (this.#disposed || this.#transitioning)
			throw new Error("Activity source is unavailable during session transition or shutdown");
		if (
			!sessionId ||
			sessionId !== this.#sessionId ||
			sessionId !== this.#session.sessionId ||
			this.#journalSessionId !== this.#session.sessionManager.getSessionId()
		) {
			throw new Error("Activity session does not match the current logical session");
		}
		if (generation !== this.#generation) throw new Error("Activity generation is stale");
	}

	#ownsJob(job: AsyncJob): boolean {
		const ownerId = this.#session.getAgentId();
		return !!ownerId && job.ownerId === ownerId && job.ownerSessionId === this.#journalSessionId && !job.foreground;
	}

	#observeJob(job: AsyncJob): void {
		if (this.#disposed || this.#transitioning || !this.#ownsJob(job)) return;
		const detail = jobText(job);
		this.#entries.set(`job:${job.id}`, {
			item: {
				id: job.id,
				kind: "job",
				label: label(job.label),
				status: job.status,
				startedAt: job.startTime,
				endedAt: job.endTime,
				toolCallId: job.toolCallId,
				queued: job.queued,
				exitCode: typeof job.latestDetails?.exitCode === "number" ? job.latestDetails.exitCode : undefined,
				detailAvailable: detail !== undefined,
			},
			detail,
			agentId: job.agentId,
		});
		this.#prune();
	}

	#entryDetail(entry: ActivityEntry): BoundedText | undefined {
		if (entry.detail) return entry.detail;
		if (entry.item.kind !== "job" || TERMINAL[entry.item.status] || !entry.agentId) return undefined;
		const agent = this.#entries.get(`agent:${entry.agentId}`);
		if (!agent || TERMINAL[agent.item.status] || agent.item.startedAt < entry.item.startedAt) return undefined;
		if (entry.item.toolCallId && agent.item.toolCallId && entry.item.toolCallId !== agent.item.toolCallId)
			return undefined;
		return agent.detail;
	}

	#observeAgent(snapshot: RpcSubagentSnapshot): void {
		if (this.#disposed || this.#transitioning || !snapshot.sessionId) return;
		const knownSession = this.#agentSessions.get(snapshot.id);
		let ownedParent = snapshot.parentSessionId === this.#journalSessionId;
		if (!ownedParent && snapshot.parentSessionId !== undefined) {
			for (const childSessionId of this.#agentSessions.values()) {
				if (childSessionId === snapshot.parentSessionId) {
					ownedParent = true;
					break;
				}
			}
		}
		if (!ownedParent && knownSession !== snapshot.sessionId) return;
		this.#agentSessions.set(snapshot.id, snapshot.sessionId);
		const detail = snapshot.progress?.recentOutput.length
			? boundedText([...snapshot.progress.recentOutput].reverse().join("\n"))
			: undefined;
		const key = `agent:${snapshot.id}`;
		const previous = this.#entries.get(key);
		const startedAt = snapshot.startedAt ?? previous?.item.startedAt ?? snapshot.lastUpdate;
		const sameRun =
			previous !== undefined &&
			previous.item.startedAt === startedAt &&
			!(TERMINAL[previous.item.status] && !TERMINAL[snapshot.status]);
		const retainedDetail = detail ?? (sameRun ? previous?.detail : undefined);
		this.#entries.set(key, {
			item: {
				id: snapshot.id,
				kind: "agent",
				label: label(snapshot.description || snapshot.id),
				status: snapshot.status,
				startedAt,
				endedAt: TERMINAL[snapshot.status] ? snapshot.lastUpdate : undefined,
				toolCallId: snapshot.parentToolCallId,
				detailAvailable: retainedDetail !== undefined,
			},
			detail: retainedDetail,
		});
		this.#prune();
	}

	#observeService(daemon: DaemonSnapshot): void {
		if (daemon.ownerSessionId !== this.#journalSessionId) return;
		this.#entries.set(`service:${daemon.id}`, {
			item: {
				id: daemon.id,
				kind: "service",
				label: label(daemon.name),
				status: daemon.state,
				startedAt: daemon.startedAt,
				endedAt: daemon.exitedAt,
				toolCallId: daemon.toolCallId,
				exitCode: daemon.exitCode,
				detailAvailable: true,
			},
			serviceName: daemon.name,
		});
	}

	#prune(now = Date.now()): void {
		const recent: Array<[string, ActivityEntry]> = [];
		for (const [key, entry] of this.#entries) {
			if (!TERMINAL[entry.item.status]) continue;
			if (now - (entry.item.endedAt ?? entry.item.startedAt) > RECENT_MS) this.#entries.delete(key);
			else recent.push([key, entry]);
		}
		recent.sort((a, b) => (b[1].item.endedAt ?? b[1].item.startedAt) - (a[1].item.endedAt ?? a[1].item.startedAt));
		for (const [key] of recent.slice(RECENT_LIMIT)) this.#entries.delete(key);
		// Keep live ancestry witnesses; prune only retired identities beyond the
		// existing RPC transcript-selector retention budget.
		for (const id of this.#agentSessions.keys()) {
			if (this.#agentSessions.size <= 256) break;
			if (!this.#entries.has(`agent:${id}`)) this.#agentSessions.delete(id);
		}
	}

	async snapshot(sessionId: string): Promise<SessionActivitySnapshot> {
		this.#assertSession(sessionId);
		const generation = this.#generation;
		const manager = this.#session.asyncJobManager;
		const ownerId = this.#session.getAgentId();
		const jobs = manager && ownerId ? { available: true } : unavailable("Session job registry is unavailable");
		if (manager && ownerId) {
			const current = new Set<string>();
			for (const job of manager.getAllJobs({ ownerId })) {
				if (!this.#ownsJob(job)) continue;
				current.add(`job:${job.id}`);
				this.#observeJob(job);
			}
			for (const [key, entry] of this.#entries) {
				if (entry.item.kind === "job" && !TERMINAL[entry.item.status] && !current.has(key))
					this.#entries.delete(key);
			}
		}
		if (this.#subagents) {
			for (const snapshot of this.#subagents.getSubagents()) this.#observeAgent(snapshot);
		}
		let services: ActivitySourceState;
		try {
			const daemons = await inspectSessionServices(this.#session.sessionManager.getCwd(), this.#journalSessionId);
			this.#assertSession(sessionId, generation);
			const current = new Set(daemons.map(daemon => `service:${daemon.id}`));
			for (const [key, entry] of this.#entries) {
				if (entry.item.kind === "service" && !TERMINAL[entry.item.status] && !current.has(key))
					this.#entries.delete(key);
			}
			for (const daemon of daemons) this.#observeService(daemon);
			services = { available: true };
		} catch {
			services = unavailable("Service broker is unavailable; service state is unknown");
		}
		this.#assertSession(sessionId, generation);
		const observedAt = Date.now();
		this.#prune(observedAt);
		const jobAgents = new Map<string, { active: boolean; endedAt: number }>();
		for (const entry of this.#entries.values()) {
			if (!entry.agentId) continue;
			const previous = jobAgents.get(entry.agentId);
			jobAgents.set(entry.agentId, {
				active: previous?.active === true || !TERMINAL[entry.item.status],
				endedAt: Math.max(previous?.endedAt ?? 0, entry.item.endedAt ?? 0),
			});
		}
		const items = [...this.#entries.values()]
			.filter(entry => {
				if (entry.item.kind !== "agent") return true;
				const job = jobAgents.get(entry.item.id);
				return !job || (!job.active && (!TERMINAL[entry.item.status] || job.endedAt < entry.item.startedAt));
			})
			.map(entry => ({
				...entry.item,
				detailAvailable: this.#entryDetail(entry) !== undefined || entry.item.kind === "service",
			}))
			.sort(
				(a, b) =>
					Number(!!TERMINAL[a.status]) - Number(!!TERMINAL[b.status]) ||
					b.startedAt - a.startedAt ||
					a.id.localeCompare(b.id),
			);
		return {
			sessionId,
			generation,
			observedAt,
			items,
			sources: {
				jobs,
				agents: this.#subagents ? { available: true } : unavailable("Root subagent registry is unavailable"),
				services,
			},
		};
	}

	async detail(
		sessionId: string,
		generation: string,
		kind: ActivityItem["kind"],
		activityId: string,
	): Promise<SessionActivityDetail> {
		if (
			typeof generation !== "string" ||
			!generation ||
			(kind !== "job" && kind !== "agent" && kind !== "service") ||
			typeof activityId !== "string" ||
			!activityId
		) {
			throw new Error("Activity detail requires a generation, kind, and activityId");
		}
		this.#assertSession(sessionId, generation);
		this.#prune();
		if (kind === "job") {
			const job = this.#session.asyncJobManager?.getJob(activityId);
			if (job && this.#ownsJob(job)) this.#observeJob(job);
		}
		const entry = this.#entries.get(`${kind}:${activityId}`);
		if (!entry) throw new Error("Activity entry is unavailable or expired");
		let detail = this.#entryDetail(entry);
		if (kind === "service" && entry.serviceName) {
			detail = await inspectSessionServiceLogs(
				this.#session.sessionManager.getCwd(),
				this.#journalSessionId,
				entry.serviceName,
				activityId,
			);
		}
		this.#assertSession(sessionId, generation);
		if (!detail) throw new Error("Activity detail is not available");
		return { sessionId, generation, kind, activityId, ...detail, observedAt: Date.now() };
	}
}
