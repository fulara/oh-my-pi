import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { createLinuxSubreaperScript, exec, NonZeroExitError, spawn, TimeoutError } from "@oh-my-pi/pi-utils/ptree";

async function spawnPipeHolder({
	detached = false,
	timeout = 250,
	pipe = "stdout",
	output = "token",
	exitCode = 0,
}: {
	detached?: boolean;
	timeout?: number;
	pipe?: "stdout" | "stderr";
	output?: string;
	exitCode?: number;
} = {}) {
	const ready = Promise.withResolvers<{ pid: number; port: number }>();
	const probe = `${import.meta.dir}/fixtures/ptree-dead-root-probe.ts`;
	const child = spawn([process.execPath, probe, JSON.stringify({ pipe, output, exitCode })], {
		detached,
		ipc(message) {
			ready.resolve(message);
		},
	});
	let descendant: Process | undefined;
	// IPC drives readiness; a real watchdog bounds startup outside the test process.
	const startupTimer = setTimeout(() => ready.reject(new Error("pipe holder startup timed out")), 2_000);
	const cleanup = async () => {
		clearTimeout(startupTimer);
		try {
			try {
				if (child.proc.exitCode === null) child.proc.send("stop");
			} finally {
				await child.proc.exited;
			}
		} finally {
			try {
				if (descendant) {
					descendant.killTree(9);
					if (!(await descendant.waitForExit({ timeoutMs: 2_000 }))) {
						throw new Error("owned pipe holder did not exit");
					}
				}
			} finally {
				child[Symbol.dispose]();
			}
		}
	};
	try {
		if (detached && process.platform !== "win32" && Process.fromPid(child.pid)?.groupId() !== child.pid) {
			throw new Error("pipe holder root did not get its own process group");
		}
		const { pid, port } = await Promise.race([
			ready.promise,
			child.proc.exited.then(code => {
				throw new Error(`pipe holder root exited during startup: ${code}`);
			}),
		]);
		// The fixture blocks root exit until this identity and parentage are pinned.
		const pinned = Process.fromPid(pid);
		if (
			!pinned ||
			child.proc.exitCode !== null ||
			pinned.ppid !== child.pid ||
			pinned.status() !== ProcessStatus.Running
		) {
			throw new Error("pipe holder is not a running child of the owned root");
		}
		descendant = pinned;
		clearTimeout(startupTimer);
		const ping = async () => {
			const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1_000) });
			return response.text();
		};
		expect(await ping()).toBe("alive");
		child.attachTimeout(timeout);
		child.proc.send("release");
		await child.proc.exited;
		return { child, descendant, ping, [Symbol.asyncDispose]: cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

async function supportsLinuxMountNamespaces(): Promise<boolean> {
	if (process.platform !== "linux") return false;
	try {
		const probe = Bun.spawn(
			[
				"unshare",
				"--user",
				"--map-root-user",
				"--mount",
				"--propagation",
				"private",
				"/bin/sh",
				"-c",
				"mount -t tmpfs tmpfs /proc",
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		return (await probe.exited) === 0;
	} catch {
		return false;
	}
}

const linuxMountNamespacesAvailable = await supportsLinuxMountNamespaces();

describe("ptree timeout", () => {
	it("contains the lifecycle rejection when the caller does not observe exited", async () => {
		const unhandled = new Set<unknown>();
		const onUnhandled = (reason: unknown) => {
			unhandled.add(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			// Bun's subprocess timeout uses the platform clock; fake timers cannot drive this lifecycle.
			using child = spawn(["bun", "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {
				timeout: 20,
			});
			await child.nothrow().text();
			await child.proc.exited;
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(TimeoutError);
			expect(unhandled.has(child.exitReason)).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it.skipIf(process.platform !== "linux")(
		"kills descendants adopted while an AbortSignal races the timeout sweep",
		async () => {
			const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-subreaper-race-"));
			const pidFile = path.join(testRoot, "worker.pid");
			const launcher = path.join(testRoot, "launcher.sh");
			await Bun.write(
				launcher,
				`#!/bin/sh
setsid sleep 30 </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > ${JSON.stringify(pidFile)}
sleep 30
`,
			);
			await fs.chmod(launcher, 0o755);

			const controller = new AbortController();
			using child = spawn([launcher], {
				signal: controller.signal,
				subreaper: true,
			});
			const cleanupProcesses: Process[] = [];

			try {
				// A BunFile handle caches a negative `exists()`; stat fresh each poll.
				const pidFileExists = () =>
					fs.stat(pidFile).then(
						() => true,
						() => false,
					);
				const setupDeadline = Date.now() + 2_000;
				while (!(await pidFileExists()) && Date.now() < setupDeadline) await Bun.sleep(10);
				expect(await pidFileExists(), "the launcher must create its worker").toBe(true);

				const workerPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				const subreaper = Process.fromPid(child.pid);
				const command = subreaper?.children()[0];
				const worker = Process.fromPid(workerPid);
				if (!subreaper || !command || !worker) throw new Error("failed to capture the subreaper process tree");
				cleanupProcesses.push(worker, command, subreaper);
				expect(worker.ppid, "the worker must initially belong to the supervised command").toBe(command.pid);

				const killOnly = (pid: number): number => {
					try {
						process.kill(pid, "SIGKILL");
						return 1;
					} catch {
						return 0;
					}
				};
				const commandSnapshot = {
					killTree: () => killOnly(command.pid),
				} as unknown as Process;
				const pendingAdoption = {
					killTree: () => 0,
				} as unknown as Process;
				let snapshots = 0;
				let observedAdoption = false;
				const controlledSubreaper = {
					children: (): Process[] => {
						snapshots++;
						if (snapshots === 1) return [commandSnapshot];
						if (subreaper.status() !== ProcessStatus.Running || worker.status() !== ProcessStatus.Running)
							return [];
						if (worker.ppid !== subreaper.pid) return [pendingAdoption];
						observedAdoption = true;
						return [worker];
					},
					killTree: () => killOnly(subreaper.pid),
					terminate: () => Promise.resolve(killOnly(subreaper.pid) > 0),
				} as unknown as Process;
				const nativeFromPid = Process.fromPid.bind(Process);
				const fromPid = spyOn(Process, "fromPid").mockImplementation(pid =>
					pid === child.pid ? controlledSubreaper : nativeFromPid(pid),
				);

				try {
					child.kill(new TimeoutError(1, ""), -1);
					controller.abort("concurrent abort");

					const result = await child.wait({ allowAbort: true });
					expect(result.exitError).toBeInstanceOf(TimeoutError);
					expect(observedAdoption, "the worker must reparent to the live subreaper during cleanup").toBe(true);
					expect(worker.status(), `adopted descendant ${worker.pid} survived cleanup`).not.toBe(
						ProcessStatus.Running,
					);
				} finally {
					fromPid.mockRestore();
				}
			} finally {
				for (const processHandle of cleanupProcesses) processHandle.killTree(9);
				await fs.rm(testRoot, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux")("falls back after the first libc soname is unavailable", async () => {
		const script = createLinuxSubreaperScript(["libc.so.omp-missing", "libc.so.6", "libc.so"]);
		const child = Bun.spawn([process.execPath, "-e", script], {
			env: {
				...Bun.env,
				BUN_BE_BUN: "1",
				OMP_PTREE_SUBREAPER_COMMAND: JSON.stringify([
					process.execPath,
					"-e",
					'process.stdout.write("libc-fallback-ok")',
				]),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("libc-fallback-ok");
	});

	it.skipIf(process.platform !== "linux")("does not leak supervisor-only environment into the command", async () => {
		const result = await exec(["/bin/sh", "-c", `printf %s "\${BUN_BE_BUN-unset}"`], {
			subreaper: true,
		});

		expect(result.stdout).toBe("unset");
	});

	it.skipIf(process.platform !== "linux")("preserves caller-supplied BUN_BE_BUN for the command", async () => {
		const result = await exec(["/bin/sh", "-c", `printf %s "\${BUN_BE_BUN-unset}"`], {
			subreaper: true,
			env: { ...Bun.env, BUN_BE_BUN: "1" },
		});

		expect(result.stdout).toBe("1");
	});

	it.skipIf(!linuxMountNamespacesAvailable)("supervises commands without a mounted procfs", async () => {
		const script = `
const mountExit = await Bun.spawn(["mount", "-t", "tmpfs", "tmpfs", "/proc"], {
	stdout: "ignore",
	stderr: "inherit",
}).exited;
if (mountExit !== 0) throw new Error("failed to hide procfs");
${createLinuxSubreaperScript()}
`;
		const child = Bun.spawn(
			[
				"unshare",
				"--user",
				"--map-root-user",
				"--mount",
				"--propagation",
				"private",
				process.execPath,
				"-e",
				script,
			],
			{
				cwd: "/tmp",
				env: {
					...Bun.env,
					BUN_BE_BUN: "1",
					OMP_PTREE_SUBREAPER_COMMAND: JSON.stringify(["/bin/sh", "-c", "printf procfs-free-ok"]),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("procfs-free-ok");
	});

	it("clears the timeout timer once the child exits so a fast command does not hold the event loop", async () => {
		// Real subprocess timing: the probe (a static-import fixture) resolves a
		// quick command under a 10 s ptree timeout and then must exit on its own;
		// if the timeout timer were left pending it would hold the probe's event
		// loop for the full 10 s.
		const probe = `${import.meta.dir}/fixtures/ptree-timeout-probe.ts`;

		const start = performance.now();
		const child = spawn([process.execPath, probe], { timeout: 15_000 });
		const text = await child.text();
		const elapsedMs = performance.now() - start;

		expect(text).toContain("probe-done");
		expect(elapsedMs).toBeLessThan(5_000);
	});

	it.skipIf(process.platform === "win32")(
		"keeps reading inherited stdout until the configured command deadline",
		async () => {
			// Real subprocess timing: fake timers cannot advance the child clock.
			// The root exits immediately, but its child writes after the legacy
			// 100 ms drain grace and before the 1 s command deadline.
			const result = await exec(["/bin/sh", "-c", "(sleep .2; printf token) &"], {
				timeout: 1_000,
				allowNonZero: true,
				allowAbort: true,
			});

			expect(result.ok).toBe(true);
			expect(result.stdout).toBe("token");
		},
	);

	it.skipIf(process.platform === "win32")("rejects text when the deadline fires after the root exits", async () => {
		await using fixture = await spawnPipeHolder({ detached: true });
		let threw: unknown;
		try {
			await fixture.child.text();
		} catch (error) {
			threw = error;
		}

		expect(threw).toBeInstanceOf(TimeoutError);
	});

	for (const outputMethod of ["blob", "json", "arrayBuffer", "bytes"] as const) {
		it.skipIf(process.platform === "win32")(
			`rejects ${outputMethod} when the deadline fires after the root exits`,
			async () => {
				await using fixture = await spawnPipeHolder({ detached: true, output: '"token"' });
				let threw: unknown;
				try {
					await fixture.child[outputMethod]();
				} catch (error) {
					threw = error;
				}

				expect(threw).toBeInstanceOf(TimeoutError);
			},
		);
	}

	it.skipIf(process.platform === "win32")("keeps reading inherited stdout until EOF without a timeout", async () => {
		const result = await exec(["/bin/sh", "-c", "(sleep .2; printf token) &"], {
			allowNonZero: true,
			allowAbort: true,
		});

		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("token");
	});

	it.skipIf(process.platform === "win32")(
		"refuses cleanup after a Unix root exits and leaves its pipe holder responding",
		async () => {
			await using fixture = await spawnPipeHolder({ detached: true });
			const result = await fixture.child.wait({ allowNonZero: true, allowAbort: true });

			expect(result.exitError).toBeInstanceOf(TimeoutError);
			expect(result.stdout).toBe("token");
			expect(await fixture.ping()).toBe("alive");
			expect(fixture.descendant.status()).toBe(ProcessStatus.Running);
		},
	);

	it.skipIf(process.platform !== "win32")(
		"terminates a pipe-holding descendant after the Windows root exits",
		async () => {
			// Windows retains the root handle for its post-exit Toolhelp tree walk.
			await using fixture = await spawnPipeHolder();
			const result = await fixture.child.wait({ allowNonZero: true, allowAbort: true });

			expect(result.exitError).toBeInstanceOf(TimeoutError);
			expect(await fixture.descendant.waitForExit({ timeoutMs: 500 })).toBe(true);
			expect(fixture.descendant.status()).not.toBe(ProcessStatus.Running);
		},
	);

	it.skipIf(process.platform === "win32")(
		"throws NonZeroExitError by default when the child exits nonzero",
		async () => {
			// wait()'s default contract: without allowNonZero, a nonzero exit rejects
			// instead of returning an unsuccessful result.
			let threw: unknown;
			try {
				await exec(["sh", "-c", "exit 3"]);
			} catch (err) {
				threw = err;
			}
			expect(threw).toBeInstanceOf(NonZeroExitError);
		},
	);

	it.skipIf(process.platform === "win32")("completes when an orphan holds stdout past the root's exit", async () => {
		await using fixture = await spawnPipeHolder({ timeout: 1_000 });
		const start = performance.now();
		const result = await fixture.child.wait({ allowNonZero: true, allowAbort: true });

		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("token");
		expect(performance.now() - start).toBeLessThan(5_000);
	});

	it.skipIf(process.platform === "win32")("completes when an orphan holds stderr past the root's exit", async () => {
		await using fixture = await spawnPipeHolder({ pipe: "stderr", output: "token2", timeout: 1_000 });
		const start = performance.now();
		const result = await fixture.child.wait({ allowNonZero: true, allowAbort: true });

		expect(result.ok).toBe(true);
		expect(result.stderr).toBe("token2");
		expect(performance.now() - start).toBeLessThan(5_000);
	});

	it.skipIf(process.platform === "win32")("completes when a nonzero exit races an orphan holding stderr", async () => {
		// Nonzero normalization must finish even while the inherited stderr stays open.
		await using fixture = await spawnPipeHolder({
			pipe: "stderr",
			output: "nonzero",
			exitCode: 1,
			timeout: 1_000,
		});
		const start = performance.now();
		const result = await fixture.child.wait({ allowNonZero: true, allowAbort: true });

		expect(result.exitCode).toBe(1);
		expect(result.exitError).toBeInstanceOf(NonZeroExitError);
		expect(result.stderr).toBe("nonzero");
		expect(performance.now() - start).toBeLessThan(5_000);
	});

	it.skipIf(process.platform === "win32")(
		"preserves the timeout reason when nonzero normalization waits for stderr",
		async () => {
			// Cleanup refusal must not replace the timeout with the earlier exit code.
			await using fixture = await spawnPipeHolder({ detached: true, pipe: "stderr", exitCode: 7 });
			let threw: unknown;
			try {
				await fixture.child.wait({ allowNonZero: true });
			} catch (err) {
				threw = err;
			}

			expect(threw).toBeInstanceOf(TimeoutError);
		},
	);
});
