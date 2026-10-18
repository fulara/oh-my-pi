import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	lookupLatestSessionRecap,
	recordSessionRecap,
	closeSessionIndex,
	salvageSessionIndex,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getConfigRootDir, getHistoryDbPath, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("persisted session recaps", () => {
	let directory: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recap-index-"));
		setAgentDir(directory);
		closeSessionIndex();
	});

	afterEach(() => {
		closeSessionIndex();
		setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		removeSyncWithRetries(directory);
	});

	it("migrates legacy rows without changing history schema ownership and orders ties by ID", () => {
		fs.mkdirSync(path.dirname(getHistoryDbPath()), { recursive: true });
		const legacy = new Database(getHistoryDbPath());
		legacy.run(`
			PRAGMA user_version = 73;
			CREATE TABLE session_recaps (
				id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
				cwd TEXT NOT NULL, recap TEXT NOT NULL, created_at INTEGER NOT NULL
				DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES ('a', '/a', 'legacy', 100);
		`);
		legacy.close();

		expect(lookupLatestSessionRecap("a")).toMatchObject({ text: "legacy", sourceLeafId: null, createdAt: 100_000 });
		const first = recordSessionRecap("a", "/a", "first", "leaf-first");
		const second = recordSessionRecap("a", "/a", "second", "leaf-second");
		expect(second?.id).toBeGreaterThan(first!.id);
		const db = new Database(getHistoryDbPath());
		db.run("UPDATE session_recaps SET created_at = 101 WHERE source_leaf_id IS NOT NULL");
		expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 73 });
		db.close();
		expect(lookupLatestSessionRecap("a")).toMatchObject({ id: second!.id, text: "second", createdAt: 101_000 });

		// A reopen must retain both source metadata and deterministic ordering.
		closeSessionIndex();
		expect(lookupLatestSessionRecap("a")?.sourceLeafId).toBe("leaf-second");
		expect(lookupLatestSessionRecap("other")).toBeUndefined();
	});

	it.each([false, true])("salvages recap freshness metadata from legacy/current journals (current=%s)", modern => {
		using source = new Database(":memory:");
		using target = new Database(":memory:");
		source.run(`
			CREATE TABLE session_titles (session_id TEXT, title TEXT, updated_at INTEGER);
			CREATE TABLE session_recaps (
				id INTEGER PRIMARY KEY, session_id TEXT, cwd TEXT, recap TEXT, created_at INTEGER
				${modern ? ", source_leaf_id TEXT" : ""}
			);
		`);
		source
			.query(`INSERT INTO session_recaps VALUES (1, 's', '/project', 'continue review', 123${modern ? ", ?" : ""})`)
			.run(...(modern ? ["review-leaf"] : []));

		expect(salvageSessionIndex(source, target).recaps).toBe(1);
		expect(target.query("SELECT session_id, recap, created_at, source_leaf_id FROM session_recaps").get()).toEqual({
			session_id: "s",
			recap: "continue review",
			created_at: 123,
			source_leaf_id: modern ? "review-leaf" : null,
		});
	});

	it("isolates identical logical IDs across agent-directory profiles", () => {
		recordSessionRecap("same-id", "/a", "profile-a", "leaf-a");
		setAgentDir(path.join(directory, "profile-b"));
		expect(lookupLatestSessionRecap("same-id")).toBeUndefined();
		recordSessionRecap("same-id", "/b", "profile-b", "leaf-b");
		setAgentDir(directory);
		expect(lookupLatestSessionRecap("same-id")?.text).toBe("profile-a");
	});
});
