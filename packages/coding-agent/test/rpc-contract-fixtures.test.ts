import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import * as path from "node:path";
import { rpcContractFixtures } from "./fixtures/rpc-contract/frames";

const requiredFixtureNames = [
	"ready",
	"rpc-chunk",
	"command-negotiate-protocol",
	"response-negotiate-protocol",
	"command-get-messages-page",
	"response-get-messages-page",
	"response-get-messages-page-session-busy",
	"response-get-messages-page-stale-cursor",
	"command-get-available-commands",
	"response-get-available-commands",
	"available-commands-update",
	"prompt-result",
	"command-output",
	"session-info-update",
	"config-update",
	"event-goal-updated",
	"response-error",
	"response-get-state",
	"response-get-available-models",
	"response-get-messages",
	"response-get-session-stats",
	"command-set-host-uri-schemes",
	"host-uri-request-read",
	"host-uri-request-write",
	"host-uri-cancel",
	"host-uri-result-success",
	"host-uri-result-error",
	"host-tool-call",
	"host-tool-cancel",
	"host-tool-result",
	"host-tool-update",
	"event-agent-start",
	"event-agent-end",
	"event-message-update-text",
	"event-message-end-text",
	"event-message-end-thinking",
	"event-message-end-tool-call",
	"event-message-end-tool-result",
	"event-tool-execution-start",
	"event-tool-execution-update",
	"event-tool-execution-end",
	"event-plan-review",
	"extension-ui-request-confirm",
	"response-set-plan-mode",
	"response-approve-plan-mode",
	"response-set-active-tools",
	"response-goal-mode",
] as const;

function frameFor(name: string): Record<string, unknown> {
	const fixture = rpcContractFixtures.find(candidate => candidate.name === name);
	if (!fixture) throw new Error(`Missing RPC contract fixture: ${name}`);
	return JSON.parse(JSON.stringify(fixture.frame)) as Record<string, unknown>;
}

describe("RPC contract fixtures", () => {
	test("all fixtures are JSON-serializable wire frames", () => {
		for (const fixture of rpcContractFixtures) {
			const encoded = JSON.stringify(fixture.frame);
			expect(encoded).toBeTruthy();

			const decoded = JSON.parse(encoded);
			expect(decoded).toHaveProperty("type");
			expect(JSON.stringify(decoded)).toBe(encoded);
		}
	});

	test("fixture names are unique and required fixtures exist", () => {
		const names = new Set<string>();

		for (const fixture of rpcContractFixtures) {
			expect(names.has(fixture.name)).toBe(false);
			names.add(fixture.name);
		}

		expect(Array.from(requiredFixtureNames).every(name => names.has(name))).toBe(true);
	});

	test("response fixtures use canonical RpcResponse shape", () => {
		for (const fixture of rpcContractFixtures) {
			const frame = JSON.parse(JSON.stringify(fixture.frame));
			if (frame.type !== "response") continue;

			expect(typeof frame.command).toBe("string");
			expect(typeof frame.success).toBe("boolean");
			expect(frame).not.toHaveProperty("status");

			if (frame.success === true) {
				expect(frame).not.toHaveProperty("error");
			} else {
				expect(typeof frame.error).toBe("string");
			}
		}
	});

	test("protocol negotiation and chunk fixtures are internally consistent", () => {
		const ready = frameFor("ready");
		expect(ready.supportedProtocolVersions).toEqual([1, 2]);
		expect(ready.maxFrameBytes).toBeGreaterThan(0);
		expect(ready.maxReassembledFrameBytes).toBeGreaterThan(0);

		const negotiation = frameFor("response-negotiate-protocol");
		expect(negotiation).toMatchObject({
			type: "response",
			command: "negotiate_protocol",
			success: true,
			data: { protocolVersion: 2 },
		});

		const chunk = frameFor("rpc-chunk");
		expect(chunk).toMatchObject({ type: "rpc_chunk", index: 0, count: 1 });
		const decoded = Buffer.from(chunk.data as string, "base64");
		expect(decoded.byteLength).toBe(chunk.byteLength as number);
		expect(JSON.parse(decoded.toString("utf8"))).toEqual(frameFor("response-get-messages-page"));
	});

	test("paged message fixtures preserve data and structured errors", () => {
		const response = frameFor("response-get-messages-page");
		expect(response).toMatchObject({
			type: "response",
			command: "get_messages_page",
			success: true,
			data: {
				nextCursor: "eyJ2ZXJzaW9uIjoxLCJvZmZzZXQiOjR9",
				totalMessages: 4,
			},
		});
		const data = response.data as Record<string, unknown>;
		expect(data.messages).toHaveLength(2);

		expect(frameFor("response-get-messages-page-session-busy")).toMatchObject({
			type: "response",
			command: "get_messages_page",
			success: false,
			code: "session_busy",
			error: "Cannot page messages while the session is changing",
		});
		expect(frameFor("response-get-messages-page-stale-cursor")).toMatchObject({
			type: "response",
			command: "get_messages_page",
			success: false,
			code: "stale_cursor",
			error: "RPC message cursor is stale",
		});
	});

	test("available command fixtures retain nested metadata and every source", () => {
		const response = frameFor("response-get-available-commands");
		const update = frameFor("available-commands-update");
		const responseData = response.data as Record<string, unknown>;
		const commands = responseData.commands as Array<Record<string, unknown>>;

		expect(update.commands).toEqual(commands);
		expect(commands.find(command => command.name === "tools")).toMatchObject({
			aliases: ["tool"],
			description: "Manage active tools",
			input: { hint: "list|enable|disable" },
			subcommands: [{ name: "list", description: "List active tools", usage: "/tools list" }],
		});
		expect(commands.map(command => command.source).sort()).toEqual([
			"builtin",
			"custom",
			"extension",
			"file",
			"mcp_prompt",
			"skill",
		]);
	});

	test("runtime update fixtures retain required payloads", () => {
		expect(frameFor("prompt-result")).toEqual({
			type: "prompt_result",
			id: "cmd-tools-1",
			agentInvoked: false,
		});
		expect(frameFor("command-output")).toEqual({
			type: "command_output",
			text: "Active tools: read, todo, task",
		});
		expect(frameFor("session-info-update")).toEqual({
			type: "session_info_update",
			title: "Fixture session renamed",
			sessionId: "session-1",
		});
		expect(frameFor("config-update")).toMatchObject({
			type: "config_update",
			model: { contextWindow: null, maxTokens: null },
			thinkingLevel: Effort.Medium,
		});
		expect(frameFor("event-goal-updated")).toMatchObject({
			type: "goal_updated",
			goal: { id: "goal-1", status: "active" },
			state: { enabled: true, mode: "active" },
		});
	});

	test("get_state fixture exposes planMode, goalMode, and contextUsage", () => {
		const frame = rpcContractFixtures.find(fixture => fixture.name === "response-get-state")?.frame;
		expect(frame).toBeDefined();
		if (!frame || frame.type !== "response" || frame.command !== "get_state" || !frame.success) {
			throw new Error("response-get-state fixture is not a successful get_state response");
		}

		expect(frame.data.planMode).toEqual({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: false,
		});
		expect(frame.data.goalMode).toEqual({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-1",
				objective: "Ship goal-mode projection",
				status: "active",
				tokenBudget: 50000,
				tokensUsed: 1200,
				timeUsedSeconds: 90,
				createdAt: 1770000000000,
				updatedAt: 1770000009000,
			},
		});
		expect(frame.data.contextUsage).toEqual({ tokens: 1234, contextWindow: 200000, percent: 0.617 });
		expect(frame.data.model).toMatchObject({ contextWindow: null, maxTokens: null });
		expect(frame.data.isCompacting).toBe(false);
		expect(frame.data.todoPhases).toEqual([
			{
				name: "Delivery",
				tasks: [
					{
						content: "Wait for release approval",
						status: "blocked",
						blocker: "Release manager approval is pending",
					},
				],
			},
		]);
	});

	test("generated JSON files match typed fixture sources", async () => {
		const generatedDir = path.join(import.meta.dir, "fixtures", "rpc-contract", "generated");
		const manifest = (await Bun.file(path.join(generatedDir, "manifest.json")).json()) as Array<{
			name: string;
			category: string;
			file: string;
		}>;

		expect(manifest.map(entry => entry.name).sort()).toEqual(rpcContractFixtures.map(fixture => fixture.name).sort());

		for (const fixture of rpcContractFixtures) {
			const entry = manifest.find(item => item.name === fixture.name);
			expect(entry).toBeDefined();

			const generated = await Bun.file(path.join(generatedDir, entry!.file)).json();
			const expected = JSON.parse(JSON.stringify(fixture.frame));
			expect(generated).toEqual(expected);
		}
	});
});
