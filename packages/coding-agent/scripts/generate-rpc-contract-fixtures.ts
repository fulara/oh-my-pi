import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rpcContractFixtures } from "../test/fixtures/rpc-contract/frames";

const outDir = process.argv[2] ?? fileURLToPath(new URL("../test/fixtures/rpc-contract/generated", import.meta.url));

await mkdir(outDir, { recursive: true });

for (const entry of await readdir(outDir)) {
	if (entry.endsWith(".json")) {
		await rm(join(outDir, entry));
	}
}

const manifest: Array<{ name: string; category: string; file: string }> = [];

for (const fixture of rpcContractFixtures) {
	const file = `${fixture.name}.json`;
	const wireFrame = JSON.parse(JSON.stringify(fixture.frame));
	await Bun.write(join(outDir, file), `${JSON.stringify(wireFrame, null, 2)}\n`);
	manifest.push({ name: fixture.name, category: fixture.category, file });
}

manifest.sort((a, b) => a.name.localeCompare(b.name));
await Bun.write(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
