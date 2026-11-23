import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerConnectionsRequestPolicies } from "../dev/oce/request-policy.mjs";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

await test(
  "the dev bundle registers separate Bearer routes for the same CLI and independently attached accounts",
  { timeout: 120_000 },
  async (t) => {
    const stage = await mkdtemp(join(tmpdir(), "oce-connections-bundle-"));
    t.after(() => rm(stage, { recursive: true, force: true }));
    execFileSync(
      process.execPath,
      ["dev/oce/stage.mjs", "dev/oce/slots.example.json", stage],
      {
        timeout: 110_000,
        stdio: "inherit",
      },
    );
    const registrations = await readJson(join(stage, "registrations.json"));
    const registry = new Map();
    registerConnectionsRequestPolicies(registry, registrations);
    assert.equal(registry.size, 3);
    assert.equal(new Set(registrations.map(({ host }) => host)).size, 3);
    assert.equal(
      new Set(registrations.map(({ environment }) => environment)).size,
      3,
    );
    assert.deepEqual(
      registrations.map(({ connector }) => connector),
      ["github", "github", "slack"],
    );
    assert.throws(
      () => registerConnectionsRequestPolicies(registry, registrations),
      /already registered/,
    );

    const readPath = "/v1/action";
    for (const [index, registration] of registrations.entries()) {
      const {
        packageName,
        releaseSha256,
        host,
        requestScope,
        deploymentNetworks,
        environment,
      } = registration;
      const packageDir = join(stage, "catalog", packageName);
      const bytes = await readFile(
        join(packageDir, "ai.openclaw.oce/release.json"),
      );
      assert.equal(releaseSha256, hash(bytes));
      const release = JSON.parse(bytes);
      assert.deepEqual(release.placement, {
        harnessId: "openclaw",
        mode: "dedicated",
        computeImplementations: ["occ/kubernetes", "kubernetes-local"],
      });
      assert.deepEqual(Object.keys(release.credentials), ["account"]);
      assert.deepEqual(release.credentials.account.delivery, {
        role: "harness",
        env: environment,
        presentation: "bearer",
      });
      const binary = release.runtimeDirectory + "/bin/" + release.executable;
      assert.equal(
        release.skillSha256,
        hash(await readFile(join(packageDir, "skills/connections/SKILL.md"))),
      );
      for (const platform of ["linux-amd64", "linux-arm64"]) {
        const root = join(stage, "runtime", platform);
        assert.equal(
          hash(await readFile(join(root, binary))),
          release.artifacts[platform].binarySha256,
        );
        assert.equal((await stat(join(root, binary))).mode & 0o111, 0o111);
        assert.equal(
          await readlink(join(root, "usr/local/bin/oce-connections")),
          binary,
        );
        const slot = packageName.slice("oce-connections-".length);
        assert.equal(
          (await readJson(join(root, "etc/oce-connections/slots.json")))[slot],
          `https://${host}`,
        );
        const template = await readJson(
          join(stage, "connection-templates", slot + ".json"),
        );
        assert.equal(
          template.authorizationUrl,
          release.credentials.account.issuer +
            "/oauth/authorize/" +
            registration.connector,
        );
        assert.deepEqual(template.destinations, [
          { host, port: 443, path: "/v1/**" },
        ]);
      }
      assert.deepEqual(deploymentNetworks.networkOnly, []);
      assert.deepEqual(
        deploymentNetworks.credential.map(({ match }) => match),
        [
          ["GET", "/v1/actions"],
          ["GET", readPath],
          ["GET", "/v1/calls"],
          ["POST", "/v1/calls"],
        ].map(([method, path]) => ({
          binary,
          host,
          ports: [{ from: 443, to: 443 }],
          requestPolicy: { type: "http", method, path },
        })),
      );

      const policy = registry.get(releaseSha256);
      assert.ok(policy.acceptsScope(requestScope));
      const request = {
        bindingId: releaseSha256,
        bindingConfig: requestScope,
        target: {
          reportedScheme: "https",
          method: "GET",
          port: 443,
          host,
          path: readPath,
          query: "id=GITHUB_READ_ACCOUNT",
        },
        headers: [
          ["accept", "application/json"],
          ["accept-encoding", "gzip"],
          ["user-agent", "oce-connections"],
        ],
        body: new Uint8Array(),
      };
      assert.equal(policy.allows(request), true);
      for (const target of [
        { reportedScheme: "http" },
        { path: "/oauth/token" },
        { path: "/v1/%61ction" },
        { path: "/v1/x/../action" },
        { port: 8443 },
        { method: "DELETE" },
        { host: registrations[(index + 1) % 3].host },
        { host: "backend.composio.dev" },
        { query: "id=GITHUB_READ_ACCOUNT&account=another" },
        { query: "id=GITHUB_READ_ACCOUNT&id=SLACK_READ_ACCOUNT" },
      ])
        assert.equal(
          policy.allows({
            ...request,
            target: { ...request.target, ...target },
          }),
          false,
        );
      assert.equal(
        policy.allows({
          ...request,
          bindingConfig: registrations[(index + 1) % 3].requestScope,
        }),
        false,
      );
      assert.equal(
        policy.allows({ ...request, headers: [["x-api-key", "fixture"]] }),
        false,
      );

      const invocation = {
        actionId: "GITHUB_READ_ACCOUNT",
        version: "20261112_00",
        requestId: randomUUID(),
        arguments: {},
      };
      const post = {
        ...request,
        headers: [...request.headers, ["content-type", "application/json"]],
        target: {
          ...request.target,
          method: "POST",
          path: "/v1/calls",
          query: "",
        },
      };
      assert.equal(
        policy.allows({
          ...post,
          body: Buffer.from(JSON.stringify(invocation)),
        }),
        true,
      );
      assert.equal(
        policy.allows({
          ...post,
          body: Buffer.from(
            JSON.stringify({
              ...invocation,
              connected_account_id: "account-2",
            }),
          ),
        }),
        false,
      );
    }
  },
);
