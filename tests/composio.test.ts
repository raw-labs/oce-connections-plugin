import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposioProvider } from "../src/providers/composio/provider.js";
import {
  ConnectorProviderError,
  type ConnectorProviderBinding,
} from "../src/types/provider.js";

const key = "dedicated-project-secret-for-provider-test";
const binding: ConnectorProviderBinding = {
  accountId: "ca_exact",
  subjectId: "connections_test_user",
  toolkit: "example",
  authConfigurationId: "ac_exact",
};
const signal = () => new AbortController().signal;
const account = (overrides: Record<string, unknown> = {}) => ({
  id: binding.accountId,
  user_id: binding.subjectId,
  toolkit: { slug: binding.toolkit },
  auth_config: { id: binding.authConfigurationId },
  status: "ACTIVE",
  ...overrides,
});
const execution = {
  binding,
  actionId: "EXAMPLE_ACTION",
  version: "20260910_00",
  arguments: { undocumented: null, numberProvidedAsString: "7" },
};

function fixture(responses: (Response | Error)[]) {
  const calls: { url: string; body: unknown; method: string | undefined }[] =
    [];
  const provider = createComposioProvider({
    apiKey: key,
    fetchImpl: (url, init) => {
      assert.ok(init);
      const headers = new Headers(init.headers);
      assert.equal(headers.get("x-api-key"), key);
      assert.equal(init.redirect, "error");
      const body: unknown =
        typeof init.body === "string" ? JSON.parse(init.body) : null;
      calls.push({
        url: url instanceof Request ? url.url : String(url),
        body,
        method: init.method,
      });
      const next = responses.shift();
      assert.ok(next, "Unexpected additional provider request");
      if (next instanceof Error) throw next;
      return Promise.resolve(next);
    },
  });
  return { provider, calls };
}

await test("direct execution preserves opaque arguments and selects the exact account and version without hidden I/O", async () => {
  const { provider, calls } = fixture([
    Response.json({ successful: true, data: { unexpectedOutput: null } }),
  ]);
  const result = await provider.execute(execution, signal());
  assert.deepEqual(result, {
    status: "succeeded",
    result: { kind: "inline", data: { unexpectedOutput: null } },
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "https://backend.composio.dev/api/v3.1/tools/execute/EXAMPLE_ACTION",
  );
  assert.deepEqual(calls[0].body, {
    connected_account_id: binding.accountId,
    user_id: binding.subjectId,
    version: execution.version,
    arguments: execution.arguments,
  });
});

await test("provider rejections preserve useful bounded diagnostics without classifying their prose or disclosing credentials", async () => {
  for (const message of [
    "invalid date: expected YYYY-MM-DD",
    "timeout unavailable error but parameter is required",
  ]) {
    const { provider, calls } = fixture([
      Response.json(
        {
          error: {
            message: `${message}; api_key=${key}; password=hunter2; https://example.test?token=secret`,
          },
        },
        { status: 422 },
      ),
    ]);
    const result = await provider.execute(execution, signal());
    assert.equal(result.status, "rejected");
    assert.equal(result.failure.code, "connector_provider_rejected");
    assert.ok(result.failure.message.includes(message));
    assert.doesNotMatch(
      result.failure.message,
      /hunter2|project-secret|token=secret/,
    );
    assert.equal(calls.length, 1);
  }
  const { provider } = fixture([
    Response.json({
      successful: false,
      error: { message: "Field date is required" },
    }),
  ]);
  const result = await provider.execute(execution, signal());
  assert.ok(result.status === "rejected");
  assert.match(result.failure.message, /Field date is required/);
});

await test("transport loss and malformed post-dispatch results remain unknown and are never replayed", async () => {
  for (const response of [
    new TypeError("socket closed with sensitive token"),
    new Response("not-json"),
    Response.json({ data: {} }),
    Response.json({ error: "upstream broke" }, { status: 503 }),
  ]) {
    const { provider, calls } = fixture([response]);
    const result = await provider.execute(execution, signal());
    assert.equal(result.status, "outcome_unknown");
    assert.equal(result.failure.retry.strategy, "reconcile");
    assert.doesNotMatch(result.failure.message, /sensitive token/);
    assert.equal(calls.length, 1);
  }
});

await test("known provider success survives an unavailable payload; pre-dispatch cancellation makes no request", async () => {
  const { provider, calls } = fixture([Response.json({ successful: true })]);
  assert.deepEqual(await provider.execute(execution, signal()), {
    status: "succeeded",
    result: { kind: "unavailable", reason: "invalid_result" },
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await provider.execute(execution, controller.signal);
  assert.ok(cancelled.status === "rejected");
  assert.equal(cancelled.failure.completion, "not_started");
  assert.equal(calls.length, 1);
});

await test("same-service setup creates distinct hosted accounts with the generic public wire contract", async () => {
  const { provider, calls } = fixture(
    [1, 2].map((id) =>
      Response.json({
        connected_account_id: `ca_${String(id)}`,
        expires_at: "2026-09-10T12:00:00Z",
        redirect_url: `https://connect.example.test/${String(id)}`,
      }),
    ),
  );
  const input = {
    authConfigurationId: binding.authConfigurationId,
    subjectId: binding.subjectId,
  };
  const first = await provider.createSetup(input, signal());
  const second = await provider.createSetup(input, signal());
  assert.notEqual(first.accountId, second.accountId);
  assert.deepEqual(
    calls.map((call) => call.body),
    [1, 2].map(() => ({
      auth_config_id: input.authConfigurationId,
      user_id: input.subjectId,
    })),
  );
});

await test("managed auth lookup reuses only an enabled configuration for the exact toolkit", async () => {
  const managed = {
    id: "managed",
    toolkit: { slug: "example" },
    is_composio_managed: true,
    status: "ENABLED",
  };
  const found = fixture([
    Response.json({
      items: [
        { ...managed, id: "custom", is_composio_managed: false },
        { ...managed, id: "disabled", status: "DISABLED" },
        { ...managed, id: "foreign", toolkit: { slug: "another" } },
      ],
      next_cursor: "next",
    }),
    Response.json({ items: [managed], next_cursor: null }),
  ]);
  assert.equal(
    await found.provider.resolveManagedAuthConfiguration("example", signal()),
    "managed",
  );
  assert.ok(found.calls[1]);
  assert.equal(new URL(found.calls[1].url).searchParams.get("cursor"), "next");

  const created = fixture([
    Response.json({ items: [] }),
    Response.json({ auth_config: { ...managed, status: undefined } }),
    Response.json({ items: [managed] }),
  ]);
  assert.equal(
    await created.provider.resolveManagedAuthConfiguration("example", signal()),
    "managed",
  );
  assert.deepEqual(created.calls[1]?.body, { toolkit: { slug: "example" } });
  assert.equal(created.calls[2]?.method, "GET");
});

await test("inspection rejects any mismatched account binding", async () => {
  for (const mismatch of [
    { user_id: "foreign_user" },
    { id: "foreign_account" },
    { auth_config: { id: "foreign_config" } },
    { toolkit: { slug: "foreign_toolkit" } },
  ]) {
    const { provider, calls } = fixture([Response.json(account(mismatch))]);
    await assert.rejects(
      provider.inspectAccount(binding, signal()),
      (error: unknown) =>
        error instanceof ConnectorProviderError &&
        error.code === "connector_account_mismatch",
    );
    assert.equal(calls.length, 1);
  }
  const { provider } = fixture([Response.json(account())]);
  assert.deepEqual(await provider.inspectAccount(binding, signal()), {
    binding,
    state: "active",
  });
});

await test("malformed account disablement cannot be interpreted as active", async () => {
  const { provider } = fixture([
    Response.json(account({ is_disabled: "true" })),
  ]);
  await assert.rejects(
    provider.inspectAccount(binding, signal()),
    (error: unknown) =>
      error instanceof ConnectorProviderError &&
      error.code === "connector_provider_invalid_response",
  );
});
