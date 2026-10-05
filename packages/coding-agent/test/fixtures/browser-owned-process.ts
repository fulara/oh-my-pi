import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { gracefulKillTreeOnce } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";

const [directory, role, mode = "normal", parentPid, parentIdentity] = process.argv.slice(2);
if (!directory || !role) throw new Error("Missing process fixture directory/role");
const self = Process.fromPid(process.pid);
if (!self) throw new Error("Cannot pin fixture identity");
// Every fixture has its own real watchdog, including orphaned workers.
const watchdog = setTimeout(() => process.exit(124), 20_000);
const file = (name: string) => path.join(directory, name);

if (role === "ancestor-refusal") {
	const parent = Process.fromPid(Number(parentPid));
	if (!parent || parent.identity() !== parentIdentity) throw new Error("Parent identity changed");
	let error: string | undefined;
	try {
		await gracefulKillTreeOnce(parent, 10);
	} catch (failure) {
		error = String(failure);
	}
	await fs.writeFile(file("ancestor-result.json"), JSON.stringify({ error }));
	clearTimeout(watchdog);
	process.exit(error ? 0 : 1);
}

let worker: Bun.Subprocess | undefined;
let workerProcess: Process | undefined;
if (role === "leader") {
	worker = Bun.spawn([process.execPath, import.meta.path, directory, "worker", mode], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
	});
	workerProcess = Process.fromPid(worker.pid) ?? undefined;
	if (!workerProcess) throw new Error("Cannot pin worker at birth");
	await fs.writeFile(
		file("worker-birth.json"),
		JSON.stringify({ pid: worker.pid, identity: workerProcess.identity() }),
	);
}

const cdpPort = process.argv.find(arg => arg.startsWith("--remote-debugging-port="));
const server =
	role === "leader" && mode === "bad-cdp" && cdpPort
		? Bun.serve({
				hostname: "127.0.0.1",
				port: Number(cdpPort.split("=")[1]),
				async fetch(request) {
					if (new URL(request.url).pathname === "/json/version") {
						if (!(await Bun.file(file("CDP.ready")).exists())) return new Response("Starting", { status: 503 });
						return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort.split("=")[1]}/rejected` });
					}
					return new Response("Not a CDP websocket", { status: 400 });
				},
			})
		: undefined;

let exiting = false;
async function exitNormally() {
	if (exiting) return;
	exiting = true;
	clearInterval(control);
	server?.stop(true);
	if (worker) {
		await fs.writeFile(file("worker.exit"), "exit");
		await worker.exited;
	}
	clearTimeout(watchdog);
	process.exit(0);
}
// A stubborn worker forces native cleanup to retain descendants through escalation.
if (role === "worker" && mode === "stubborn") process.on("SIGTERM", () => {});
const control = setInterval(async () => {
	if ((await Bun.file(file("STOP")).exists()) || (await Bun.file(file(`${role}.exit`)).exists())) {
		await exitNormally();
	}
}, 20);
await fs.writeFile(
	file(`${role}.json`),
	JSON.stringify({ pid: process.pid, identity: self.identity(), group: self.groupId() }),
);
