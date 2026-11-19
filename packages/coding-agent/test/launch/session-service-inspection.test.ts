/**
 * Fura fork: session activity reads one logical session's services from the
 * running daemon without starting it, and reads a service's logs only while
 * that exact unit is still the session's.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalProjectDir } from "../../src/daemon/client";
import { DAEMON_DIR_ENV, projectScope } from "../../src/daemon/protocol";
import { inspectSessionServiceLogs, inspectSessionServices } from "../../src/launch/services";
import { rejection, shProc, TestDaemon } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 30_000;

let daemon: TestDaemon | undefined;
const previousDir = process.env[DAEMON_DIR_ENV];

afterEach(async () => {
	await daemon?.dispose();
	daemon = undefined;
	if (previousDir === undefined) delete process.env[DAEMON_DIR_ENV];
	else process.env[DAEMON_DIR_ENV] = previousDir;
});

async function startDaemon() {
	const started = await TestDaemon.start();
	daemon = started.daemon;
	// The inspection probes the daemon this process would use.
	process.env[DAEMON_DIR_ENV] = started.daemon.dir;
	const projectDir = path.join(started.daemon.root, "project");
	await fs.mkdir(projectDir);
	const scope = projectScope(await canonicalProjectDir(projectDir));
	return { conn: started.conn, projectDir, scope };
}

describe("session service inspection", () => {
	it(
		"lists only the session's services with their tool call, and reads logs only for the listed unit",
		async () => {
			const { conn, projectDir, scope } = await startDaemon();
			const script = "printf 'line-%s\\n' $(seq 1 300); exec sleep 30";
			const mine = await conn.request({
				op: "open",
				kind: "proc",
				scope,
				key: "web",
				proc: shProc(script, projectDir),
				owner: "session-a",
				toolCallId: "call-1",
			});
			await conn.request({
				op: "open",
				kind: "proc",
				scope,
				key: "other",
				proc: shProc("exec sleep 30", projectDir),
				owner: "session-b",
			});

			const listed = await inspectSessionServices(projectDir, "session-a");
			expect(listed.map(unit => [unit.key, unit.toolCallId])).toEqual([["web", "call-1"]]);
			expect(listed[0].id).toBe(mine.unit.id);

			let logs = { text: "", truncated: false };
			for (const deadline = Date.now() + 5_000; Date.now() < deadline; await Bun.sleep(25)) {
				logs = await inspectSessionServiceLogs(projectDir, "session-a", "web", mine.unit.id);
				if (logs.text.includes("line-300")) break;
			}
			const lines = logs.text.split("\n").filter(Boolean);
			expect(lines.at(-1)).toBe("line-300");
			expect(lines.length).toBeLessThanOrEqual(200);
			expect(logs.truncated).toBe(true);

			expect(await rejection(inspectSessionServiceLogs(projectDir, "session-a", "other", "any"))).toContain(
				"unavailable",
			);
			const replaced = await conn.request({
				op: "open",
				kind: "proc",
				scope,
				key: "web",
				proc: shProc("exec sleep 30", projectDir),
				owner: "session-a",
				replace: true,
			});
			expect(replaced.unit.id).not.toBe(mine.unit.id);
			expect(await rejection(inspectSessionServiceLogs(projectDir, "session-a", "web", mine.unit.id))).toContain(
				"unavailable",
			);
		},
		TEST_TIMEOUT_MS,
	);

	it("reports no services and starts nothing when no daemon is running", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-no-daemon-")));
		try {
			process.env[DAEMON_DIR_ENV] = dir;
			expect(await inspectSessionServices(dir, "session-a")).toEqual([]);
			expect(await fs.readdir(dir)).toEqual([]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
