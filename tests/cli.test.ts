import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { z } from "zod";
import { ComposioFixture } from "./helpers/composio.js";
import {
  apiKey,
  clientSecret,
  enroll,
  fixture,
  readTokens,
  revoke,
  tokenRequest,
} from "./helpers/https.js";

await test(
  "one native CLI discovers and invokes independently granted accounts across a restart",
  { timeout: 25_000 },
  async (t) => {
    const provider = new ComposioFixture();
    const service = await fixture(t, provider.handle);
    const work = await enroll(service.origin, "github");
    const personal = await enroll(service.origin, "github");
    const chat = await enroll(service.origin, "slack");
    const accounts = [...provider.accounts.values()];
    assert.equal(accounts.length, 3);
    assert.equal(new Set(accounts.map(({ user_id }) => user_id)).size, 3);

    const slots = { GITHUB_WORK: work, GITHUB_PERSONAL: personal, SLACK: chat };
    const env: NodeJS.ProcessEnv = {
      OCE_CONNECTIONS_CA_FILE: service.certPath,
    };
    const secrets = [apiKey, clientSecret];
    for (const [slot, token] of Object.entries(slots)) {
      env[`OCE_CONNECTIONS_${slot}_URL`] = service.origin;
      env[`OCE_CONNECTIONS_${slot}_TOKEN`] = token.access_token;
      secrets.push(token.access_token, token.refresh_token);
    }

    async function cli(slot: string, command: string[], input = "") {
      const child = spawn(
        ".local/oce-connections",
        ["--slot", slot, ...command],
        { env },
      );
      const output: Buffer[] = [];
      const errors: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
      child.stdin.end(input);
      const [code] = await once(child, "close");
      const stdout = Buffer.concat(output).toString();
      const stderr = Buffer.concat(errors).toString();
      for (const secret of secrets)
        assert.equal((stdout + stderr).includes(secret), false);
      return { code, stdout, stderr };
    }

    const connectorFor = {
      "github-work": "github",
      "github-personal": "github",
      slack: "slack",
    };
    const requestId = randomUUID();
    for (const [index, [slot, connector]] of Object.entries(
      connectorFor,
    ).entries()) {
      const action = `${connector.toUpperCase()}_READ_ACCOUNT`;
      const found = await cli(slot, [
        "actions",
        "--query",
        "read",
        "--limit",
        "1",
      ]);
      assert.equal(found.code, 0, found.stderr);
      const search = z
        .object({
          connector: z.string(),
          items: z.array(z.object({ id: z.string() })),
          nextCursor: z.literal("1"),
        })
        .parse(JSON.parse(found.stdout));
      assert.equal(search.connector, connector);
      assert.deepEqual(search.items, [{ id: action }]);
      const next = await cli(slot, [
        "actions",
        "--cursor",
        search.nextCursor,
        "--limit",
        "1",
      ]);
      assert.equal(next.code, 0, next.stderr);
      assert.match(next.stdout, /GET_NAME/);

      const described = await cli(slot, ["describe", action]);
      assert.equal(described.code, 0, described.stderr);
      const {
        action: { version },
      } = z
        .object({
          action: z.object({
            version: z.string(),
            inputSchema: z.object({ type: z.literal("object") }),
          }),
        })
        .parse(JSON.parse(described.stdout));
      const sent = await cli(
        slot,
        ["run", action, "--version", version, "--request-id", requestId],
        '{"echo":{"test":true}}',
      );
      assert.equal(sent.code, 0, sent.stderr);
      assert.deepEqual(
        z
          .object({ result: z.object({ data: z.unknown() }) })
          .parse(JSON.parse(sent.stdout)).result.data,
        { account: accounts[index]?.id, result: { test: true } },
      );
    }

    assert.deepEqual(
      provider.executions.map(({ account }) => account),
      ["account-1", "account-2", "account-3"],
    );
    assert.equal(
      (
        await cli(
          "slack",
          ["run", "GITHUB_READ_ACCOUNT", "--version", "20261112_00"],
          "{}",
        )
      ).code,
      1,
    );
    assert.equal(provider.executions.length, 3);

    await service.stop();
    await service.start();
    assert.match(
      (await cli("github-work", ["receipt", requestId])).stdout,
      /account-1/,
    );
    assert.match(
      (await cli("github-personal", ["receipt", requestId])).stdout,
      /account-2/,
    );
    const next = await readTokens(
      await tokenRequest(service.origin, {
        grant_type: "refresh_token",
        refresh_token: work.refresh_token,
      }),
    );
    secrets.push(next.access_token, next.refresh_token);
    env.OCE_CONNECTIONS_GITHUB_WORK_TOKEN = next.access_token;
    assert.match(
      (await cli("github-work", ["receipt", requestId])).stdout,
      /account-1/,
    );

    // A superseded refresh token still identifies its own family for revocation.
    assert.equal(
      (await revoke(service.origin, work.refresh_token)).status,
      200,
    );
    const denied = await cli("github-work", ["actions"]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /401 \(invalid_token\)/);
    env.OCE_CONNECTIONS_GITHUB_WORK_TOKEN = work.access_token;
    assert.equal((await cli("github-work", ["actions"])).code, 1);
    assert.equal(
      (
        await tokenRequest(service.origin, {
          grant_type: "refresh_token",
          refresh_token: next.refresh_token,
        })
      ).status,
      400,
    );

    assert.match(
      (await cli("github-personal", ["receipt", requestId])).stdout,
      /account-2/,
    );
    assert.match(
      (await cli("slack", ["receipt", requestId])).stdout,
      /account-3/,
    );
    for (const secret of secrets)
      assert.equal(service.logs.join("").includes(secret), false);
  },
);
