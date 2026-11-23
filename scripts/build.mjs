import { build } from "esbuild";
import { readdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
const sources = await readdir("src", { recursive: true });
await build({
  entryPoints: sources
    .filter((source) => source.endsWith(".ts"))
    .map((source) => `src/${source}`),
  outbase: "src",
  outdir: "dist",
  platform: "node",
  target: "node24",
  format: "esm",
});
