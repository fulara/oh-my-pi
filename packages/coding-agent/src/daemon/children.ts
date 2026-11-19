/**
 * {@link ManagedChild} over native raw fds: the daemon owns the pipe ends as
 * plain file descriptors, so a child keeps running and stays reachable across
 * an in-place `execReplace` of the daemon.
 */
import * as os from "node:os";
import { FdStream, Process, reapChild, spawnRaw } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { ChildExit, ChildSpawn, ManagedChild, ManagedChildState } from "./module";

/** How long a reaped child's pipes get to deliver output written right before its exit. */
const OUTPUT_DRAIN_GRACE_MS = 2_000;

/** Allowed skew between a recorded and an observed process start time. */
const START_TIME_TOLERANCE_MS = 1_000;

/** Start time of a live `pid` (ms since epoch), or undefined when it is gone or unknown. */
export function processStartTime(pid: number): number | undefined {
	return Process.fromPid(pid)?.startTime() ?? undefined;
}

/** Whether `pid` is alive and is still the process that started at `startedAt`. */
export function isSameProcess(pid: number, startedAt: number | undefined): boolean {
	const process = Process.fromPid(pid);
	if (!process || process.status() !== "running") return false;
	if (startedAt === undefined) return true;
	const observed = process.startTime();
	return observed !== null && Math.abs(observed - startedAt) <= START_TIME_TOLERANCE_MS;
}

function openProcess(pid: number): Process | undefined {
	try {
		return Process.fromPid(pid) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fura fork: pin `pid` as this process's own, still unreaped child. Call it only
 * before anything can reap the child; the parent check refuses a pid that already
 * names someone else's process.
 */
export function pinOwnChild(pid: number): Process | undefined {
	const pinned = openProcess(pid);
	return pinned && pinned.ppid === process.pid ? pinned : undefined;
}

/**
 * Fura fork: pin `pid` only while its exact native identity (pid and full-precision
 * start time) is still `identity`. Nothing unverifiable is ever signalled.
 */
export function pinIdentity(pid: number, identity: string | undefined): Process | undefined {
	if (!identity) return undefined;
	const pinned = openProcess(pid);
	return pinned && pinned.identity() === identity ? pinned : undefined;
}

/** Signal number of `signal` on this platform. */
export function signalNumber(signal: NodeJS.Signals): number {
	return os.constants.signals[signal];
}

/** Output delivered to a sink, buffered until the sink is attached. */
class OutputChannel {
	#sink: ((chunk: Uint8Array) => void) | undefined;
	#pending: Uint8Array[] = [];

	push(chunk: Uint8Array): void {
		if (this.#sink) this.#sink(chunk);
		else this.#pending.push(chunk);
	}

	attach(sink: (chunk: Uint8Array) => void): void {
		if (this.#sink) throw new Error("Output sink already attached");
		this.#sink = sink;
		const pending = this.#pending;
		this.#pending = [];
		for (const chunk of pending) sink(chunk);
	}
}

// The pause pair is Unix-only in the natives; Windows never re-execs, so there is nothing to pause.
function pauseStream(stream: FdStream): Promise<void> {
	return typeof stream.pause === "function" ? stream.pause() : Promise.resolve();
}

function resumeStream(stream: FdStream): void {
	if (typeof stream.resume === "function") stream.resume();
}

class RawManagedChild implements ManagedChild {
	readonly pid: number;
	readonly exited: Promise<ChildExit>;
	readonly #startedAt: number;
	readonly #fds: { stdin: number; stdout: number; stderr: number };
	readonly #stdin: FdStream;
	readonly #stdoutStream: FdStream;
	readonly #stderrStream: FdStream;
	readonly #stdout = new OutputChannel();
	readonly #stderr = new OutputChannel();
	#done = false;
	#inputClosed = false;
	/** Fura fork: the only signal authority, pinned while the child was unreaped. */
	readonly #pinned: Process | undefined;
	/** Set the moment the child is reaped (or seen gone), before its pipes drain. */
	#reaped = false;

	constructor(state: ManagedChildState, pinned: Process | undefined) {
		this.pid = state.pid;
		this.#startedAt = state.startedAt;
		this.#pinned = pinned;
		this.#fds = { stdin: state.stdin, stdout: state.stdout, stderr: state.stderr };
		const { pid, startedAt } = state;
		const stdin = new FdStream(state.stdin);
		this.#stdin = stdin;
		const stdout = new FdStream(state.stdout);
		const stderr = new FdStream(state.stderr);
		this.#stdoutStream = stdout;
		this.#stderrStream = stderr;
		const stdoutClosed = Promise.withResolvers<void>();
		const stderrClosed = Promise.withResolvers<void>();
		stdout.start(
			chunk => this.#stdout.push(chunk),
			() => stdoutClosed.resolve(),
		);
		stderr.start(
			chunk => this.#stderr.push(chunk),
			() => stderrClosed.resolve(),
		);
		this.exited = (async (): Promise<ChildExit> => {
			let exit: ChildExit;
			try {
				const result = await reapChild(pid);
				this.#reaped = true;
				exit = { exitCode: result.exitCode ?? undefined, signal: result.signal ?? undefined };
			} catch (error) {
				logger.debug("reapChild failed; polling the process instead", {
					pid,
					error: error instanceof Error ? error.message : String(error),
				});
				while (isSameProcess(pid, startedAt)) await Bun.sleep(250);
				this.#reaped = true;
				exit = {};
			}
			// Output written right before exit is still in the pipes. The grace timer is cleared
			// once they close: left pending it would hold an in-process host's exit for its full length.
			const grace = Promise.withResolvers<void>();
			const graceTimer = setTimeout(grace.resolve, OUTPUT_DRAIN_GRACE_MS);
			try {
				await Promise.race([Promise.all([stdoutClosed.promise, stderrClosed.promise]), grace.promise]);
			} finally {
				clearTimeout(graceTimer);
			}
			this.#done = true;
			this.closeInput();
			stdout.close();
			stderr.close();
			return exit;
		})();
	}

	write(data: string | Uint8Array): boolean {
		if (this.#done || this.#inputClosed) return false;
		return this.#stdin.write(data);
	}

	closeInput(): void {
		if (this.#inputClosed) return;
		this.#inputClosed = true;
		this.#stdin.close();
	}

	drained(): Promise<void> {
		return this.#stdin.drained();
	}

	onStdout(sink: (chunk: Uint8Array) => void): void {
		this.#stdout.attach(sink);
	}

	onStderr(sink: (chunk: Uint8Array) => void): void {
		this.#stderr.attach(sink);
	}

	async pauseOutput(): Promise<void> {
		await Promise.all([pauseStream(this.#stdoutStream), pauseStream(this.#stderrStream)]);
	}

	resumeOutput(): void {
		resumeStream(this.#stdoutStream);
		resumeStream(this.#stderrStream);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.#done || this.#reaped) return;
		// Fura fork: never a numeric pid or process-group signal; without the pinned
		// identity the child is reported, not signalled.
		if (!this.#pinned) {
			logger.warn("Daemon child has no pinned process identity; refusing to signal it", { pid: this.pid, signal });
			return;
		}
		this.#pinned.killTree(signalNumber(signal));
	}

	get signalable(): boolean {
		return this.#pinned !== undefined;
	}

	async terminate(gracefulMs: number): Promise<boolean> {
		if (!this.#pinned) return false;
		return this.#pinned.terminate({ group: true, gracefulMs, timeoutMs: gracefulMs + 1_000 });
	}

	state(): ManagedChildState {
		return {
			pid: this.pid,
			startedAt: this.#startedAt,
			...(this.#pinned ? { identity: this.#pinned.identity() } : {}),
			...this.#fds,
		};
	}
}

/** Spawn `spec` in its own process group with three raw pipes. The env is used exactly as given. */
export function spawnManagedChild(spec: ChildSpawn): ManagedChild {
	const raw = spawnRaw({ application: spec.application, args: spec.args, env: spec.env, cwd: spec.cwd });
	// Nothing has reaped the child yet: this pin is its identity for every later signal.
	const pinned = pinOwnChild(raw.pid);
	return new RawManagedChild(
		{
			pid: raw.pid,
			startedAt: pinned?.startTime() ?? Date.now(),
			stdin: raw.stdin,
			stdout: raw.stdout,
			stderr: raw.stderr,
		},
		pinned,
	);
}

/**
 * Re-attach to a child that survived a re-exec: still this process's child and
 * still exactly the recorded identity (Fura fork), else undefined.
 */
export function adoptChild(state: ManagedChildState): ManagedChild | undefined {
	const pinned = pinIdentity(state.pid, state.identity);
	if (!pinned || pinned.ppid !== process.pid) return undefined;
	return new RawManagedChild(state, pinned);
}
