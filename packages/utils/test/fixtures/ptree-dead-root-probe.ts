// The root may exit only after the test pins its child and acknowledges readiness.
const options = JSON.parse(process.argv[2]!) as {
	pipe: "stdout" | "stderr";
	output: string;
	exitCode: number;
};

if (process.argv[3] === "holder") {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("alive"),
	});
	process.send?.({ pid: process.pid, port: server.port });
	// Real subprocess watchdog: fake timers cannot bound a vanished runner.
	setTimeout(() => process.exit(0), 30_000);
} else {
	const command = Promise.withResolvers<"release" | "stop">();
	process.on("message", message => {
		if (message === "release" || message === "stop") command.resolve(message);
	});
	process.on("disconnect", () => command.resolve("stop"));
	// Startup is event-driven; this real watchdog only bounds a failed handshake.
	const watchdog = setTimeout(() => command.resolve("stop"), 4_000);
	const child = Bun.spawn([process.execPath, import.meta.filename, process.argv[2]!, "holder"], {
		stdin: "ignore",
		stdout: options.pipe === "stdout" ? "inherit" : "ignore",
		stderr: options.pipe === "stderr" ? "inherit" : "ignore",
		windowsHide: true,
		ipc(message) {
			process.send?.(message);
		},
	});
	let released = false;
	try {
		if ((await command.promise) === "release") {
			await Bun.write(options.pipe === "stdout" ? Bun.stdout : Bun.stderr, options.output);
			released = true;
		}
	} finally {
		clearTimeout(watchdog);
		if (!released) {
			// This Bun handle still owns the direct child, including failed startup.
			child.kill();
			await child.exited;
		}
	}
	process.exit(released ? options.exitCode : 1);
}
