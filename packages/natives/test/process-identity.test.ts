import { expect, test } from "bun:test";
import { Process, ProcessStatus } from "../native/index.js";

// Real watchdog bounds an OS subprocess if the runner dies; it is not a test wait.
// Disposable fixtures exit through stdin EOF, never through a numeric PID signal.
const fixture = `
setTimeout(() => process.exit(124), 5000);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdout.write("READY\\n");
`;

const spawnFixture = () =>
	Bun.spawn([process.execPath, "-e", fixture], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});

test("Process identity distinguishes live instances and remains pinned after exit", async () => {
	const children = [spawnFixture(), spawnFixture()];
	try {
		const references: Process[] = [];
		for (const child of children) {
			const reader = child.stdout.getReader();
			let ready = "";
			try {
				while (!ready.includes("\n")) {
					const { done, value } = await reader.read();
					if (done) throw new Error("Process fixture exited before READY");
					ready += new TextDecoder().decode(value);
				}
			} finally {
				reader.releaseLock();
			}
			expect(ready).toBe("READY\n");
			const pinned = Process.fromPid(child.pid);
			if (!pinned) throw new Error("Could not pin live process fixture");
			expect(Process.fromPid(child.pid)?.identity()).toBe(pinned.identity());
			references.push(pinned);
		}
		const identities = references.map(reference => reference.identity());
		expect(identities[0]).not.toBe(identities[1]);
		for (const child of children) child.stdin.end();
		expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
		for (let index = 0; index < references.length; index++) {
			expect(references[index].status()).toBe(ProcessStatus.Exited);
			expect(references[index].identity()).toBe(identities[index]);
		}
	} finally {
		for (const child of children) {
			if (child.exitCode === null) child.stdin.end();
		}
		await Promise.all(children.map(child => child.exited));
	}
});
