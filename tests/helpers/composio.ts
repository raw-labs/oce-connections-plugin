import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { apiKey, respond } from "./https.js";

const setupRequest = z.strictObject({
  auth_config_id: z.string(),
  user_id: z.string(),
  callback_url: z.url(),
});

const execution = z.strictObject({
  connected_account_id: z.string(),
  user_id: z.string(),
  version: z.literal("20261112_00"),
  arguments: z.object({ mode: z.string().optional() }).loose(),
});

export class ComposioFixture {
  executions: Array<{ action: string; account: string; arguments: unknown }> =
    [];
  onDispatch: (() => Promise<void>) | undefined;

  accounts = new Map<
    string,
    {
      id: string;
      toolkit: { slug: string };
      auth_config: { id: string };
      user_id: string;
      status: string;
      callback: string;
    }
  >();

  handle = async (
    request: IncomingMessage,
    res: ServerResponse,
    origin: string,
  ) => {
    const url = new URL(request.url ?? "", origin);
    const method = request.method;
    if (url.pathname.startsWith("/consent/")) {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["x-api-key"], undefined);
      const account = this.accounts.get(url.pathname.slice("/consent/".length));
      assert.ok(account);
      account.status = "ACTIVE";
      const callback = new URL(account.callback);
      callback.searchParams.set("connected_account_id", account.id);
      res.writeHead(302, { location: callback.href }).end();
      return;
    }
    assert.equal(request.headers["x-api-key"], apiKey);
    assert.equal(request.headers.authorization, undefined);
    if (method === "GET" && url.pathname === "/api/v3.1/auth_configs") {
      const toolkit = url.searchParams.get("toolkit_slug");
      assert.ok(toolkit);
      respond(res, {
        items: [
          {
            id: `auth-${toolkit}`,
            toolkit: { slug: toolkit },
            status: "ENABLED",
            is_composio_managed: true,
          },
        ],
      });
      return;
    }
    if (
      method === "POST" &&
      url.pathname === "/api/v3.1/connected_accounts/link"
    ) {
      const input = setupRequest.parse(await readJson(request));
      const id = `account-${this.accounts.size + 1}`;
      const toolkit = input.auth_config_id.slice("auth-".length);
      this.accounts.set(id, {
        id,
        toolkit: { slug: toolkit },
        auth_config: { id: input.auth_config_id },
        user_id: input.user_id,
        status: "INITIATED",
        callback: input.callback_url,
      });
      respond(res, {
        connected_account_id: id,
        redirect_url: `${origin}/consent/${id}`,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      });
      return;
    }
    if (
      method === "GET" &&
      url.pathname.startsWith("/api/v3.1/connected_accounts/")
    ) {
      const account = this.accounts.get(url.pathname.split("/").pop() ?? "");
      if (!account) {
        res.writeHead(404).end();
        return;
      }
      respond(res, account);
      return;
    }
    if (method === "GET" && url.pathname === "/api/v3.1/tools") {
      const toolkit = url.searchParams.get("toolkit_slug");
      assert.ok(toolkit);
      const tool = {
        toolkit: { slug: toolkit },
        name: "Read account",
        description: "Read account identity.",
        version: "20261112_00",
        input_parameters: { type: "object" },
        output_parameters: { type: "object" },
      };
      respond(res, {
        items: [
          { ...tool, slug: `${toolkit.toUpperCase()}_READ_ACCOUNT` },
          { ...tool, slug: `${toolkit.toUpperCase()}_GET_NAME` },
          { ...tool, slug: "COMPOSIO_PROXY_EXECUTE" },
          { ...tool, slug: `${toolkit.toUpperCase()}_CUSTOM_API_CALL` },
          { ...tool, slug: "proxy" },
          {
            ...tool,
            slug: `${toolkit.toUpperCase()}_OLD`,
            is_deprecated: true,
          },
        ],
      });
      return;
    }
    if (
      method === "POST" &&
      url.pathname.startsWith("/api/v3.1/tools/execute/")
    ) {
      const input = execution.parse(await readJson(request));
      const account = this.accounts.get(input.connected_account_id);
      assert.ok(account);
      assert.equal(input.user_id, account.user_id);
      const action = url.pathname.split("/").pop();
      assert.ok(action);
      assert.match(
        action,
        new RegExp(
          `^${account.toolkit.slug.toUpperCase()}_(?:READ_ACCOUNT|GET_NAME)$`,
        ),
      );
      this.executions.push({
        action,
        account: account.id,
        arguments: input.arguments,
      });
      await this.onDispatch?.();
      if (input.arguments.mode === "unknown") {
        res.destroy();
      } else {
        respond(res, {
          successful: true,
          data: {
            account: account.id,
            result:
              input.arguments.mode === "reflect"
                ? apiKey
                : (input.arguments.echo ?? null),
          },
        });
      }
      return;
    }
    throw new Error(`Unrecognized fixture route: ${method} ${url.pathname}`);
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const buffers: Buffer[] = [];
  for await (const chunk of request) {
    assert.ok(Buffer.isBuffer(chunk));
    buffers.push(chunk);
  }
  return JSON.parse(Buffer.concat(buffers).toString());
}
