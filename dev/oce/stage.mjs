import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("../../", import.meta.url));
const releaseRoot = "/usr/local/lib/oce/plugins/connections";
const binary = `${releaseRoot}/bin/oce-connections`;
const skill = "connections";
const scope = "connections";
const architectures = ["amd64", "arm64"];
const routes = [
  ["GET", "/v1/actions"],
  ["GET", "/v1/action"],
  ["GET", "/v1/calls"],
  ["POST", "/v1/calls"],
];
const httpsOrigin = z
  .string()
  .regex(/^https:\/\/[a-z0-9.-]+$/)
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url?.origin === value &&
      url.hostname.length <= 253 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        url.hostname,
      )
    );
  });
const settingsSchema = z.strictObject({
  issuer: httpsOrigin,
  slots: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
        label: z.string().trim().min(1).max(200),
        connector: z.string(),
        origin: httpsOrigin,
      }),
    )
    .min(1)
    .max(20),
});

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, data) {
  const content = JSON.stringify(data, null, 2) + "\n";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return sha(content);
}

async function copy(source, file) {
  await mkdir(dirname(file), { recursive: true });
  await copyFile(source, file);
}

async function stage(settingsFile, output) {
  const { issuer, slots } = settingsSchema.parse(await json(settingsFile));
  const { connectors } = await json(join(root, "assets/catalog.json"));
  for (const { connector } of slots) {
    if (!connectors.some(({ id }) => id === connector))
      throw new Error(`Unknown connector: ${connector}`);
  }
  if (
    new Set(slots.map(({ name }) => name)).size !== slots.length ||
    new Set(slots.map(({ origin }) => origin)).size !== slots.length ||
    slots.some(({ origin }) => origin === issuer)
  )
    throw new Error(
      "Use unique slot names and distinct HTTPS API origins for each slot and issuer.",
    );

  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length)
    throw new Error("Choose an empty output directory.");
  const skillFile = join(root, "skills", skill, "SKILL.md");
  const skillSha256 = sha(await readFile(skillFile));
  const { version } = await json(join(root, "package.json"));
  const goRoot = execFileSync("go", ["env", "GOROOT"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const artifacts = {};

  for (const arch of architectures) {
    const platform = `linux-${arch}`;
    const overlay = join(output, "runtime", platform);
    const executable = join(overlay, binary);
    await mkdir(dirname(executable), { recursive: true });
    execFileSync(
      "go",
      ["build", "-trimpath", "-buildvcs=false", "-o", executable, "./cli"],
      {
        cwd: root,
        env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch },
        stdio: "inherit",
      },
    );
    artifacts[platform] = { binarySha256: sha(await readFile(executable)) };
    const link = join(overlay, "usr/local/bin/oce-connections");
    await mkdir(dirname(link), { recursive: true });
    await symlink(binary, link);
    await copy(
      skillFile,
      join(overlay, releaseRoot, "skills", skill, "SKILL.md"),
    );
    await copy(
      join(goRoot, "LICENSE"),
      join(overlay, releaseRoot, "licenses/Go-LICENSE"),
    );
    await copy(
      join(root, "LICENSE"),
      join(overlay, releaseRoot, "licenses/Connections-LICENSE"),
    );
    await writeJson(
      join(overlay, "etc/oce-connections/slots.json"),
      Object.fromEntries(slots.map(({ name, origin }) => [name, origin])),
    );
  }

  const registrations = [];
  const marketplace = [];
  const catalog = join(output, "catalog");
  for (const { name, connector, label, origin } of slots) {
    const packageName = `oce-connections-${name}`;
    const id = `occ-plugin:connections-${name}`;
    const host = new URL(origin).hostname;
    const env = `OCE_CONNECTIONS_${name.toUpperCase().replaceAll("-", "_")}_TOKEN`;
    const tokenEndpoint = `${issuer}/oauth/token`;
    const release = {
      release: `connections-${version}-${name}`,
      placement: {
        harnessId: "openclaw",
        mode: "dedicated",
        computeImplementations: ["occ/kubernetes", "kubernetes-local"],
      },
      capabilities: { gateway: ["skill"], harness: ["cli"] },
      credentials: {
        account: {
          label,
          issuer,
          tokenEndpoint,
          delivery: { role: "harness", env, presentation: "bearer" },
        },
      },
      skill,
      skillSha256,
      executable: "oce-connections",
      version,
      artifacts,
      runtimeDirectory: releaseRoot,
    };
    const releasePath = `./ai.openclaw.oce/release.json`;
    const dir = join(catalog, packageName);
    await writeJson(join(dir, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: packageName,
      version,
      description:
        "Use a saved account through the Connections CLI on a dedicated OpenClaw Harness.",
      license: "MIT",
      author: { name: "RAW Labs SA" },
      repository: "https://github.com/raw-labs/oce-connections-plugin",
      extensions: {
        "ai.openclaw.oce": {
          id,
          displayName: label,
          policyScope: "enablement_only",
          release: releasePath,
        },
      },
    });
    const releaseSha256 = await writeJson(join(dir, releasePath), release);
    await copy(skillFile, join(dir, "skills", skill, "SKILL.md"));
    marketplace.push({ name: packageName, source: `./${packageName}` });
    await writeJson(join(output, "connection-templates", `${name}.json`), {
      displayName: label,
      mode: "manual",
      issuer,
      authorizationUrl: `${issuer}/oauth/authorize/${connector}`,
      tokenUrl: tokenEndpoint,
      revocationUrl: `${issuer}/oauth/revoke`,
      scopes: [scope],
      destinations: [{ host, port: 443, path: "/v1/**" }],
    });
    registrations.push({
      pluginId: `${id}@${version}`,
      packageName,
      slot: "account",
      releaseSha256,
      host,
      connector,
      environment: env,
      clientId: packageName,
      requestScope: JSON.stringify({
        host,
        port: 443,
        path: "/v1/**",
        scopes: [scope],
      }),
      deploymentNetworks: {
        networkOnly: [],
        credential: routes.map(([method, path]) => ({
          id: `connections:${name}:${method}:${path}`,
          toolId: "oce-connections",
          purpose: "invocation",
          match: {
            binary,
            host,
            ports: [{ from: 443, to: 443 }],
            requestPolicy: { type: "http", method, path },
          },
        })),
      },
    });
  }

  await writeJson(join(output, "marketplace.fragment.json"), {
    plugins: marketplace,
  });
  await writeJson(join(output, "registrations.json"), registrations);
  await copy(
    new URL("./request-policy.mjs", import.meta.url),
    join(output, "request-policy.mjs"),
  );
  for (const arch of architectures) {
    const overlayCatalog = join(
      output,
      "runtime",
      `linux-${arch}`,
      "usr/local/lib/oce/plugin-catalog",
    );
    for (const { packageName } of registrations) {
      for (const file of [
        "plugin.json",
        "ai.openclaw.oce/release.json",
        "skills/connections/SKILL.md",
      ])
        await copy(
          join(catalog, packageName, file),
          join(overlayCatalog, packageName, file),
        );
    }
  }
}

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) {
  process.stderr.write("Usage: pnpm build:oce SLOTS.json OUTPUT_DIRECTORY\n");
  process.exitCode = 2;
} else {
  await stage(resolve(input), resolve(output));
}
