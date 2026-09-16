import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { escapeXmlText, parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import type { Skill } from "../extensibility/skills";
import template from "../prompts/skills/session-selection.md" with { type: "text" };
import { type SessionEntry, SESSION_SKILLS_CUSTOM_TYPE } from "./session-entries";
import { type SessionManager, SessionPersistenceIndeterminateError } from "./session-manager";

export interface SessionSkillDescriptor {
	id: string;
	name: string;
	hash: string;
}
export interface SessionSkillCatalogEntry {
	id: string;
	name: string;
	description: string;
	status: "available" | "changed" | "missing";
}
export interface SessionSkillsIdentity {
	sessionId: string;
	journalSessionId: string;
}
export interface SessionSkillsState extends SessionSkillsIdentity {
	revision: string;
	selected: SessionSkillDescriptor[];
	activeRevision: string;
	active: SessionSkillDescriptor[];
	pending: boolean;
	applying: boolean;
	error?: string;
}
export interface SessionSkillsApplyRequest extends SessionSkillsIdentity {
	expectedRevision: string;
	skillIds: string[];
}
export interface SessionSkillsCatalogResult {
	state: SessionSkillsState;
	catalog: SessionSkillCatalogEntry[];
}

interface PinnedSkill extends SessionSkillDescriptor {
	baseDir: string;
	body: string;
	sourceBytes: number;
}
interface SelectionRecord {
	version: 1;
	skills: PinnedSkill[];
}
interface SelectionSnapshot {
	recordId: string;
	skills: readonly PinnedSkill[];
	preamble: string;
}
const MAX_SKILLS = 32;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * MAX_FILE_BYTES;
const MAX_RENDERED_BYTES = 4 * MAX_FILE_BYTES;
const EMPTY: SelectionSnapshot = Object.freeze({ recordId: "empty", skills: Object.freeze([]), preamble: "" });

function render(skills: readonly PinnedSkill[], obfuscate: (text: string) => string): string {
	if (!skills.length) return "";
	// Redact plaintext first: XML entities otherwise disguise configured secrets
	// from the normal provider obfuscation pass while remaining reversible.
	const fields = skills.map(skill => ({
		name: obfuscate(skill.name),
		id: obfuscate(skill.id),
		baseDir: obfuscate(skill.baseDir),
		body: obfuscate(skill.body),
	}));
	// Check the expanded size before allocating escaped bodies. Handlebars only
	// adds the static template around these already XML-escaped values.
	let bytes = Buffer.byteLength(
		prompt.render(template, { skills: skills.map(() => ({ name: "", id: "", baseDir: "", body: "" })) }),
	);
	for (const skill of fields) {
		for (const value of [skill.name, skill.id, skill.baseDir, skill.body]) {
			bytes += Buffer.byteLength(value);
			for (const character of value) {
				if (character === "&") bytes += 4;
				else if (character === "<" || character === ">") bytes += 3;
			}
			if (bytes > MAX_RENDERED_BYTES) throw new Error("Session skill preamble exceeds 4 MiB");
		}
	}
	return prompt.render(template, {
		skills: fields.map(skill => ({
			name: escapeXmlText(skill.name),
			id: escapeXmlText(skill.id),
			baseDir: escapeXmlText(skill.baseDir),
			body: escapeXmlText(skill.body),
		})),
	});
}

function restore(entry: SessionEntry | undefined, obfuscate: (text: string) => string): SelectionSnapshot {
	if (!entry) return EMPTY;
	if (entry.type !== "custom") throw new Error("Invalid session skill metadata");
	const data = entry.data as Partial<SelectionRecord> | undefined;
	if (!data || data.version !== 1 || !Array.isArray(data.skills) || data.skills.length > MAX_SKILLS)
		throw new Error("Invalid session skill metadata version or shape");
	const ids = new Set<string>();
	let bytes = 0;
	const skills: PinnedSkill[] = [];
	for (const skill of data.skills) {
		if (
			!skill ||
			typeof skill.id !== "string" ||
			!path.isAbsolute(skill.id) ||
			ids.has(skill.id) ||
			typeof skill.name !== "string" ||
			typeof skill.baseDir !== "string" ||
			!path.isAbsolute(skill.baseDir) ||
			typeof skill.body !== "string" ||
			!skill.body.isWellFormed() ||
			typeof skill.hash !== "string" ||
			!Number.isInteger(skill.sourceBytes) ||
			skill.sourceBytes < 0 ||
			skill.sourceBytes > MAX_FILE_BYTES
		)
			throw new Error("Invalid session skill metadata definition");
		const bodyBytes = Buffer.byteLength(skill.body);
		if (
			bodyBytes > skill.sourceBytes ||
			new Bun.CryptoHasher("sha256").update(skill.body).digest("hex") !== skill.hash
		)
			throw new Error("Invalid session skill metadata hash or byte bounds");
		bytes += skill.sourceBytes;
		if (bytes > MAX_TOTAL_BYTES) throw new Error("Session skills exceed 2 MiB");
		ids.add(skill.id);
		skills.push(
			Object.freeze({
				id: skill.id,
				name: skill.name,
				hash: skill.hash,
				body: skill.body,
				baseDir: skill.baseDir,
				sourceBytes: skill.sourceBytes,
			}),
		);
	}
	return Object.freeze({ recordId: entry.id, skills: Object.freeze(skills), preamble: render(skills, obfuscate) });
}

function inject(messages: AgentMessage[], snapshot: SelectionSnapshot): AgentMessage[] {
	if (!snapshot.preamble) return messages;
	const index = messages.findIndex(message => message.role === "user");
	const insertion = index < 0 ? 0 : index;
	return [
		...messages.slice(0, insertion),
		{ role: "user", content: snapshot.preamble, timestamp: 0 },
		...messages.slice(insertion),
	];
}

async function canonical(skill: Skill): Promise<string> {
	if (skill.containRoot) {
		const resolved = await resolveContainedPath(skill.containRoot, skill.filePath);
		if (resolved.status !== "ok") throw new Error("Session skill is missing or outside its plugin root");
		return resolved.realPath;
	}
	return fs.realpath(skill.filePath);
}

async function readDefinition(skill: Skill, id: string, remaining: number): Promise<PinnedSkill> {
	if ((await canonical(skill)) !== id) throw new Error("Session skill identity changed; refresh the catalog");
	const handle = await fs.open(id, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		const limit = Math.min(MAX_FILE_BYTES, remaining);
		if (!stat.isFile() || stat.size > limit)
			throw new Error("Session skill must be a regular file within the byte limits");
		const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
		let size = 0;
		while (size < buffer.length) {
			const result = await handle.read(buffer, size, buffer.length - size, size);
			if (!result.bytesRead) break;
			size += result.bytesRead;
		}
		if (size !== stat.size || size > limit) throw new Error("Session skill changed size during read");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
		const after = await handle.stat();
		if ((await canonical(skill)) !== id || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
			throw new Error("Session skill changed during read; refresh the catalog");
		const target = await fs.stat(id);
		if (target.dev !== stat.dev || target.ino !== stat.ino)
			throw new Error("Session skill target changed during read");
		const body = parseFrontmatter(text, { source: id, normalize: false, repair: false }).body.trim();
		return Object.freeze({
			id,
			name: skill.name,
			baseDir: skill.baseDir,
			body,
			sourceBytes: size,
			hash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
		});
	} finally {
		await handle.close();
	}
}

/** Session-owned durable configuration. Never reads skill files on the model-call path. */
export class SessionSkills {
	#epoch = Bun.randomUUIDv7();
	#journalId: string | undefined;
	#leaf: SessionEntry | undefined;
	#snapshot = EMPTY;
	#active = EMPTY;
	#activeRevision = "";
	#invalid: string | undefined;
	#uncertain: string | undefined;
	#settled: Promise<void> | undefined;
	#resolveSettled: (() => void) | undefined;

	constructor(
		readonly manager: SessionManager,
		readonly identity: () => SessionSkillsIdentity,
		readonly skills: () => readonly Skill[],
		readonly busy: () => boolean,
		readonly unavailable: () => boolean,
		readonly emit: (state: SessionSkillsState) => void,
		readonly obfuscate: (text: string) => string,
	) {}

	get applying(): boolean {
		return this.#settled !== undefined;
	}
	async waitForApply(): Promise<void> {
		while (this.#settled) await this.#settled;
	}
	beginTransition(): void {
		if (this.applying) throw new Error("Session skills Apply is in progress");
		this.#epoch = Bun.randomUUIDv7();
	}

	#ancestry(boundary: SessionEntry | undefined): {
		latest: SessionEntry | undefined;
		includesBoundary: boolean;
	} {
		const seen = new Set<string>();
		let id = this.manager.getLeafId();
		let latest: SessionEntry | undefined;
		let includesBoundary = boundary === undefined;
		// Entries are mutable, so even a cached leaf/boundary must be checked
		// through to the root before trusting its selection.
		while (id !== null) {
			if (seen.has(id)) throw new Error("Invalid session skill ancestry: cycle");
			seen.add(id);
			const entry = this.manager.getEntry(id);
			if (!entry) throw new Error("Invalid session skill ancestry: missing entry");
			if (entry === boundary) includesBoundary = true;
			if (!latest && entry.type === "custom" && entry.customType === SESSION_SKILLS_CUSTOM_TYPE) latest = entry;
			id = entry.parentId;
		}
		return { latest, includesBoundary };
	}

	#reconcile(): void {
		if (this.applying) return;
		const journalId = this.manager.getSessionId();
		const leafId = this.manager.getLeafId();
		const leaf = leafId ? this.manager.getEntry(leafId) : undefined;
		let latest: SessionEntry | undefined;
		let includesBoundary: boolean;
		try {
			({ latest, includesBoundary } = this.#ancestry(this.#leaf));
		} catch (error) {
			if (journalId !== this.#journalId || leaf !== this.#leaf || !this.#invalid) this.#epoch = Bun.randomUUIDv7();
			this.#journalId = journalId;
			this.#leaf = leaf;
			this.#snapshot = EMPTY;
			this.#invalid = error instanceof Error ? error.message : String(error);
			return;
		}
		const continuesBranch = journalId === this.#journalId && includesBoundary;
		if (!continuesBranch) {
			this.#epoch = Bun.randomUUIDv7();
			// A branch cut is not authoritative persistence recovery. Only a new
			// journal or freshly loaded entry objects release an uncertain latch.
			if (journalId !== this.#journalId || (this.#leaf && this.manager.getEntry(this.#leaf.id) !== this.#leaf)) {
				this.#uncertain = undefined;
			}
		}
		this.#journalId = journalId;
		this.#leaf = leaf;
		if (continuesBranch && !this.#invalid && (latest?.id ?? EMPTY.recordId) === this.#snapshot.recordId) return;
		try {
			this.#snapshot = restore(latest, this.obfuscate);
			this.#invalid = undefined;
		} catch (error) {
			this.#snapshot = EMPTY;
			this.#invalid = error instanceof Error ? error.message : String(error);
		}
	}

	state(): SessionSkillsState {
		this.#reconcile();
		const revision = `${this.#epoch}:${this.#snapshot.recordId}`;
		const active = this.busy() && this.#activeRevision ? this.#active : this.#snapshot;
		const activeRevision = this.busy() && this.#activeRevision ? this.#activeRevision : revision;
		return {
			...this.identity(),
			revision,
			selected: this.#snapshot.skills.map(({ id, name, hash }) => ({ id, name, hash })),
			activeRevision,
			active: active.skills.map(({ id, name, hash }) => ({ id, name, hash })),
			pending: activeRevision !== revision,
			applying: this.applying,
			...((this.#invalid ?? this.#uncertain) ? { error: this.#invalid ?? this.#uncertain } : {}),
		};
	}

	capture(messages: AgentMessage[]): AgentMessage[] {
		this.#reconcile();
		if (this.#invalid) throw new Error(this.#invalid);
		const snapshot = this.#snapshot;
		const revision = `${this.#epoch}:${snapshot.recordId}`;
		const changed = revision !== this.#activeRevision;
		this.#active = snapshot;
		this.#activeRevision = revision;
		if (changed) this.emit(this.state());
		return inject(messages, snapshot);
	}

	get activeRevision(): string {
		return this.#activeRevision;
	}
	static fromSnapshot(
		messages: AgentMessage[],
		entries: readonly SessionEntry[],
		obfuscate: (text: string) => string,
	): AgentMessage[] {
		const latest = entries.findLast(
			entry => entry.type === "custom" && entry.customType === SESSION_SKILLS_CUSTOM_TYPE,
		);
		return inject(messages, restore(latest, obfuscate));
	}

	#validate(identity: SessionSkillsIdentity, revision?: string): SessionSkillsState {
		const state = this.state();
		if (identity.sessionId !== state.sessionId || identity.journalSessionId !== state.journalSessionId)
			throw new Error("Session skills identity changed; refresh state");
		if (revision !== undefined && revision !== state.revision)
			throw new Error("Session skills revision conflict; refresh state");
		return state;
	}

	async catalog(identity: SessionSkillsIdentity): Promise<SessionSkillsCatalogResult> {
		const state = this.#validate(identity);
		identity = { sessionId: identity.sessionId, journalSessionId: identity.journalSessionId };
		const selected = this.#snapshot.skills;
		const catalog = new Map<string, SessionSkillCatalogEntry>();
		for (const skill of this.skills()) {
			let id: string;
			try {
				id = await canonical(skill);
			} catch {
				continue;
			}
			if (catalog.has(id)) continue;
			const pinned = selected.find(item => item.id === id);
			let status: SessionSkillCatalogEntry["status"] = "available";
			if (pinned) {
				try {
					if ((await readDefinition(skill, id, MAX_FILE_BYTES)).hash !== pinned.hash) status = "changed";
				} catch {
					status = "missing";
				}
			}
			catalog.set(id, { id, name: skill.name, description: skill.description, status });
		}
		for (const pinned of selected) {
			if (!catalog.has(pinned.id))
				catalog.set(pinned.id, { id: pinned.id, name: pinned.name, description: "", status: "missing" });
		}
		const current = this.#validate(identity, state.revision);
		return { state: current, catalog: [...catalog.values()] };
	}

	async apply(request: SessionSkillsApplyRequest): Promise<SessionSkillsState> {
		if (typeof request.expectedRevision !== "string") throw new Error("Session skills require an expected revision");
		this.#validate(request, request.expectedRevision);
		if (this.unavailable() || this.applying)
			throw new Error("Session skills are unavailable during a session transition or another Apply");
		if (!this.manager.getSessionFile()) throw new Error("Session skills require a persistent session");
		if (this.#invalid || this.#uncertain) throw new Error(this.#invalid ?? this.#uncertain);
		if (
			!Array.isArray(request.skillIds) ||
			request.skillIds.length > MAX_SKILLS ||
			request.skillIds.some(id => typeof id !== "string") ||
			new Set(request.skillIds).size !== request.skillIds.length
		)
			throw new Error("Invalid session skill selection (maximum 32 unique IDs)");
		request = {
			sessionId: request.sessionId,
			journalSessionId: request.journalSessionId,
			expectedRevision: request.expectedRevision,
			skillIds: [...request.skillIds],
		};
		const settled = Promise.withResolvers<void>();
		this.#settled = settled.promise;
		this.#resolveSettled = settled.resolve;
		const startingLeaf = this.#leaf;
		this.emit(this.state());
		try {
			const available = new Map<string, Skill>();
			for (const skill of this.skills()) {
				try {
					const id = await canonical(skill);
					if (!available.has(id)) available.set(id, skill);
				} catch {
					/* Missing/disallowed definitions are not selectable. */
				}
			}
			const skills: PinnedSkill[] = [];
			let remaining = MAX_TOTAL_BYTES;
			for (const id of request.skillIds) {
				const source = available.get(id);
				if (!source) throw new Error("Session skill is missing or no longer in the discovered catalog");
				const skill = await readDefinition(source, id, remaining);
				skills.push(skill);
				remaining -= skill.sourceBytes;
			}
			const preamble = render(skills, this.obfuscate);
			const recordId = await this.manager.appendEntriesAtomically(() => {
				this.#validate(request, request.expectedRevision);
				if (this.unavailable()) throw new Error("Session changed before skill commit");
				// Normal transcript appends are allowed. A branch replacement is not.
				const ancestry = this.#ancestry(startingLeaf);
				if (!ancestry.includesBoundary || (ancestry.latest?.id ?? EMPTY.recordId) !== this.#snapshot.recordId)
					throw new Error("Session skill ancestry changed before commit");
				return this.manager.appendCustomEntry(SESSION_SKILLS_CUSTOM_TYPE, {
					version: 1,
					skills,
				} satisfies SelectionRecord);
			});
			this.#snapshot = Object.freeze({ recordId, skills: Object.freeze(skills), preamble });
			this.#leaf = this.manager.getEntry(recordId);
		} catch (error) {
			if (error instanceof SessionPersistenceIndeterminateError)
				this.#uncertain = "Session skill persistence is uncertain; reopen the session before changing skills";
			throw error;
		} finally {
			this.#settled = undefined;
			this.#resolveSettled?.();
			this.#resolveSettled = undefined;
			this.emit(this.state());
		}
		return this.state();
	}
}
