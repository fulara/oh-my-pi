import type { Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { getHistoryDbPath } from "@oh-my-pi/pi-utils/dirs";
import { cfgRecap } from "../modes/settings";
import idleRecapPrompt from "../prompts/system/recap-user.md" with { type: "text" };
import { nextActionableTask } from "../tools/todo";
import type { AgentSession, AgentSessionEvent } from "./agent-session";

export interface RpcSessionRecap {
	id: number;
	text: string;
	createdAt: number;
	sourceLeafId: string | null;
	stale: boolean | null;
}

export interface RpcSessionRecapSnapshot {
	sessionId: string;
	enabled: boolean;
	idleSeconds: number;
	generating: boolean;
	recap: RpcSessionRecap | null;
	error?: string;
}

/** Only the main interactive host enables generation; SDK/subagent sessions remain passive. */
export interface IdleRecapHost {
	canGenerate?(): boolean;
	onRecap?(text: string): void;
}

interface RecapSource {
	epoch: number;
	sessionId: string;
	providerSessionId: string;
	sessionFile: string | undefined;
	cwd: string;
	dbPath: string;
	leafId: string | null;
	model: Model;
}

/** One lifecycle owner per AgentSession, shared by the TUI and rpc-ui. */
export class SessionRecapController {
	#host: IdleRecapHost | undefined;
	#unsubscribeSettings: (() => void) | undefined;
	/** A terminal settle, not activation or read traffic, makes live rearming eligible. */
	#settled = false;
	#epoch = 0;
	#timer: NodeJS.Timeout | undefined;
	#pending: RecapSource | undefined;
	#request: { source: RecapSource; abort: AbortController } | undefined;
	#attempted: RecapSource | undefined;
	#error: string | undefined;

	constructor(private readonly session: AgentSession) {}

	enable(host: IdleRecapHost): () => void {
		if (this.session.isDisposed) throw new Error("Cannot enable recaps on a disposed session");
		if (this.#host) throw new Error("Idle recaps already have a host");
		this.#host = host;
		this.#unsubscribeSettings = cfgRecap.listen(this.session.settings, () => {
			if (!this.#settled) return;
			// A settings change supersedes unfinished inference, not a delivered recap.
			// Preserve the request latch until even an abort-ignoring provider settles.
			if (this.#attempted === this.#request?.source) this.#attempted = undefined;
			this.invalidate();
			this.#settled = true;
			this.#schedule();
		});
		return () => {
			if (this.#host !== host) return;
			this.#host = undefined;
			this.#unsubscribeSettings?.();
			this.#unsubscribeSettings = undefined;
			this.invalidate();
		};
	}

	/** Keep the request latch until it settles, even if the provider ignores abort. */
	invalidate(): void {
		this.#settled = false;
		this.#epoch++;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#pending = undefined;
		this.#request?.abort.abort();
		this.#error = undefined;
	}

	dispose(): void {
		this.#host = undefined;
		this.#unsubscribeSettings?.();
		this.#unsubscribeSettings = undefined;
		this.invalidate();
	}

	handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
			case "auto_compaction_start":
			case "auto_compaction_end":
			case "auto_retry_start":
			case "model_changed":
				this.invalidate();
				break;
			case "agent_end": {
				if (event.isTerminal === false) break;
				if (!this.#host) break;
				if (!this.session.hasAdmittedSubmission) {
					this.#settled = true;
					this.#schedule();
					break;
				}
				// The terminal event may precede its prompt's admission finally.
				// Only that terminal settle may arm work after admission drains;
				// a newer submission/transition invalidates this epoch meanwhile.
				const epoch = this.#epoch;
				void this.session.waitForAdmittedSubmissions().then(() => {
					if (epoch !== this.#epoch) return;
					this.#settled = true;
					this.#schedule();
				});
				break;
			}
		}
	}

	read(): RpcSessionRecapSnapshot {
		const session = this.session;
		const settings = cfgRecap.get(session.settings);
		const snapshot: RpcSessionRecapSnapshot = {
			sessionId: session.sessionId,
			enabled: Boolean(this.#host) && settings.enabled,
			idleSeconds: settings.idleSeconds,
			generating: Boolean(this.#request && !this.#request.abort.signal.aborted && this.#owns(this.#request.source)),
			recap: null,
		};
		if (this.#error) snapshot.error = this.#error;
		try {
			const row = session.sessionManager.getLatestRecap();
			if (row) {
				snapshot.recap = {
					id: row.id,
					text: row.text,
					createdAt: row.createdAt,
					sourceLeafId: row.sourceLeafId,
					stale: row.sourceLeafId === null ? null : row.sourceLeafId !== session.sessionManager.getLeafId(),
				};
			}
		} catch {
			snapshot.error = "Session recap storage unavailable";
		}
		return snapshot;
	}

	#idle(): boolean {
		const session = this.session;
		return Boolean(
			this.#host &&
			cfgRecap.get(session.settings).enabled &&
			!session.isDisposed &&
			!session.isSessionTransitioning &&
			!session.isStreaming &&
			!session.hasAdmittedSubmission &&
			session.queuedMessageCount === 0 &&
			!session.isBashRunning &&
			!session.isEvalRunning &&
			!session.isCompacting &&
			!session.isRetrying &&
			!session.isGeneratingHandoff &&
			(this.#host.canGenerate?.() ?? true),
		);
	}

	#owns(source: RecapSource): boolean {
		const manager = this.session.sessionManager;
		return (
			source.epoch === this.#epoch &&
			source.sessionId === manager.getSessionId() &&
			source.providerSessionId === this.session.sessionId &&
			source.sessionFile === manager.getSessionFile() &&
			source.cwd === manager.getCwd() &&
			source.dbPath === getHistoryDbPath() &&
			source.leafId === manager.getLeafId() &&
			source.model === this.session.model
		);
	}

	#schedule(): void {
		const session = this.session;
		if (!this.#idle() || !session.model || session.messages.length === 0) return;
		const manager = session.sessionManager;
		const source: RecapSource = {
			epoch: this.#epoch,
			sessionId: manager.getSessionId(),
			providerSessionId: session.sessionId,
			sessionFile: manager.getSessionFile(),
			cwd: manager.getCwd(),
			dbPath: getHistoryDbPath(),
			leafId: manager.getLeafId(),
			model: session.model,
		};
		// Repeated terminal notifications and reconnect/read traffic must not buy
		// another inference for the same settled source, including failed attempts.
		if (this.#pending && this.#owns(this.#pending)) return;
		const attempted = this.#attempted;
		if (
			attempted?.sessionId === source.sessionId &&
			attempted.sessionFile === source.sessionFile &&
			attempted.dbPath === source.dbPath &&
			attempted.leafId === source.leafId
		)
			return;
		try {
			const latest = manager.getLatestRecap();
			if (source.leafId !== null && latest?.sourceLeafId === source.leafId) return;
		} catch {
			this.#error = "Session recap storage unavailable";
			return;
		}
		clearTimeout(this.#timer);
		this.#pending = source;
		const delay = Math.max(1, Math.min(3600, cfgRecap.get(session.settings).idleSeconds)) * 1000;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#startPending();
		}, delay);
		this.#timer.unref?.();
	}

	async #startPending(): Promise<void> {
		if (this.#request || this.#timer) return;
		const source = this.#pending;
		this.#pending = undefined;
		if (!source || !this.#owns(source) || !this.#idle()) return;
		const session = this.session;
		const goal = session.getGoalModeState()?.goal.objective.trim() || session.sessionManager.getSessionName()?.trim();
		const promptText = prompt.render(idleRecapPrompt, {
			goal: goal ?? "",
			task: nextActionableTask(session.getTodoPhases())?.content ?? "",
		});
		const request = { source, abort: new AbortController() };
		this.#request = request;
		this.#attempted = source;
		this.#error = undefined;
		try {
			const { replyText } = await session.runEphemeralTurn({ promptText, signal: request.abort.signal });
			if (request.abort.signal.aborted || !this.#owns(source) || !this.#idle()) return;
			if (!replyText.trim()) return;
			const persisted = session.sessionManager.recordRecap(replyText, source.leafId);
			if (!persisted && source.sessionFile) {
				this.#error = "Session recap could not be saved";
				return;
			}
			this.#host?.onRecap?.(replyText);
		} catch (error) {
			if (!request.abort.signal.aborted && this.#owns(source)) {
				this.#error = "Idle recap generation failed";
				logger.debug("Idle recap turn failed", { error: String(error) });
			}
		} finally {
			this.#request = undefined;
			// A newer terminal settle may have become due while cancellation drained.
			if (this.#pending && !this.#timer) void this.#startPending();
		}
	}
}

/** Activation is explicit at the rpc-ui main-session boundary, never a read side effect. */
export function enableRpcSessionRecaps(session: AgentSession): () => void {
	return session.enableIdleRecaps();
}

export function readRpcSessionRecap(session: AgentSession, sessionId: string): RpcSessionRecapSnapshot {
	if (sessionId !== session.sessionId) throw new Error("Session ID does not match current session");
	if (session.isSessionTransitioning || session.isDisposed) throw new Error("Session is unavailable");
	return session.getSessionRecap();
}
