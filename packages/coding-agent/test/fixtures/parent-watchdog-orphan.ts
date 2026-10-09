/**
 * Two-role fixture for `startParentWatchdog`.
 *
 * - `child`: arms the watchdog against its parent, reports `armed`, then pins
 *   its main thread in a synchronous loop — the shape of an onnxruntime
 *   `session.run` that starves every main-loop timer (issue #14340).
 * - default (middle): pins the child while alive, waits for `armed`, then reports
 *   its birth identity. Only an explicit owner acknowledgement allows SIGKILL.
 */
import { Process } from "@oh-my-pi/pi-natives";
import { startParentWatchdog } from "../../src/subprocess/parent-watchdog";

const BLOCK_MS = 20_000;

if (process.argv[2] === "child") {
	startParentWatchdog(process.ppid);
	process.stdout.write("armed\n");
	const end = Date.now() + BLOCK_MS;
	while (Date.now() < end) {}
	process.stdout.write("survived\n");
} else {
	const child = Bun.spawn([process.execPath, import.meta.path, "child"], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "inherit",
	});
	const owned = Process.fromPid(child.pid);
	if (!owned || owned.ppid !== process.pid) {
		throw new Error("Cannot establish ownership of disposable watchdog child");
	}
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";
	while (!output.includes("armed")) {
		const { value, done } = await reader.read();
		if (done) break;
		output += decoder.decode(value);
	}
	// Exit with a distinct code (not SIGKILL, and not Windows' TerminateProcess
	// code 1) when the child died before arming, so the test can tell a broken
	// fixture from a reaped orphan.
	if (!output.includes("armed")) process.exit(2);
	const ownerIdentity = Process.fromPid(process.pid)?.identity();
	process.stdout.write(`${JSON.stringify({ pid: child.pid, identity: owned.identity(), ownerIdentity })}\n`);
	if ((await Bun.stdin.text()) === "orphan\n") process.kill(process.pid, "SIGKILL");
	// A failed test closes its own pipe; terminate only the pinned fixture child.
	await owned.terminate({ group: false, gracefulMs: 100, timeoutMs: 2_000 });
	await child.exited;
	process.exit(2);
}
