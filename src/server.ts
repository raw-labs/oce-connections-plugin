import { createServer, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ComposioCatalog, packagedCatalog } from "./catalog.js";
import { HttpError, send } from "./http.js";
import { ConnectionsOAuth, type ClientRegistration } from "./oauth.js";
import {
  ComposioHttp,
  type ComposioHttpOptions,
} from "./providers/composio/http.js";
import { createComposioProvider } from "./providers/composio/provider.js";
import { Queue } from "./queue.js";
import { Store } from "./store.js";
import { ConnectorProviderError } from "./types/provider.js";

export function connectionsServer(options: {
  tls: ServerOptions;
  origin: string;
  database: string;
  oauthClients: ClientRegistration[];
  composio: ComposioHttpOptions;
  authConfigIds: Record<string, string>;
}) {
  const catalog = new ComposioCatalog(
    packagedCatalog(),
    new ComposioHttp(options.composio),
  );
  const provider = createComposioProvider(options.composio);
  const queue = new Queue();
  const store = new Store(options.database);
  const oauth = new ConnectionsOAuth(
    options.oauthClients,
    options.origin,
    store,
    queue,
    catalog,
    provider,
    options.authConfigIds,
  );
  const server = createServer(
    { ...options.tls, minVersion: "TLSv1.2" },
    (request, response) => {
      void handle(request, response);
    },
  );
  server.once("close", () => store.close());

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("pragma", "no-cache");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    try {
      if (
        request.headersDistinct.authorization?.length &&
        request.headersDistinct.authorization.length !== 1
      )
        throw new HttpError(400, "invalid_request");
      const target = request.url ?? "";
      if (
        !target.startsWith("/") ||
        target.startsWith("//") ||
        /[\\#]/.test(target)
      )
        throw new HttpError(400, "invalid_request");
      const url = new URL(target, options.origin);
      const method = request.method;
      if (method === "GET") {
        if (url.pathname === "/healthz" && !url.search) {
          send(response, 200, { status: "ok" });
          return;
        }
        const connector = /^\/oauth\/authorize\/([a-z0-9_]{1,80})$/.exec(
          url.pathname,
        )?.[1];
        if (connector) {
          await oauth.authorize(connector, url, response);
          return;
        }
        const enrollment = /^\/oauth\/complete\/([a-f0-9-]{36})$/.exec(
          url.pathname,
        )?.[1];
        if (enrollment) {
          await oauth.complete(enrollment, request, response);
          return;
        }
      }
      if (method === "POST" && !url.search) {
        if (url.pathname === "/oauth/token") {
          await oauth.exchange(request, response);
          return;
        }
        if (url.pathname === "/oauth/revoke") {
          await oauth.revoke(request, response);
          return;
        }
      }
      throw new HttpError(404, "not_found");
    } catch (error) {
      if (error instanceof HttpError) {
        if (
          error.code === "invalid_client" &&
          error.status === 401 &&
          request.headers.authorization
        )
          response.setHeader("www-authenticate", 'Basic realm="Connections"');
        send(response, error.status, { error: error.code });
      } else if (error instanceof ConnectorProviderError) {
        send(response, 502, { error: "provider_unavailable" });
      } else {
        // Exceptions can include upstream payloads or credentials. Only log a fixed event.
        process.stderr.write("Connections request failed.\n");
        send(response, 500, { error: "server_error" });
      }
    }
  }
  return server;
}
