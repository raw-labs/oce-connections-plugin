import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { apiKey, respond } from "./https.js";

const setupRequest = z.strictObject({
  auth_config_id: z.string(),
  user_id: z.string(),
  callback_url: z.url(),
});

export class ComposioFixture {
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
