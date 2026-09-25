import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { obfuscateProviderContext, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION, SESSION_SKILLS_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	SessionManager,
	SessionPersistenceIndeterminateError,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionSkills } from "@oh-my-pi/pi-coding-agent/session/session-skills";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanup.length) await cleanup.pop()!();
});

class SkillCommitStorage extends MemorySessionStorage {
	gate?: { entered: () => void; release: Promise<void>; fail: boolean };
	override async writeTextAtomic(file: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const gate = this.gate;
		this.gate = undefined;
		if (gate) {
			gate.entered();
			await gate.release;
			if (gate.fail) throw new Error("skill atomic publish failed");
		}
		await super.writeTextAtomic(file, content, options);
	}
}

async function harness(
	options: {
		manager?: SessionManager;
		skills?: Skill[];
		transform?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
		extensionRunner?: ExtensionRunner;
		inMemory?: boolean;
		responses?: MockResponseSource;
		tools?: AgentTool[];
		obfuscator?: SecretObfuscator;
	} = {},
) {
	const dir = TempDir.createSync("@pi-session-skills-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("mock", "test-key");
	const mock = createMockModel(
		options.responses ? { responses: options.responses } : { handler: () => ({ content: ["acknowledged"] }) },
	);
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const secret =
		options.obfuscator ??
		new SecretObfuscator([{ type: "plain", content: "session-skill-secret-123456" }], "test-key");
	const agent = new Agent({
		initialState: { model: mock, systemPrompt: ["System priority unchanged"], tools: options.tools ?? [] },
		getApiKey: () => "test-key",
		streamFn: mock.stream,
		convertToLlm,
		transformContext: options.transform,
		transformProviderContext: context => obfuscateProviderContext(secret, context),
	});
	const manager =
		options.manager ??
		(options.inMemory
			? SessionManager.inMemory(dir.path())
			: SessionManager.create(dir.path(), path.join(dir.path(), "sessions")));
	const skills = options.skills ?? [];
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		skills,
		skillsReloadable: false,
		obfuscator: secret,
		sideStreamFn: mock.stream,
		modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
		extensionRunner: options.extensionRunner,
	});
	cleanup.push(async () => {
		await session.dispose();
		auth.close();
		dir.removeSync();
	});
	async function skill(name: string, body: string, containRoot?: string): Promise<string> {
		const filePath = path.join(dir.path(), name, "SKILL.md");
		await Bun.write(filePath, `---\nname: ${name}\ndescription: fixture\n---\n${body}`);
		const id = await fs.realpath(filePath);
		skills.push({
			name,
			description: "fixture",
			filePath,
			baseDir: path.dirname(filePath),
			source: "test",
			containRoot,
		});
		return id;
	}
	return { session, agent, manager, mock, skill, skills, dir };
}
function apply(session: AgentSession, skillIds: string[]) {
	const state = session.getSessionSkillsState();
	return session.setSessionSkills({
		sessionId: state.sessionId,
		journalSessionId: state.journalSessionId,
		expectedRevision: state.revision,
		skillIds,
	});
}
function text(context: Context): string {
	return JSON.stringify(context.messages);
}

describe("AgentSession session skills", () => {
	// Run ancestry regressions under an external process deadline when testing
	// older source: Bun's same-thread test timeout cannot interrupt these loops.
	for (const shape of ["valid chain", "self-cycle", "multi-node cycle", "missing parent"] as const) {
		it(`validates loaded skill ancestry: ${shape}`, async () => {
			const storage = new MemorySessionStorage();
			const cwd = "/skill-ancestry";
			const file = `${cwd}/sessions/fixture.jsonl`;
			const timestamp = "2026-01-01T00:00:00.000Z";
			const body = "OLDER_SELECTION";
			const selection = {
				type: "custom",
				id: "selection",
				parentId: shape === "missing parent" ? "missing" : "root",
				timestamp,
				customType: SESSION_SKILLS_CUSTOM_TYPE,
				data: {
					version: 1,
					skills: [
						{
							id: `${cwd}/SKILL.md`,
							name: "older",
							baseDir: cwd,
							body,
							hash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
							sourceBytes: Buffer.byteLength(body),
						},
					],
				},
			};
			const rows = [
				{ type: "session", version: CURRENT_SESSION_VERSION, id: "ancestry", timestamp, cwd },
				{ type: "message", id: "root", parentId: null, timestamp, message: userMsg("root") },
				selection,
				{
					type: "message",
					id: "a",
					parentId: shape === "multi-node cycle" ? "b" : "selection",
					timestamp,
					message: userMsg("middle"),
				},
				{
					type: "message",
					id: "b",
					parentId: shape === "self-cycle" ? "b" : "a",
					timestamp,
					message: userMsg("leaf"),
				},
			];
			await storage.writeText(file, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
			const manager = await SessionManager.open(file, `${cwd}/sessions`, storage, { suppressBreadcrumb: true });
			const skills = new SessionSkills(
				manager,
				() => ({ sessionId: "runtime", journalSessionId: manager.getSessionId() }),
				() => [],
				() => false,
				() => false,
				() => {},
				text => text,
			);
			const journal = await storage.readText(file);
			const entries = structuredClone(manager.getEntries());
			const state = skills.state();
			if (shape === "valid chain") {
				expect(state.error).toBeUndefined();
				expect(state.selected.map(skill => skill.name)).toEqual(["older"]);
				expect(JSON.stringify(skills.capture([userMsg("task")]))).toContain(body);
				manager.appendMessage(userMsg("incremental"));
				expect(skills.state().revision).toBe(state.revision);
				expect(skills.state().selected).toEqual(state.selected);
			} else {
				expect(state.error).toBeDefined();
				expect(state.selected).toEqual([]);
				expect(state.active).toEqual([]);
				expect(skills.state()).toEqual(state);
				expect(() => skills.capture([userMsg("must fail")])).toThrow();
				await expect(skills.apply({ ...state, expectedRevision: state.revision, skillIds: [] })).rejects.toThrow();
				expect(manager.getEntries()).toEqual(entries);
				expect(await storage.readText(file)).toBe(journal);
				// New valid metadata cannot turn an invalid cached boundary into
				// an accepted branch or resurrect the older pinned selection.
				manager.appendCustomEntry(SESSION_SKILLS_CUSTOM_TYPE, selection.data);
				expect(skills.state().error).toBeDefined();
				expect(skills.state().selected).toEqual([]);
				expect(() => skills.capture([userMsg("still invalid")])).toThrow();
			}
			await manager.flush();
		});
	}

	it("rejects skill ancestry mutated behind an unchanged cached leaf", async () => {
		const h = await harness();
		const root = h.manager.appendMessage(userMsg("root"));
		await apply(h.session, [await h.skill("alpha", "OLDER_SELECTION")]);
		h.manager.appendMessage(userMsg("cached leaf"));
		expect(h.session.getSessionSkillsState().selected).toHaveLength(1);
		const entry = h.manager.getEntry(root)!;
		const parentId = entry.parentId;
		try {
			entry.parentId = "missing";
			expect(h.session.getSessionSkillsState().error).toBeDefined();
			expect(h.session.getSessionSkillsState().selected).toEqual([]);
			await expect(apply(h.session, [])).rejects.toThrow();
			await h.agent.prompt("must not reach provider");
			expect(h.mock.calls).toHaveLength(0);
		} finally {
			entry.parentId = parentId;
		}
	});

	for (const mutation of [
		"valid append",
		"self-cycle",
		"multi-node cycle",
		"missing parent",
		"starting leaf cycle",
		"older ancestor cycle",
	] as const) {
		it(`revalidates skill ancestry during Apply: ${mutation}`, async () => {
			const storage = new MemorySessionStorage();
			const manager = SessionManager.create("/skill-apply", "/skill-apply/sessions", storage);
			const h = await harness({ manager });
			const root = manager.appendMessage(userMsg("root"));
			const a = await h.skill("alpha", "OLDER_SELECTION");
			const b = await h.skill("beta", "MUST_NOT_COMMIT");
			await apply(h.session, [a]);
			const startingLeaf = manager.appendMessage(userMsg("starting leaf"));
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const original = manager.appendEntriesAtomically.bind(manager);
			const spy = spyOn(manager, "appendEntriesAtomically").mockImplementation(async append => {
				entered.resolve();
				await release.promise;
				return original(append);
			});
			const pending = apply(h.session, [b]);
			await entered.promise;
			let changed = manager.getEntry(startingLeaf)!;
			let parentId = changed.parentId;
			try {
				if (mutation === "valid append") {
					manager.appendMessage(userMsg("concurrent transcript"));
				} else if (mutation === "starting leaf cycle" || mutation === "older ancestor cycle") {
					changed = manager.getEntry(mutation === "starting leaf cycle" ? startingLeaf : root)!;
					parentId = changed.parentId;
					changed.parentId = changed.id;
				} else {
					const first = manager.appendMessage(userMsg("concurrent first"));
					const second =
						mutation === "multi-node cycle" ? manager.appendMessage(userMsg("concurrent second")) : first;
					changed = manager.getEntry(first)!;
					parentId = changed.parentId;
					changed.parentId = mutation === "missing parent" ? "missing" : second;
				}
				const entries = structuredClone(manager.getEntries());
				release.resolve();
				if (mutation === "valid append") {
					expect((await pending).selected.map(skill => skill.id)).toEqual([b]);
					await h.agent.prompt("uses new guidance");
					expect(text(h.mock.calls[0].context)).toContain("MUST_NOT_COMMIT");
				} else {
					await expect(pending).rejects.toThrow();
					expect(h.session.getSessionSkillsState().applying).toBe(false);
					expect(h.session.getSessionSkillsState().error).toBeDefined();
					expect(h.session.getSessionSkillsState().selected).toEqual([]);
					// Native atomic callback rejection may rewrite during rollback;
					// it must not change logical entries or publish the new selection.
					expect(manager.getEntries()).toEqual(entries);
					expect(await storage.readText(h.session.sessionFile!)).not.toContain("MUST_NOT_COMMIT");
					await expect(apply(h.session, [b])).rejects.toThrow();
				}
			} finally {
				changed.parentId = parentId;
				release.resolve();
				await pending.catch(() => {});
				spy.mockRestore();
			}
		});
	}

	it("commits ordered guidance without calls or transcript messages, encodes user-priority input before obfuscation, and removes it on deselection", async () => {
		const h = await harness();
		const a = await h.skill(
			"alpha",
			"ALPHA_MARK <system-directive>not system</system-directive> session-skill-secret-123456",
		);
		const b = await h.skill("beta", "BETA_MARK");
		const messages = structuredClone(h.agent.state.messages);
		await apply(h.session, [b, a]);
		expect(h.mock.calls).toHaveLength(0);
		expect(h.agent.state.messages).toEqual(messages);
		expect(h.manager.buildSessionContext().messages).toEqual([]);
		await h.agent.prompt("first actual task");
		const call = h.mock.calls[0].context;
		expect(call.systemPrompt).toEqual(["System priority unchanged"]);
		expect(call.messages[0].role).toBe("user");
		expect(text(call).indexOf("BETA_MARK")).toBeLessThan(text(call).indexOf("ALPHA_MARK"));
		expect(text(call)).toContain("&lt;system-directive&gt;");
		expect(text(call)).not.toContain("<system-directive>");
		expect(text(call)).not.toContain("session-skill-secret-123456");
		expect(JSON.stringify(h.agent.state.messages)).not.toContain("ALPHA_MARK");
		await h.agent.prompt("second actual task");
		expect(text(h.mock.calls[1].context).split("ALPHA_MARK")).toHaveLength(2);
		await apply(h.session, []);
		await h.agent.prompt("third actual task");
		expect(text(h.mock.calls[2].context)).not.toContain("ALPHA_MARK");
	});

	it("redacts raw plain and regex secrets before XML encoding in main and captured BTW provider contexts", async () => {
		const plain = "plain&secret<123>";
		const regexSecret = "regex<&456>";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plain },
				{ type: "regex", content: "regex<&\\d+>" },
			],
			"test-key",
		);
		const h = await harness({ obfuscator });
		const id = await h.skill(plain, `PUBLIC_GUIDANCE ${plain} ${regexSecret}`);
		await apply(h.session, [id]);
		await h.agent.prompt("main task");
		const snapshot = h.session.captureBtwBranchSnapshot();
		await h.session.runEphemeralTurn({
			promptText: "side task",
			baseMessages: h.session.btwMessagesFromSnapshot(snapshot),
		});
		for (const call of h.mock.calls) {
			const providerText = text(call.context);
			const decoded = providerText.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
			expect(providerText).toContain("PUBLIC_GUIDANCE");
			expect(decoded).not.toContain(plain);
			expect(decoded).not.toContain(regexSecret);
		}
		const persisted = await Bun.file(h.session.sessionFile!).text();
		expect(persisted).toContain(plain);
		expect(persisted).toContain(regexSecret);
	});

	it("keeps committed guidance in a tool-loop request while a deferred shutdown hook is running", async () => {
		const toolEntered = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		const shutdownEntered = Promise.withResolvers<void>();
		const releaseShutdown = Promise.withResolvers<void>();
		const nextRequest = Promise.withResolvers<void>();
		const runner = {
			hasHandlers: (event: string) => event === "session_shutdown",
			emit: async (event: { type: string }) => {
				if (event.type === "session_shutdown") {
					shutdownEntered.resolve();
					await releaseShutdown.promise;
				}
			},
		} as unknown as ExtensionRunner;
		const tool: AgentTool = {
			name: "held",
			label: "Held",
			description: "Wait for release",
			parameters: type({}),
			execute: async () => {
				toolEntered.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "released" }] };
			},
		};
		const h = await harness({
			extensionRunner: runner,
			tools: [tool],
			responses: [
				{ content: [{ type: "toolCall", id: "held", name: "held", arguments: {} }], stopReason: "toolUse" },
				() => {
					nextRequest.resolve();
					return { content: ["finished"] };
				},
			],
		});
		await apply(h.session, [await h.skill("alpha", "GUIDANCE_DURING_SHUTDOWN")]);
		const run = h.agent.prompt("task");
		await toolEntered.promise;
		const disposing = h.session.dispose();
		await shutdownEntered.promise;
		try {
			releaseTool.resolve();
			await nextRequest.promise;
			expect(text(h.mock.calls[1].context)).toContain("GUIDANCE_DURING_SHUTDOWN");
		} finally {
			releaseShutdown.resolve();
			await run;
			await disposing;
		}
	});

	it("parses CRLF frontmatter without injecting metadata or rewriting the pinned body", async () => {
		const h = await harness();
		const id = await h.skill("alpha", "initial");
		const body = "BODY_FIRST\r\n<!-- keep this body comment -->\r\nBODY_LAST";
		await Bun.write(id, `---\r\nname: alpha\r\ndescription: METADATA_NOT_GUIDANCE\r\n---\r\n${body}\r\n`);
		await apply(h.session, [id]);
		await h.agent.prompt("task");
		expect(text(h.mock.calls[0].context)).toContain("BODY_FIRST");
		expect(text(h.mock.calls[0].context)).not.toContain("METADATA_NOT_GUIDANCE");
		expect(h.session.getSessionSkillsState().selected[0].hash).toBe(
			new Bun.CryptoHasher("sha256").update(body).digest("hex"),
		);
	});

	it("freezes a request before async transforms and applies busy changes only at the next provider request", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let block = false;
		const h = await harness({
			transform: async messages => {
				if (block) {
					block = false;
					entered.resolve();
					await release.promise;
				}
				return messages;
			},
		});
		const a = await h.skill("alpha", "OLD_MARK");
		const b = await h.skill("beta", "NEXT_MARK");
		const old = await apply(h.session, [a]);
		block = true;
		const turn = h.agent.prompt("task");
		await entered.promise;
		try {
			const next = await apply(h.session, [b]);
			expect(next.pending).toBe(true);
			expect(next.activeRevision).toBe(old.revision);
			expect(next.active.map(x => x.id)).toEqual([a]);
		} finally {
			release.resolve();
		}
		await turn;
		expect(text(h.mock.calls[0].context)).toContain("OLD_MARK");
		expect(text(h.mock.calls[0].context)).not.toContain("NEXT_MARK");
		await h.agent.prompt("next");
		expect(text(h.mock.calls[1].context)).toContain("NEXT_MARK");
		expect(h.session.getSessionSkillsState().pending).toBe(false);
	});

	it("reopens pinned definitions, survives compaction and clear, forks ancestry, restores rewind and starts new empty", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "PINNED_MARK");
		const first = await apply(h.session, [a]);
		const selectedLeaf = h.manager.getLeafId()!;
		const user = h.manager.appendMessage(userMsg("history"));
		h.manager.appendMessage(assistantMsg("answer"));
		h.manager.appendCompaction("summary", undefined, user, 100);
		h.agent.replaceMessages(h.manager.buildSessionContext().messages);
		await h.agent.prompt("after compaction");
		expect(text(h.mock.calls.at(-1)!.context)).toContain("PINNED_MARK");
		await h.manager.flush();
		await Bun.write(a, "changed source");
		const resumed = await harness({ manager: await SessionManager.open(h.session.sessionFile!), skills: h.skills });
		expect(resumed.session.getSessionSkillsState().revision).not.toBe(first.revision);
		await resumed.agent.prompt("after reopen");
		expect(text(resumed.mock.calls[0].context)).toContain("PINNED_MARK");
		await resumed.session.resetSessionContext();
		expect(resumed.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([a]);
		await resumed.agent.prompt("after context reset");
		expect(text(resumed.mock.calls.at(-1)!.context)).toContain("PINNED_MARK");
		await resumed.session.fork();
		expect(resumed.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([a]);
		await resumed.agent.prompt("after fork");
		expect(text(resumed.mock.calls.at(-1)!.context)).toContain("PINNED_MARK");
		// The resumed manager wrote the source journal before forking. Reopen it
		// before another writer edits that history; stale writes must be rejected.
		await h.session.switchSession(h.session.sessionFile!);
		await apply(h.session, []);
		await h.agent.prompt("before rewind without guidance");
		expect(text(h.mock.calls.at(-1)!.context)).not.toContain("PINNED_MARK");
		await h.session.navigateTree(selectedLeaf);
		expect(h.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([a]);
		await h.agent.prompt("after rewind");
		expect(text(h.mock.calls.at(-1)!.context)).toContain("PINNED_MARK");
		await h.session.newSession();
		expect(h.session.getSessionSkillsState().selected).toEqual([]);
		await h.agent.prompt("after new session");
		expect(text(h.mock.calls.at(-1)!.context)).not.toContain("PINNED_MARK");
	});

	it("preserves a near-limit pinned body and hash through real journal persistence and reopen", async () => {
		const h = await harness();
		const body = `${"B".repeat(1024 * 1024 - 128)}PINNED_BODY_END`;
		const id = await h.skill("large", body);
		const selected = await apply(h.session, [id]);
		const resumed = await harness({ manager: await SessionManager.open(h.session.sessionFile!), skills: h.skills });
		expect(resumed.session.getSessionSkillsState().error).toBeUndefined();
		expect(resumed.session.getSessionSkillsState().selected).toEqual(selected.selected);
		await resumed.agent.prompt("use the pinned guidance after reopen");
		expect(text(resumed.mock.calls[0].context).includes(body)).toBe(true);
	});

	it("rejects stale CAS and both identities, including cancelled-transition ABA and provider identity rotation", async () => {
		const runner = {
			hasHandlers: (type: string) => type === "session_before_switch",
			emit: async () => ({ cancel: true }),
		} as unknown as ExtensionRunner;
		const h = await harness({ extensionRunner: runner });
		const a = await h.skill("alpha", "A");
		const state = await apply(h.session, [a]);
		const request = {
			sessionId: state.sessionId,
			journalSessionId: state.journalSessionId,
			expectedRevision: state.revision,
			skillIds: [],
		};
		await expect(h.session.setSessionSkills({ ...request, sessionId: "wrong" })).rejects.toThrow();
		await expect(h.session.setSessionSkills({ ...request, journalSessionId: "wrong" })).rejects.toThrow();
		await expect(
			h.session.setSessionSkills({ ...request, expectedRevision: undefined as unknown as string }),
		).rejects.toThrow();
		await apply(h.session, []);
		await expect(h.session.setSessionSkills(request)).rejects.toThrow();
		const before = h.session.getSessionSkillsState();
		await h.session.newSession();
		expect(h.session.getSessionSkillsState().revision).not.toBe(before.revision);
		const fresh = h.session.getSessionSkillsState();
		h.session.freshSession();
		await expect(
			h.session.setSessionSkills({ ...fresh, expectedRevision: fresh.revision, skillIds: [] }),
		).rejects.toThrow();
	});

	it("keeps missing pinned skills usable and deselectable, refreshes unchanged selections explicitly, and rejects arbitrary paths", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "OLD_MARK");
		const old = await apply(h.session, [a]);
		await Bun.write(a, "NEW_MARK");
		let catalog = await h.session.getSessionSkillsCatalog(old);
		expect(catalog.catalog.find(x => x.id === a)?.status).toBe("changed");
		await apply(h.session, [a]);
		await h.agent.prompt("refreshed");
		expect(text(h.mock.calls[0].context)).toContain("NEW_MARK");
		await fs.unlink(a);
		catalog = await h.session.getSessionSkillsCatalog(h.session.getSessionSkillsState());
		expect(catalog.catalog.find(x => x.id === a)?.status).toBe("missing");
		await expect(apply(h.session, [a])).rejects.toThrow();
		await h.agent.prompt("still pinned");
		expect(text(h.mock.calls[1].context)).toContain("NEW_MARK");
		const unrelated = path.join(h.dir.path(), "unrelated.txt");
		await Bun.write(unrelated, "must not select");
		await expect(apply(h.session, [unrelated])).rejects.toThrow();
		await apply(h.session, []);
		expect(h.session.getSessionSkillsState().selected).toEqual([]);
	});

	it("enforces canonical identity, plugin containment and alias deduplication", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "A");
		const b = await h.skill("beta", "B");
		const root = await fs.realpath(path.dirname(a));
		const alias = path.join(root, "alias.md");
		await fs.symlink(a, alias);
		h.skills.push({
			name: "alias",
			description: "alias",
			filePath: alias,
			baseDir: root,
			source: "test",
			containRoot: root,
		});
		let catalog = await h.session.getSessionSkillsCatalog(h.session.getSessionSkillsState());
		expect(catalog.catalog.filter(x => x.id === a)).toHaveLength(1);
		h.skills.splice(0, 2);
		await fs.unlink(alias);
		await fs.symlink(b, alias);
		await expect(apply(h.session, [a])).rejects.toThrow();
		await expect(apply(h.session, [b])).rejects.toThrow();
		catalog = await h.session.getSessionSkillsCatalog(h.session.getSessionSkillsState());
		expect(catalog.catalog.some(x => x.id === b)).toBe(false);
	});

	it("rejects invalid UTF-8, oversized files, aggregate bytes, duplicate IDs and oversized encoded preambles atomically", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "valid");
		await apply(h.session, [a]);
		const baseline = h.session.getSessionSkillsState();
		await Bun.write(a, new Uint8Array([0xc3, 0x28]));
		await expect(apply(h.session, [a])).rejects.toThrow();
		await Bun.write(a, "é".repeat(524289));
		await expect(apply(h.session, [a])).rejects.toThrow();
		await Bun.write(a, "a".repeat(800000));
		const b = await h.skill("beta", "b".repeat(800000));
		const c = await h.skill("gamma", "c".repeat(800000));
		await expect(apply(h.session, [a, b, c])).rejects.toThrow();
		await expect(apply(h.session, [a, a])).rejects.toThrow();
		await Bun.write(a, "&".repeat(900000));
		await expect(apply(h.session, [a])).rejects.toThrow();
		expect(h.session.getSessionSkillsState().revision).toBe(baseline.revision);
	});

	it("revalidates journal identity at synchronous staging after a deferred SDK persistence boundary", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "MUST_NOT_COMMIT");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = h.manager.appendEntriesAtomically.bind(h.manager);
		const spy = spyOn(h.manager, "appendEntriesAtomically").mockImplementation(async append => {
			entered.resolve();
			await release.promise;
			return original(append);
		});
		const pending = apply(h.session, [a]);
		await entered.promise;
		await h.manager.newSession();
		release.resolve();
		await expect(pending).rejects.toThrow();
		spy.mockRestore();
		expect(h.session.getSessionSkillsState().selected).toEqual([]);
		expect(JSON.stringify(h.manager.getEntries())).not.toContain("MUST_NOT_COMMIT");
	});

	it("publishes only after atomic persistence, excludes staged entries from main and BTW, and guards lifecycle and final identity", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "A_MARK");
		const b = await h.skill("beta", "B_MARK");
		const initial = await apply(h.session, [a]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = h.manager.appendEntriesAtomically.bind(h.manager);
		const spy = spyOn(h.manager, "appendEntriesAtomically").mockImplementation(async append => {
			entered.resolve();
			await release.promise;
			return original(append);
		});
		const pending = apply(h.session, [b]);
		await entered.promise;
		try {
			expect(h.session.getSessionSkillsState().selected).toEqual(initial.selected);
			expect(h.session.getSessionSkillsState().applying).toBe(true);
			expect(() => h.session.captureBtwBranchSnapshot()).toThrow();
			await expect(h.session.newSession()).rejects.toThrow();
			expect(() => h.session.freshSession()).toThrow();
			await h.agent.prompt("during apply");
			expect(text(h.mock.calls[0].context)).toContain("A_MARK");
			expect(text(h.mock.calls[0].context)).not.toContain("B_MARK");
		} finally {
			release.resolve();
		}
		await pending;
		spy.mockRestore();
		expect(h.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([b]);
	});

	it("reports uncertain durability persistently, preserves prior context, blocks mutations, and fails closed on corrupt latest metadata", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "COMMITTED_MARK");
		const baseline = await apply(h.session, [a]);
		const spy = spyOn(h.manager, "appendEntriesAtomically").mockRejectedValueOnce(new Error("publish failed"));
		await expect(apply(h.session, [])).rejects.toThrow("publish failed");
		expect(h.session.getSessionSkillsState().revision).toBe(baseline.revision);
		spy.mockRejectedValueOnce(new SessionPersistenceIndeterminateError(new Error("publish"), [new Error("repair")]));
		await expect(apply(h.session, [])).rejects.toThrow();
		expect(h.session.getSessionSkillsState().error).toBeDefined();
		spy.mockRestore();
		await expect(apply(h.session, [])).rejects.toThrow();
		await h.agent.prompt("old committed");
		expect(text(h.mock.calls[0].context)).toContain("COMMITTED_MARK");
		const record = h.manager.getBranch().find(e => e.type === "custom");
		if (!record || record.type !== "custom") throw new Error("Missing selection record");
		h.manager.appendCustomEntry(record.customType, { version: 999, skills: [] });
		await h.manager.flush();
		const resumed = await harness({ manager: await SessionManager.open(h.session.sessionFile!) });
		expect(resumed.session.getSessionSkillsState().error).toBeDefined();
		await resumed.agent.prompt("must fail closed");
		expect(resumed.mock.calls).toHaveLength(0);
	});

	it("pins BTW captured guidance independently and promotion inherits the captured metadata", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "CAPTURED_MARK");
		const b = await h.skill("beta", "LATER_MARK");
		await apply(h.session, [a]);
		h.manager.appendMessage(userMsg("seed"));
		await h.manager.flush();
		const snapshot = h.session.captureBtwBranchSnapshot();
		await apply(h.session, [b]);
		await h.session.runEphemeralTurn({
			promptText: "side question",
			baseMessages: h.session.btwMessagesFromSnapshot(snapshot),
		});
		expect(text(h.mock.calls[0].context)).toContain("CAPTURED_MARK");
		expect(text(h.mock.calls[0].context)).not.toContain("LATER_MARK");
		await h.session.runEphemeralTurn({ promptText: "unrelated side caller" });
		expect(text(h.mock.calls[1].context)).not.toContain("LATER_MARK");
		expect(text(h.mock.calls[1].context)).not.toContain("CAPTURED_MARK");
		const result = await h.session.promoteBtwBranch(snapshot, "side question", assistantMsg("side answer"));
		const promoted = await harness({ manager: await SessionManager.open(result.sessionFile) });
		await promoted.agent.prompt("continue promoted");
		expect(text(promoted.mock.calls[0].context)).toContain("CAPTURED_MARK");
		expect(text(promoted.mock.calls[0].context)).not.toContain("LATER_MARK");
	});
	it("reconciles the adopted branch inside a deferred switch callback and restores the original selection on rollback", async () => {
		const h = await harness();
		const a = await h.skill("alpha", "ORIGINAL_MARK");
		await apply(h.session, [a]);
		const target = await harness();
		const b = await target.skill("beta", "ADOPTED_MARK");
		await apply(target.session, [b]);
		await target.manager.flush();
		const before = h.session.getSessionSkillsState();
		const switched = await h.session.switchSession(target.session.sessionFile!, {
			onCwdChange: async () => {
				expect(h.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([b]);
				await h.agent.prompt("during adoption");
				expect(text(h.mock.calls[0].context)).toContain("ADOPTED_MARK");
				expect(text(h.mock.calls[0].context)).not.toContain("ORIGINAL_MARK");
				return false;
			},
		});
		expect(switched).toBe(false);
		expect(h.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([a]);
		expect(h.session.getSessionSkillsState().revision).not.toBe(before.revision);
		await h.agent.prompt("after rollback");
		expect(text(h.mock.calls[1].context)).toContain("ORIGINAL_MARK");
		expect(text(h.mock.calls[1].context)).not.toContain("ADOPTED_MARK");
	});

	it("waits for reserved Apply before native checkpoint rewind, then restores checkpoint guidance without losing the report", async () => {
		const reached = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		const rewindCompleted = Promise.withResolvers<void>();
		const rewindSchema = type({ report: "string" });
		const checkpointSchema = type({ goal: "string" });
		const tools: AgentTool[] = [
			{
				name: "checkpoint",
				label: "Checkpoint",
				description: "Checkpoint",
				parameters: checkpointSchema,
				execute: async () => ({
					content: [{ type: "text", text: "checkpoint" }],
					details: { startedAt: "2026-01-01T00:00:00.000Z" },
				}),
			},
			{
				name: "rewind",
				label: "Rewind",
				description: "Rewind",
				parameters: rewindSchema,
				execute: async () => ({
					content: [{ type: "text", text: "findings retained" }],
					details: { report: "findings retained", rewound: true },
				}),
			},
		];
		const h = await harness({
			tools,
			responses: [
				{
					content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
					stopReason: "toolUse",
				},
				async () => {
					reached.resolve();
					await releaseProvider.promise;
					return {
						content: [
							{ type: "toolCall", id: "rewind", name: "rewind", arguments: { report: "findings retained" } },
						],
						stopReason: "toolUse",
					};
				},
				{ content: ["done"] },
			],
		});
		h.agent.subscribe(event => {
			if (event.type === "tool_execution_end" && event.toolName === "rewind") rewindCompleted.resolve();
		});
		const a = await h.skill("alpha", "CHECKPOINT_MARK");
		const b = await h.skill("beta", "DISCARDED_MARK");
		await apply(h.session, [a]);
		const run = h.agent.prompt("investigate");
		await reached.promise;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = h.manager.appendEntriesAtomically.bind(h.manager);
		const spy = spyOn(h.manager, "appendEntriesAtomically").mockImplementation(async append => {
			entered.resolve();
			await release.promise;
			return original(append);
		});
		const pending = apply(h.session, [b]);
		await entered.promise;
		releaseProvider.resolve();
		await rewindCompleted.promise;
		expect(h.mock.calls).toHaveLength(2);
		release.resolve();
		await pending;
		await run;
		spy.mockRestore();
		expect(text(h.mock.calls[2].context)).toContain("CHECKPOINT_MARK");
		expect(text(h.mock.calls[2].context)).not.toContain("DISCARDED_MARK");
		expect(text(h.mock.calls[2].context)).toContain("findings retained");
		expect(h.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([a]);
	});

	it("never injects staged metadata during a real atomic write and rollback restores durable selection", async () => {
		const storage = new SkillCommitStorage();
		const manager = SessionManager.create("/skill-fixture", "/skill-fixture/sessions", storage);
		const h = await harness({ manager });
		const a = await h.skill("alpha", "DURABLE_MARK");
		const b = await h.skill("beta", "STAGED_MARK");
		await apply(h.session, [a]);
		const before = await storage.readText(h.session.sessionFile!);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		storage.gate = { entered: entered.resolve, release: release.promise, fail: true };
		const pending = apply(h.session, [b]);
		await entered.promise;
		try {
			await h.agent.prompt("while journal contains staged metadata");
			expect(text(h.mock.calls[0].context)).toContain("DURABLE_MARK");
			expect(text(h.mock.calls[0].context)).not.toContain("STAGED_MARK");
			expect(h.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([a]);
		} finally {
			release.resolve();
		}
		await expect(pending).rejects.toThrow("skill atomic publish failed");
		const reopened = await harness({
			manager: await SessionManager.open(h.session.sessionFile!, undefined, storage),
		});
		expect(reopened.session.getSessionSkillsState().selected.map(x => x.id)).toEqual([a]);
		expect(await storage.readText(h.session.sessionFile!)).not.toContain("STAGED_MARK");
		expect(before).toContain("DURABLE_MARK");
	});

	it("refuses nonpersistent SDK managers instead of pretending Apply is durable", async () => {
		const h = await harness({ inMemory: true });
		await expect(apply(h.session, [])).rejects.toThrow();
	});
});
