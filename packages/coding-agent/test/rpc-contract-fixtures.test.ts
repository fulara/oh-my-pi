import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { rpcContractFixtures } from "./fixtures/rpc-contract/frames";

const requiredFixtureNames = [
	"ready",
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
	"response-discuss-plan-mode",
	"response-set-active-tools",
	"response-goal-mode",
] as const;

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
