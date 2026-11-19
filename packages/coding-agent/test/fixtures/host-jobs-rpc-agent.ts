import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real SDK session and RPC dispatch for the host background job tests. The model calls the
// `fura_session_send` host tool when asked to delegate, and names the async result it was woken by.
const MODEL = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!MODEL) throw new Error("bundled test model missing");

const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));

const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	sessionManager: SessionManager.inMemory(cwd),
	authStorage,
	modelRegistry,
	settings: Settings.isolated(),
	model: MODEL,
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
});

function lastText(context: Context): { role: string; text: string } {
	const message = context.messages.at(-1);
	if (!message) return { role: "", text: "" };
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
	return { role: message.role, text };
}

const mock = createMockModel({
	handler: context => {
		const last = lastText(context);
		if (last.role === "toolResult") return { content: ["Delegated."] };
		const woken = /HOST RESULT \w+/.exec(last.text);
		if (woken) return { content: [`Woken by ${woken[0]}`] };
		if (last.text.includes("delegate")) {
			return { content: [{ type: "toolCall", name: "fura_session_send", arguments: {} }] };
		}
		return { content: ["pong"] };
	},
});
session.agent.streamFn = mock.stream;
await runRpcMode(session);
