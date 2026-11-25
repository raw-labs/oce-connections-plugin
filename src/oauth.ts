import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import OAuth2Server from "@node-oauth/oauth2-server";
import { z } from "zod";
import oauthProtocol from "../assets/oauth.json" with { type: "json" };
import type { ComposioCatalog } from "./catalog.js";
import { body, HttpError, parameters, redirect, send } from "./http.js";
import type { Queue } from "./queue.js";
import {
  authorizationSchema,
  digest,
  grantSchema,
  type Store,
} from "./store.js";
import type { ConnectorProvider } from "./types/provider.js";

export interface ClientRegistration {
  id: string;
  secret: string;
  redirectUris: string[];
  connectorIds: string[];
}
const { scope } = oauthProtocol;
const lifetime = 10 * 60;
const browserCookieName = "__Host-connections-enrollment";
const callbackQuery = z.strictObject({
  session_uri: z.string().regex(/^[\x21-\x7e]{1,4096}$/),
});
const oauthCredential = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const clientFields = {
  client_id: z.string().max(256).optional(),
  client_secret: z.string().max(2048).optional(),
};
const tokenRequest = z.discriminatedUnion("grant_type", [
  z.strictObject({
    ...clientFields,
    grant_type: z.literal("authorization_code"),
    code: oauthCredential,
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    redirect_uri: z.string().max(2048),
  }),
  z.strictObject({
    ...clientFields,
    grant_type: z.literal("refresh_token"),
    refresh_token: oauthCredential,
    scope: z.literal(scope).optional(),
  }),
]);
const revokeRequest = z.strictObject({
  ...clientFields,
  token: z.string().min(1).max(2048),
  token_type_hint: z.string().max(80).optional(),
});
const userSchema = z.object({ grantId: z.uuid() });
const enrollmentUserSchema = userSchema.extend({
  ticketHash: z.string(),
  grant: grantSchema,
});

export class ConnectionsOAuth {
  readonly #clients = new Map<string, ClientRegistration>();
  readonly #verifying = new Set<string>();
  readonly #server: OAuth2Server;

  constructor(
    clients: ClientRegistration[],
    private readonly store: Store,
    private readonly queue: Queue,
    private readonly catalog: ComposioCatalog,
    private readonly provider: ConnectorProvider,
    private readonly authConfigIds: Record<string, string>,
  ) {
    for (const client of clients) {
      if (
        client.connectorIds.some(
          (id) => !catalog.connectors.some((item) => item.id === id),
        )
      )
        throw new Error("Unknown connector in OAuth client registration.");
      this.#clients.set(client.id, client);
    }
    const model: OAuth2Server.AuthorizationCodeModel &
      OAuth2Server.RefreshTokenModel = {
      getClient: async (id, secret) => {
        // The library passes null only for the browser authorize handler.
        // Token and revocation requests authenticate before calling the library.
        return secret === null || (secret && this.authenticated(id, secret))
          ? this.client(id)
          : false;
      },
      validateScope: async () => [scope],
      validateRedirectUri: async (uri, client) =>
        this.#clients.get(client.id)?.redirectUris.includes(uri) === true,
      saveAuthorizationCode: async (code, client, user) => {
        const { grant, ticketHash } = enrollmentUserSchema.parse(user);
        if (
          code.codeChallengeMethod !== "S256" ||
          !code.codeChallenge ||
          !store.saveCode(grant, ticketHash, code.authorizationCode, {
            expiresAt: code.expiresAt.getTime(),
            redirectUri: code.redirectUri,
            challenge: code.codeChallenge,
          })
        )
          return false;
        return { ...code, client, user };
      },
      getAuthorizationCode: async (value) => {
        const code = store.code(value);
        const client =
          code &&
          this.enabledGrant(code.grantId, code.clientId) &&
          this.client(code.clientId);
        return code && client
          ? {
              authorizationCode: value,
              expiresAt: new Date(code.expiresAt),
              redirectUri: code.redirectUri,
              codeChallenge: code.challenge,
              codeChallengeMethod: "S256",
              scope: [scope],
              client,
              user: { grantId: code.grantId },
            }
          : false;
      },
      revokeAuthorizationCode: async (code) =>
        store.consumeCode(code.authorizationCode),
      saveToken: async (token, client, user) => {
        const { grantId } = userSchema.parse(user);
        if (
          typeof token.accessToken !== "string" ||
          !(token.accessTokenExpiresAt instanceof Date) ||
          typeof token.refreshToken !== "string" ||
          !(token.refreshTokenExpiresAt instanceof Date) ||
          !this.enabledGrant(grantId, client.id) ||
          !store.saveTokens(
            grantId,
            client.id,
            token.accessToken,
            token.accessTokenExpiresAt.getTime(),
            token.refreshToken,
            token.refreshTokenExpiresAt.getTime(),
          )
        )
          return false;
        return { ...token, accessToken: token.accessToken, client, user };
      },
      verifyScope: async (token, requested) =>
        requested.every((item) => token.scope?.includes(item)),
      getAccessToken: async (value) => {
        const token = store.credential("access", value);
        const client =
          token &&
          this.enabledGrant(token.grantId, token.clientId) &&
          this.client(token.clientId);
        return token && client
          ? {
              accessToken: value,
              accessTokenExpiresAt: new Date(token.expiresAt),
              scope: [scope],
              client,
              user: { grantId: token.grantId },
            }
          : false;
      },
      getRefreshToken: async (value) => {
        const token = store.credential("refresh", value);
        const client =
          token &&
          this.enabledGrant(token.grantId, token.clientId) &&
          this.client(token.clientId);
        return token && client
          ? {
              refreshToken: value,
              refreshTokenExpiresAt: new Date(token.expiresAt),
              scope: [scope],
              client,
              user: { grantId: token.grantId },
            }
          : false;
      },
      revokeToken: async (token) => store.consumeRefresh(token.refreshToken),
    };
    this.#server = new OAuth2Server({
      model,
      accessTokenLifetime: 300,
      refreshTokenLifetime: 30 * 86400,
      alwaysIssueNewRefreshToken: true,
    });
  }

  private enabledGrant(id: string, clientId: string) {
    const grant = this.store.grant(id, clientId);
    if (
      grant &&
      this.#clients.get(clientId)?.connectorIds.includes(grant.connectorId)
    )
      return grant;
  }

  private client(id: string): OAuth2Server.Client | undefined {
    const registration = this.#clients.get(id);
    if (registration)
      return {
        id,
        redirectUris: registration.redirectUris,
        grants: ["authorization_code", "refresh_token"],
      };
  }

  private authenticated(id: string, secret: string): boolean {
    const registration = this.#clients.get(id);
    return (
      registration !== undefined &&
      timingSafeEqual(
        Buffer.from(digest(secret), "hex"),
        Buffer.from(digest(registration.secret), "hex"),
      )
    );
  }

  private authenticateClient(
    request: IncomingMessage,
    values: {
      client_id?: string | undefined;
      client_secret?: string | undefined;
    },
  ) {
    let id = values.client_id;
    let secret = values.client_secret;
    const basic = request.headers.authorization;
    if (basic !== undefined) {
      if (id !== undefined || secret !== undefined)
        throw new HttpError(400, "invalid_request");
      const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(basic)?.[1];
      if (match) {
        const decoded = Buffer.from(match, "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator > 0) {
          try {
            id = decodeFormComponent(decoded.slice(0, separator));
            secret = decodeFormComponent(decoded.slice(separator + 1));
          } catch {
            throw new HttpError(401, "invalid_client");
          }
        }
      }
    }
    if (!id || !secret || !this.authenticated(id, secret))
      throw new HttpError(401, "invalid_client");
    return { client_id: id, client_secret: secret };
  }

  async authorize(url: URL, response: ServerResponse) {
    const { connector: connectorId, ...query } = parameters(url.searchParams);
    const input = authorizationSchema.safeParse(query);
    if (
      !connectorId ||
      !/^[a-z0-9_]{1,80}$/.test(connectorId) ||
      !input.success
    )
      throw new HttpError(400, "invalid_request");
    const request = input.data;
    const client = this.#clients.get(request.client_id);
    if (!client?.redirectUris.includes(request.redirect_uri))
      throw new HttpError(400, "invalid_client");
    if (!client.connectorIds.includes(connectorId))
      throw new HttpError(400, "unauthorized_client");
    const connector = this.catalog.connectors.find(
      ({ id }) => id === connectorId,
    );
    if (!connector) throw new HttpError(404, "unknown_connector");

    const id = randomUUID();
    const subjectId = `oce_connections_${id}`;
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + lifetime * 1000;
    if (
      !this.store.startEnrollment(id, {
        request,
        connectorId,
        expiresAt,
        ticketHash: digest(ticket),
      })
    ) {
      redirect(response, oauthFailure(request, "temporarily_unavailable"));
      return;
    }
    const signal = AbortSignal.timeout(45_000);
    const configuredId = Object.hasOwn(this.authConfigIds, connectorId)
      ? this.authConfigIds[connectorId]
      : undefined;
    try {
      if (!configuredId && connector.auth.kind === "custom")
        throw new HttpError(503, "connector_unconfigured");
      const authConfigurationId =
        configuredId ??
        (await this.queue.run(`toolkit:${connector.toolkitSlug}`, () =>
          this.provider.resolveManagedAuthConfiguration(
            connector.toolkitSlug,
            signal,
          ),
        ));
      const setup = await this.provider.createSetup(
        { authConfigurationId, subjectId },
        signal,
      );
      this.store.setEnrollmentBinding(
        id,
        {
          accountId: setup.accountId,
          subjectId,
          toolkit: connector.toolkitSlug,
          authConfigurationId,
        },
        Date.parse(setup.expiresAt),
      );
      response.setHeader("set-cookie", enrollmentCookie(`${id}.${ticket}`));
      redirect(response, setup.connectUrl);
    } catch {
      redirect(response, oauthFailure(request, "temporarily_unavailable"));
    }
  }

  async complete(url: URL, req: IncomingMessage, res: ServerResponse) {
    const browser = req.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${browserCookieName}=`))
      ?.slice(browserCookieName.length + 1);
    const [, id, ticket] =
      /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(browser ?? "") ?? [];
    if (!id || !ticket) throw new HttpError(403, "enrollment_browser_required");
    const callback = callbackQuery.safeParse(parameters(url.searchParams));
    if (!callback.success)
      throw new HttpError(400, "provider_session_required");
    const pending = this.store.enrollment(id, ticket);
    if (!pending?.binding) throw new HttpError(409, "enrollment_unavailable");
    if (this.#verifying.has(id))
      throw new HttpError(409, "enrollment_in_progress");
    this.#verifying.add(id);
    try {
      const { binding, connectorId, request, ticketHash } = pending;
      const client = this.#clients.get(request.client_id);
      if (
        !client?.redirectUris.includes(request.redirect_uri) ||
        !client.connectorIds.includes(connectorId)
      )
        throw new HttpError(400, "unauthorized_client");
      // Composio activates only the session whose subject matches this browser's enrollment.
      const signal = AbortSignal.timeout(45_000);
      await this.provider.completeSetup(
        binding,
        callback.data.session_uri,
        signal,
      );
      res.setHeader("set-cookie", enrollmentCookie(""));
      const account = await this.provider.inspectAccount(binding, signal);
      if (account?.state !== "active") {
        redirect(res, oauthFailure(request, "access_denied"));
        return;
      }

      const result = new OAuth2Server.Response();
      await this.#server.authorize(
        new OAuth2Server.Request({
          method: "GET",
          headers: {},
          query: request,
        }),
        result,
        {
          requirePKCE: true,
          authorizationCodeLifetime: 120,
          authenticateHandler: {
            handle: () => ({
              grantId: id,
              ticketHash,
              grant: { id, clientId: request.client_id, connectorId, binding },
            }),
          },
        },
      );
      const location = result.get("location");
      if (typeof location !== "string")
        throw new HttpError(500, "server_error");
      redirect(res, location);
    } finally {
      this.#verifying.delete(id);
    }
  }

  async exchange(request: IncomingMessage, response: ServerResponse) {
    const fields = await form(request);
    if (
      fields.grant_type !== "authorization_code" &&
      fields.grant_type !== "refresh_token"
    )
      throw new HttpError(
        400,
        fields.grant_type ? "unsupported_grant_type" : "invalid_request",
      );
    const input = tokenRequest.safeParse(fields);
    if (!input.success) throw new HttpError(400, "invalid_request");
    const credentials = this.authenticateClient(request, input.data);
    const result = new OAuth2Server.Response();
    try {
      await this.#server.token(
        new OAuth2Server.Request({
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(
              new URLSearchParams(fields).toString().length,
            ),
          },
          query: {},
          body: { ...input.data, ...credentials },
        }),
        result,
        { requirePKCE: true },
      );
    } catch (error) {
      if (
        error instanceof OAuth2Server.InvalidGrantError ||
        error instanceof OAuth2Server.InvalidRequestError
      )
        throw new HttpError(400, error.name);
      throw error;
    }
    send(response, 200, result.body);
  }

  async revoke(request: IncomingMessage, response: ServerResponse) {
    const input = revokeRequest.safeParse(await form(request));
    if (!input.success) throw new HttpError(400, "invalid_request");
    const { client_id } = this.authenticateClient(request, input.data);
    const id = this.store.revocationTarget(client_id, input.data.token);
    if (id) this.store.revokeGrant(id, client_id);
    send(response, 200);
  }

  async access(header: string | undefined) {
    if (!/^Bearer [A-Za-z0-9_-]{1,256}$/i.test(header ?? ""))
      throw new HttpError(401, "invalid_token");
    try {
      const token = await this.#server.authenticate(
        new OAuth2Server.Request({
          method: "GET",
          headers: { authorization: header },
          query: {},
        }),
        new OAuth2Server.Response(),
        { scope: [scope] },
      );
      const { grantId } = userSchema.parse(token.user);
      const grant = this.enabledGrant(grantId, token.client.id);
      if (grant) return grant;
    } catch (error) {
      if (!(error instanceof OAuth2Server.InvalidTokenError)) throw error;
    }
    throw new HttpError(401, "invalid_token");
  }
}

async function form(request: IncomingMessage) {
  return parameters(
    new URLSearchParams(
      await body(request, "application/x-www-form-urlencoded", 16 * 1024),
    ),
  );
}

function decodeFormComponent(value: string) {
  return decodeURIComponent(value.replaceAll("+", " "));
}

function enrollmentCookie(value: string) {
  return `${browserCookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${value ? lifetime : 0}`;
}

function oauthFailure(
  request: { redirect_uri: string; state: string },
  code: string,
) {
  const location = new URL(request.redirect_uri);
  location.searchParams.set("error", code);
  location.searchParams.set("state", request.state);
  return location.href;
}
