import { execFileSync } from "node:child_process";
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

execFileSync(
  "go",
  [
    "build",
    "-trimpath",
    "-buildvcs=false",
    "-o",
    ".local/oce-connections",
    "./cli",
  ],
  {
    env: { ...process.env, CGO_ENABLED: "0" },
    stdio: "inherit",
  },
);
