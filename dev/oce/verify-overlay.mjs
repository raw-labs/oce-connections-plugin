import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [stage, checkout] = process.argv.slice(2);
if (!stage || !checkout || process.argv.length !== 4)
  throw new Error(
    "Usage: node dev/oce/verify-overlay.mjs STAGED_BUNDLE OCE_DEV_CHECKOUT",
  );

function fromOce(file) {
  return import(
    pathToFileURL(resolve(checkout, "apps/controller/src/drivers", file)).href
  );
}

const { managedCliInstalls, managedPluginCredentials } = await fromOce(
  "plugin/managed-catalog.ts",
);
const { describeManagedDeployment } = await fromOce(
  "plugin/managed-deployment.ts",
);
const { compileOpenShellCredentialPolicy } = await fromOce(
  "sandbox/openshell-credential-policy.ts",
);
const { registrations } = await fromOce("plugin/connections-dev-data.ts");

for (const registration of registrations) {
  const install = managedCliInstalls.find(
    ({ id }) => id === registration.pluginId,
  );
  assert.ok(install, "OCE must load the staged catalog entry");
  const name = registration.packageName.slice("oce-connections-".length);
  const template = {
    ...JSON.parse(
      await readFile(
        join(stage, "connection-templates", name + ".json"),
        "utf8",
      ),
    ),
    templateId: "ct_dev",
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const source = {
    id: "cs_dev",
    namespaceId: "ns_dev",
    name: "Controlled OAuth Source",
    ownerCapability: "token_service",
    tokenServiceInstanceId: "dev",
    state: "ready",
    type: "oauth2-refresh-token",
    connectionTemplateId: template.templateId,
    createdAt: template.createdAt,
    consent: {
      kind: "connection_template",
      version: template.version,
      oauthClientId: "ccr_dev",
      ownerPrincipalId: "user_dev",
      requestedScopes: [registration.scope],
      grantedScopes: [registration.scope],
    },
  };
  const describeDeployment = (input) =>
    describeManagedDeployment(install, input);
  const policy = managedPluginCredentials({ describeDeployment });
  const result = (candidate) =>
    policy
      .choices([source], new Map([[source.id, candidate]]))
      .find(({ pluginId, id }) => pluginId === install.id && id === "account")
      ?.sources;
  assert.deepEqual(result(template), [{ id: source.id, name: source.name }]);
  assert.deepEqual(
    result({
      ...template,
      destinations: [
        { ...template.destinations[0], host: "different.example.test" },
      ],
    }),
    [],
  );
  assert.deepEqual(result({ ...template, version: template.version + 1 }), []);

  const sourceRef = {
    kind: "credential_source",
    id: source.id,
    namespaceId: source.namespaceId,
  };
  const description = describeDeployment({
    selection: {
      enabled: true,
      driverPolicy: {
        releaseSha256: install.releaseSha256,
        credentials: { account: source.id },
      },
    },
    connections: { account: { default: sourceRef } },
  });
  assert.deepEqual(
    description.networkRequirements,
    registration.deploymentNetworks.credential,
  );
  assert.equal(
    description.credentials.account.default.projection.presentation,
    "bearer",
  );
  assert.equal(
    description.credentials.account.default.projection.environment,
    registration.environment,
  );
  const allowed = description.networkRequirements.map(({ match }) => match);
  const projection = description.credentials.account.default.projection;
  assert.throws(
    () =>
      compileOpenShellCredentialPolicy({
        bindings: [
          {
            bindingRef: source.id,
            sourceRef,
            projection,
            consumer: {
              kind: "plugin",
              pluginId: install.id,
              requirement: "account",
              connection: "default",
            },
          },
        ],
        injectionPolicies: [
          { bindingRef: source.id, allowedRequests: allowed },
        ],
        networkAccessPolicy: { allowed },
      }),
    /Connections requires HTTPS-only OpenShell credential substitution/,
  );
}
assert.ok(registrations.length > 0);
process.stdout.write(
  "OCE admitted the matching slot sources, generated exact Bearer routes, and refused unqualified OpenShell credential delivery.\n",
);
