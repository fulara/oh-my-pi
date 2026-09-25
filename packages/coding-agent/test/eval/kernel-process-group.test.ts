import { afterEach, describe, expect, test, vi } from "bun:test";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { readLines } from "@oh-my-pi/pi-utils";
import { BaseKernel } from "../../src/eval/kernel-base";

class TestKernel extends BaseKernel {
	constructor() {
		super("process-group-test", {
			languageName: "Test",
			traceIpc: false,
			exitPayload: "exit",
			interruptEscalationMs: 10,
			shutdownGraceMs: 25,
			buildPayload: code => code,
		});
	}
}

// Real OS lifecycle integration: watchdogs bound disposable fixtures if the test
// runner dies. They are not sleeps used to guess when a subprocess is ready.
const fixture = `
process.on("SIGTERM", () => {});
process.stdin.resume();
setTimeout(() => process.exit(124), 10000);
console.log("READY");
`;

async function ready(stream: ReadableStream<Uint8Array>) {
	for await (const line of readLines(stream)) {
		expect(new TextDecoder().decode(line)).toBe("READY");
		return;
	}
	throw new Error("Fixture exited before its readiness handshake");
}

afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("BaseKernel owned shutdown", () => {
	test("refuses cleanup without a pinned identity and preserves the live fixture", async () => {
		const proc = Bun.spawn([process.execPath, "-e", fixture], {
			detached: true,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const owner = Process.fromPid(proc.pid);
		if (!owner) throw new Error("Cannot pin disposable test fixture");
		try {
			await ready(proc.stdout);
			const unavailable = vi.spyOn(Process, "fromPid").mockReturnValue(null);
			const kernel = new TestKernel();
			kernel.setProcess(proc);
			unavailable.mockRestore();
			expect(await kernel.shutdown()).toEqual({ confirmed: false });
			expect(owner.status()).toBe(ProcessStatus.Running);
		} finally {
			await owner.terminate({ group: false, gracefulMs: -1 });
			await proc.exited;
		}
	});

	test("retains an unconfirmed worker across retries after its kernel exits", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
			Bun.spawn([process.execPath, "-e", ${JSON.stringify(fixture)}], {
				stdin: "pipe", stdout: "inherit", stderr: "inherit"
			});
			process.stdin.resume();
			process.stdin.on("end", () => process.exit(0));
			setTimeout(() => process.exit(124), 10000);
		`,
			],
			{ detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		const owner = Process.fromPid(proc.pid);
		if (!owner) throw new Error("Cannot pin disposable kernel");
		let worker: Process | undefined;
		try {
			await ready(proc.stdout);
			worker = owner.children()[0];
			if (!worker) throw new Error("Worker missing after readiness handshake");
			const workerIdentity = worker.identity();
			const terminate = Process.prototype.terminate;
			let refuseWorker = true;
			vi.spyOn(Process.prototype, "terminate").mockImplementation(function (this: Process, options) {
				if (refuseWorker && this.identity() === workerIdentity) return Promise.resolve(false);
				return terminate.call(this, options);
			});
			const kernel = new TestKernel();
			kernel.setProcess(proc);
			expect(await kernel.shutdown()).toEqual({ confirmed: false });
			expect(await proc.exited).toBe(0);
			expect(owner.status()).toBe(ProcessStatus.Exited);
			expect(worker.status()).toBe(ProcessStatus.Running);

			expect(await kernel.shutdown()).toEqual({ confirmed: false });
			expect(worker.status()).toBe(ProcessStatus.Running);
			refuseWorker = false;
			expect(await kernel.shutdown()).toEqual({ confirmed: true });
			expect(worker.status()).toBe(ProcessStatus.Exited);
		} finally {
			vi.restoreAllMocks();
			await owner.terminate({ group: false, gracefulMs: -1 });
			await worker?.terminate({ group: false, gracefulMs: -1 });
			await proc.exited;
		}
	});

	test.each(["graceful", "timeout"] as const)(
		"reaps a TERM-resistant worker after %s exit without harming a protected sentinel",
		async exitMode => {
			const sentinel = Bun.spawn([process.execPath, "-e", fixture], {
				detached: true,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const sentinelOwner = Process.fromPid(sentinel.pid);
			if (!sentinelOwner) throw new Error("Cannot pin disposable sentinel");
			const proc = Bun.spawn(
				[
					process.execPath,
					"-e",
					`
			const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(fixture)}], {
				stdin: "pipe", stdout: "inherit", stderr: "inherit"
			});
			process.stdin.resume();
			process.on("SIGTERM", () => process.exit(0));
			${exitMode === "graceful" ? 'process.stdin.on("end", () => process.exit(0));' : ""}
			setTimeout(() => process.exit(124), 10000);
		`,
				],
				{ detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			const owner = Process.fromPid(proc.pid);
			if (!owner) throw new Error("Cannot pin disposable kernel");
			let worker: Process | undefined;
			try {
				await ready(sentinel.stdout);
				await ready(proc.stdout);
				worker = owner.children()[0];
				if (!worker) throw new Error("Worker missing after readiness handshake");
				const kernel = new TestKernel();
				kernel.setProcess(proc);
				expect(await kernel.shutdown()).toEqual({ confirmed: true });
				expect(await proc.exited).toBe(0);
				expect(kernel.isAlive()).toBe(false);
				expect(await kernel.shutdown()).toEqual({ confirmed: true });
				expect(worker.status()).toBe(ProcessStatus.Exited);
				expect(sentinelOwner.status()).toBe(ProcessStatus.Running);
			} finally {
				await owner.terminate({ group: false, gracefulMs: -1 });
				await worker?.terminate({ group: false, gracefulMs: -1 });
				await sentinelOwner.terminate({ group: false, gracefulMs: -1 });
				await Promise.all([proc.exited, sentinel.exited]);
			}
		},
	);
});
