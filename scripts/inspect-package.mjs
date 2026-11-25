import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync(".local", { recursive: true });
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", ".local"], {
    encoding: "utf8",
  }),
);
assert.equal(packed.name, "@raw-labs/oce-connections-plugin");
assert.equal(packed.version, manifest.version);
const paths = new Set(packed.files.map(({ path }) => path));
for (const path of [
  "dist/main.js",
  "cli/main.go",
  "go.mod",
  "dev/service.example.json",
  "dev/oce/Dockerfile",
  "dev/oce/stage.mjs",
  "dev/oce/install-overlay.mjs",
  "dev/oce/verify-overlay.mjs",
  "dev/oce/managed-cli-policy.ts",
  "dev/oce/oce-main.patch",
  "dev/oce/worker-placeholder.patch.in",
  "dev/oce/slots.example.json",
  "dist/catalog.js",
  "assets/catalog.json",
  "assets/oauth.json",
  "skills/connections/SKILL.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
])
  assert.ok(paths.has(path), `Missing package entry: ${path}`);
for (const path of paths)
  assert.ok(!path.startsWith("src/") && !path.startsWith("tests/"), path);
