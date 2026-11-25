import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import { ComposioFixture } from "./helpers/composio.js";
import { apiKey, enroll, fixture, revoke } from "./helpers/https.js";

await test(
  "HTTPS dispatch uses exact grants, stores receipts and never replays an interrupted mutation",
  { timeout: 20_000 },
  async (t) => {
    const provider = new ComposioFixture();
    const upstreamRequests: string[] = [];
    const service = await fixture(t, async (req, res, origin) => {
      upstreamRequests.push(req.url ?? "");
      await provider.handle(req, res, origin);
    });
    const github = await enroll(service.origin, "github");
    const slack = await enroll(service.origin, "slack");
    const version = "20261112_00";
    const actionId = "GITHUB_READ_ACCOUNT";
    const requestId = "a6ec6a48-e6b2-4099-a61a-8744a24d20d2";
    const proposed = {
      actionId,
      version,
      requestId,
      arguments: { echo: { custom: 42 } },
    };
    const get = (path: string, token = github.access_token) =>
      fetch(service.origin + path, {
        headers: { authorization: `Bearer ${token}` },
      });
    const run = (params: object, token = github.access_token) =>
      fetch(service.origin + "/v1/calls", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(params),
      });

    upstreamRequests.length = 0;
    assert.equal((await get("/v1/actions", github.refresh_token)).status, 401);
    const cold = await run(proposed, slack.access_token);
    assert.equal(cold.status, 409);
    assert.deepEqual(await cold.json(), { error: "catalog_refresh_required" });
    assert.equal(
      (await get("/v1/action?id=GITHUB_READ_ACCOUNT", slack.access_token))
        .status,
      409,
    );
    assert.deepEqual(upstreamRequests, []);
    const catalog: unknown = await (await get("/v1/actions?limit=1")).json();
    assert.ok(
      catalog &&
        typeof catalog === "object" &&
        "items" in catalog &&
        Array.isArray(catalog.items),
    );
    assert.deepEqual(
      catalog.items.map((item: { id: string }) => item.id),
      [actionId],
    );
    assert.equal((await get("/v1/actions", slack.access_token)).status, 200);
    upstreamRequests.length = 0;
    assert.equal(
      (await get("/v1/action?id=COMPOSIO_PROXY_EXECUTE")).status,
      404,
    );
    assert.equal(
      (await get("/v1/action?id=GITHUB_CUSTOM_API_CALL")).status,
      404,
    );
    assert.equal((await run(proposed, slack.access_token)).status, 404);
    assert.equal((await run({ ...proposed, version: "stale" })).status, 409);
    assert.equal(
      (await run({ ...proposed, connected_account_id: "account-2" })).status,
      400,
    );
    assert.equal((await run({ ...proposed, toolkit: "slack" })).status, 400);
    assert.equal(
      (await run({ ...proposed, upstreamUrl: "https://example.test" })).status,
      400,
    );
    assert.deepEqual(upstreamRequests, []);
    assert.equal(provider.executions.length, 0);

    const [first, duplicate] = await Promise.all([
      run(proposed),
      run({ ...proposed, requestId: requestId.toUpperCase() }),
    ]);
    const outcome: unknown = await first.json();
    assert.deepEqual(outcome, {
      requestId,
      actionId,
      version,
      status: "succeeded",
      detail: null,
      result: {
        kind: "inline",
        data: { account: "account-1", result: { custom: 42 } },
      },
    });
    assert.deepEqual(await duplicate.json(), outcome);
    assert.equal(provider.executions.length, 1);
    assert.deepEqual(
      await (
        await get(`/v1/calls?requestId=${requestId.toUpperCase()}`)
      ).json(),
      outcome,
    );
    assert.equal((await run({ ...proposed, arguments: {} })).status, 409);
    assert.equal(
      (await get(`/v1/calls?requestId=${requestId}`, slack.access_token))
        .status,
      404,
    );

    const reflected = await (
      await run({
        ...proposed,
        requestId: randomUUID(),
        arguments: { mode: "reflect" },
      })
    ).text();
    assert.equal(reflected.includes(apiKey), false);
    assert.match(reflected, /result_unavailable/);

    const largeId = randomUUID();
    const prefix = '{"account":"account-1","result":"';
    const echo = "x".repeat(8191 - prefix.length) + "🦉tail";
    const large = await run({
      ...proposed,
      requestId: largeId,
      arguments: { echo },
    });
    assert.match(await large.text(), /"kind":"paged"/);
    const pageSchema = z.object({
      result: z.object({
        kind: z.literal("page"),
        text: z.string(),
        nextCursor: z.string().nullable(),
      }),
    });
    const page = await get(`/v1/calls?requestId=${largeId}&cursor=0`);
    assert.equal(page.status, 200);
    const firstPage = pageSchema.parse(await page.json()).result;
    assert.equal(firstPage.nextCursor, "8191");
    const secondPage = pageSchema.parse(
      await (
        await get(
          `/v1/calls?requestId=${largeId}&cursor=${firstPage.nextCursor}`,
        )
      ).json(),
    ).result;
    assert.equal(firstPage.text.isWellFormed(), true);
    assert.equal(secondPage.text.isWellFormed(), true);
    assert.equal(secondPage.nextCursor, null);
    assert.deepEqual(JSON.parse(firstPage.text + secondPage.text), {
      account: "account-1",
      result: echo,
    });

    const unknown = await run({
      ...proposed,
      requestId: randomUUID(),
      arguments: { mode: "unknown" },
    });
    assert.match(await unknown.text(), /outcome_unknown/);
    // Kill the serving process after the fixture receives the dispatch, before it responds.
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.onDispatch = async () => {
      entered();
      await held;
    };
    const interrupted = { ...proposed, requestId: randomUUID() };
    const calling = run(interrupted).catch(() => null);
    await dispatched;
    try {
      await service.stop("SIGKILL");
      assert.equal(await calling, null);
    } finally {
      release();
      provider.onDispatch = undefined;
    }
    // Existing databases can contain an uppercase UUID stored before normalization.
    const prior = new DatabaseSync(service.database);
    try {
      prior
        .prepare(
          "UPDATE receipts SET request_id = upper(request_id) WHERE request_id = ?",
        )
        .run(requestId);
    } finally {
      prior.close();
    }
    await service.start();
    assert.deepEqual(await (await run(proposed)).json(), outcome);
    const recovered = await run(interrupted);
    assert.match(await recovered.text(), /dispatch_interrupted/);
    assert.equal(provider.executions.length, 5);
    assert.deepEqual(
      await (await get(`/v1/calls?requestId=${requestId}`)).json(),
      outcome,
    );

    assert.equal(
      (await revoke(service.origin, github.refresh_token)).status,
      200,
    );
    assert.equal((await get("/v1/actions")).status, 401);
    assert.equal((await get("/v1/actions", slack.access_token)).status, 200);
  },
);
