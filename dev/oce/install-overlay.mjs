import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const upstreamRevision = "03f8e1f2c5d6d970e3d24bb25e96aebd475c30ea";
const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));
const methods = ["GET", "POST"];
const paths = ["/v1/actions", "/v1/action", "/v1/calls"];
const binary = "/usr/local/lib/oce/plugins/connections/bin/oce-connections";
const registrationSchema = z.object({
  packageName: z.string().regex(/^oce-connections-[a-z][a-z0-9-]{0,23}$/),
  pluginId: z
    .string()
    .regex(/^occ-plugin:connections-[a-z][a-z0-9-]{0,23}@[0-9A-Za-z.+-]+$/),
  releaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  environment: z.string().regex(/^OCE_CONNECTIONS_[A-Z][A-Z0-9_]{0,23}_TOKEN$/),
  connector: z.string().regex(/^[a-z0-9_]{1,80}$/),
  host: z.string().regex(/^[a-z0-9.-]+$/),
  authorizationUrl: z.url(),
  scope: z.literal("connections"),
  deploymentNetworks: z.strictObject({
    networkOnly: z.tuple([]),
    credential: z
      .array(
        z.strictObject({
          id: z.string(),
          toolId: z.literal("oce-connections"),
          purpose: z.literal("invocation"),
          match: z.strictObject({
            binary: z.literal(binary),
            host: z.string(),
            ports: z.tuple([
              z.strictObject({ from: z.literal(443), to: z.literal(443) }),
            ]),
            requestPolicy: z.strictObject({
              type: z.literal("http"),
              method: z.enum(methods),
              path: z.enum(paths),
            }),
          }),
        }),
      )
      .length(4),
  }),
});
const marketplaceSchema = z
  .object({
    plugins: z.array(
      z.object({ name: z.string(), source: z.string() }).loose(),
    ),
  })
  .loose();

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function install(stage, checkout) {
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  if (
    git("rev-parse", "--show-toplevel") !== checkout ||
    git("rev-parse", "HEAD") !== upstreamRevision ||
    git("status", "--porcelain")
  )
    throw new Error(
      `Use a clean, disposable OCE checkout at ${upstreamRevision}.`,
    );

  const registrations = z
    .array(registrationSchema)
    .min(1)
    .parse(await readJson(join(stage, "registrations.json")));
  const marketplaceFile = join(
    checkout,
    "apps/controller/plugins/marketplace.json",
  );
  const marketplace = marketplaceSchema.parse(await readJson(marketplaceFile));
  const names = new Set(marketplace.plugins.map(({ name }) => name));
  const hosts = new Set();
  const environments = new Set();
  for (const registration of registrations) {
    const {
      host,
      packageName,
      environment,
      deploymentNetworks,
      releaseSha256,
    } = registration;
    const rules = deploymentNetworks.credential
      .map(
        ({ match }) =>
          `${match.host} ${match.requestPolicy.method} ${match.requestPolicy.path}`,
      )
      .sort();
    const expected = [
      "GET /v1/actions",
      "GET /v1/action",
      "GET /v1/calls",
      "POST /v1/calls",
    ]
      .map((route) => `${host} ${route}`)
      .sort();
    if (
      names.has(packageName) ||
      hosts.has(host) ||
      environments.has(environment) ||
      rules.some((rule, index) => rule !== expected[index])
    )
      throw new Error(
        "Invalid or overlapping Connections plugin registration.",
      );
    const release = join(
      stage,
      "catalog",
      packageName,
      "ai.openclaw.oce/release.json",
    );
    if (sha(await readFile(release)) !== releaseSha256)
      throw new Error(
        "A Connections release differs from its registered policy.",
      );
    names.add(packageName);
    hosts.add(host);
    environments.add(environment);
    marketplace.plugins.push({ name: packageName, source: `./${packageName}` });
  }

  const workerPatch = (
    await readFile(join(sourceDirectory, "worker-placeholder.patch.in"), "utf8")
  ).replace(
    "__OCE_CONNECTIONS_ENVIRONMENTS__",
    JSON.stringify([...environments].sort()),
  );
  const patch = join(sourceDirectory, "oce-main.patch");
  git("apply", "--check", patch);
  git("apply", patch);
  const driver = join(checkout, "apps/controller/src/drivers/plugin");
  await copyFile(
    join(sourceDirectory, "managed-cli-policy.ts"),
    join(driver, "connections-dev-policy.ts"),
  );
  await writeFile(
    join(driver, "connections-dev-data.ts"),
    'import type { ConnectionsRegistration } from "./connections-dev-policy.ts";\n\n' +
      `export const registrations: readonly ConnectionsRegistration[] = ${JSON.stringify(registrations, null, 2)};\n`,
  );
  for (const { packageName } of registrations) {
    await cp(
      join(stage, "catalog", packageName),
      join(checkout, "apps/controller/plugins", packageName),
      {
        recursive: true,
        force: false,
        errorOnExist: true,
      },
    );
  }
  await writeFile(marketplaceFile, JSON.stringify(marketplace, null, 2) + "\n");
  const runtime = join(checkout, "deploy/runtime");
  await cp(join(stage, "runtime"), join(runtime, "oce-connections-overlays"), {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  await writeFile(join(runtime, "oce-connections-worker.patch"), workerPatch);
  await writeFile(
    join(runtime, "oce-connections-worker.sha256"),
    `${sha(workerPatch)}  oce-connections-worker.patch\n`,
  );
  process.stdout.write(
    "Installed Connections into the disposable OCE checkout.\n",
  );
}

const [stage, checkout] = process.argv.slice(2);
if (!stage || !checkout || process.argv.length !== 4) {
  process.stderr.write(
    "Usage: pnpm install:oce STAGED_BUNDLE OCE_DEV_CHECKOUT\n",
  );
  process.exitCode = 2;
} else {
  await install(resolve(stage), await realpath(checkout));
}
