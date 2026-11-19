/**
 * Fura fork: after a daemon crash the restarted daemon stops or adopts a unit's
 * surviving process only when its recorded native identity still matches.
 * An unverifiable process stays on the board, running, and is never signalled,
 * replaced or restarted.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { pidAlive, rejection, shProc, TestDaemon, until } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 30_000;

let daemon: TestDaemon | undefined;

afterEach(async () => {
	await daemon?.dispose();
	daemon = undefined;
});

function storedIdentity(dbPath: string, key: string): string | null {
	using db = new Database(dbPath, { readonly: true });
	return db.query<{ pid_identity: string | null }, [string]>("SELECT pid_identity FROM units WHERE key = ?").get(key)!
		.pid_identity;
}

function forgeIdentity(dbPath: string, key: string): void {
	using db = new Database(dbPath);
	db.query("UPDATE units SET pid_identity = 'forged' WHERE key = ?").run(key);
}

describe("daemon process identity", () => {
	it(
		"kills an orphan after a crash only when its identity matches, and keeps an unverifiable one visible and running",
		async () => {
			const started = await TestDaemon.start();
			daemon = started.daemon;
			const root = started.daemon.root;
			const verified = await started.conn.openProc("verified", shProc("exec sleep 60", root));
			const forged = await started.conn.openProc("forged", shProc("exec sleep 60", root));
			const verifiedPid = verified.unit.pids[0];
			const forgedPid = forged.unit.pids[0];

			await started.daemon.kill();
			expect(storedIdentity(started.daemon.dbPath, "verified")).toContain(`:${verifiedPid}:`);
			forgeIdentity(started.daemon.dbPath, "forged");

			const next = await started.daemon.spawn();
			expect((await next.describe("verified")).state).toBe("exited");
			await until(() => (pidAlive(verifiedPid) ? undefined : true), "the verified orphan to be killed");

			const unverified = await next.describe("forged");
			expect(unverified.state).toBe("failed");
			expect(unverified.pids).toEqual([forgedPid]);
			expect(unverified.exitReason).toContain("left running");
			expect(await rejection(next.openProc("forged", shProc("exec sleep 60", root), { replace: true }))).toContain(
				"unverified process",
			);
			expect(await rejection(next.request({ op: "restart", unit: "forged" }))).toContain("unverified process");
			expect(pidAlive(forgedPid)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not re-adopt a detached unit whose identity cannot be verified, and never signals or stops it",
		async () => {
			const started = await TestDaemon.start();
			daemon = started.daemon;
			const opened = await started.conn.openProc("detached", shProc("exec sleep 60", started.daemon.root), {
				policy: { hold: "detached" },
			});
			const pid = opened.unit.pids[0];

			await started.daemon.kill();
			forgeIdentity(started.daemon.dbPath, "detached");
			const next = await started.daemon.spawn();
			const unit = await next.describe("detached");
			expect(unit.state).toBe("failed");
			expect(unit.pids).toEqual([pid]);

			// The unit is shown as failed; neither a signal nor a stop reaches the still-running process.
			expect(await rejection(next.request({ op: "send", unit: "detached", signal: "SIGTERM" }))).toContain("failed");
			await next.request({ op: "stop", unit: "detached", timeoutMs: 500 });
			expect(pidAlive(pid)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"stopping a pipe unit through its pinned identity also kills a child that ignores SIGTERM after the root exits",
		async () => {
			const started = await TestDaemon.start();
			daemon = started.daemon;
			const { conn } = started;
			// The root shell dies on TERM; its child ignores TERM and must still be killed.
			const script = "(trap '' TERM; exec sleep 60) & echo child=$!; wait";
			await conn.openProc("stubborn", shProc(script, started.daemon.root));
			const child = await until(async () => {
				const { text } = await conn.request({
					op: "logs",
					unit: "stubborn",
					lines: 5,
					head: false,
					follow: false,
					timeoutMs: 0,
				});
				const match = /child=(\d+)/.exec(text);
				return match ? Number(match[1]) : undefined;
			}, "the child pid in the log");

			await conn.request({ op: "stop", unit: "stubborn", timeoutMs: 500 });
			await until(() => (pidAlive(child) ? undefined : true), "the TERM-ignoring child to be killed", 5_000);
		},
		TEST_TIMEOUT_MS,
	);
});
