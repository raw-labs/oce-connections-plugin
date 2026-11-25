import assert from "node:assert/strict";
import { test } from "node:test";
import { ComposioFixture } from "./helpers/composio.js";
import {
  apiKey,
  authorization,
  authorizeCode,
  clientId,
  clientSecret,
  codeFields,
  consent,
  fixture,
  location,
  readTokens,
  startConsent,
  tokenRequest,
} from "./helpers/https.js";

await test(
  "HTTPS OAuth requires the exact redirect, browser ticket, provider session, active binding, S256 and a confidential client",
  { timeout: 20_000 },
  async (t) => {
    const provider = new ComposioFixture();
    const { origin, logs } = await fixture(t, provider.handle);

    const metadata = await fetch(
      origin + "/.well-known/oauth-authorization-server",
    );
    assert.equal(metadata.status, 200);
    assert.match(
      metadata.headers.get("content-type") ?? "",
      /^application\/json/,
    );
    assert.deepEqual(await metadata.json(), {
      issuer: origin,
      authorization_endpoint: origin + "/oauth/authorize",
      token_endpoint: origin + "/oauth/token",
      revocation_endpoint: origin + "/oauth/revoke",
      scopes_supported: ["connections"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
      revocation_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
    });

    const badRedirect = authorization(origin, "github").url;
    badRedirect.searchParams.set(
      "redirect_uri",
      "https://oce.example.test/oauth/callback",
    );
    const refused = await fetch(badRedirect, { redirect: "manual" });
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.has("location"), false);

    const plain = authorization(origin, "github").url;
    plain.searchParams.set("code_challenge_method", "plain");
    assert.equal((await fetch(plain)).status, 400);
    const wrongClient = authorization(origin, "slack").url;
    wrongClient.searchParams.set("client_id", "other-oce");
    assert.equal((await fetch(wrongClient)).status, 400);
    assert.equal(provider.accounts.size, 0);

    const started = await startConsent(origin, "github");
    const account = [...provider.accounts.values()][0];
    assert.ok(account);
    const browser = { cookie: started.cookie };
    const legacy = new URL("/oauth/complete", origin);
    legacy.searchParams.set("connected_account_id", account.id);
    account.status = "ACTIVE";
    const unverified = await fetch(legacy, { headers: browser });
    assert.equal(unverified.status, 400);
    assert.deepEqual(await unverified.json(), {
      error: "provider_session_required",
    });
    account.status = "INITIATED";

    const callback = await consent(started.consentUrl);
    assert.equal((await fetch(callback)).status, 403);
    assert.equal(account.status, "INITIATED");

    const otherBrowser = await startConsent(origin, "github");
    assert.equal(
      (
        await fetch(callback, {
          headers: { cookie: otherBrowser.cookie },
        })
      ).status,
      502,
    );
    assert.equal(account.status, "FAILED");
    assert.equal((await fetch(callback, { headers: browser })).status, 502);

    const otherAccount = [...provider.accounts.values()][1];
    assert.ok(otherAccount);
    otherAccount.auth_config.id = "another-config";
    const otherCallback = await consent(otherBrowser.consentUrl);
    assert.equal(
      (
        await fetch(otherCallback, {
          headers: { cookie: otherBrowser.cookie },
        })
      ).status,
      502,
    );

    const issued = await authorizeCode(origin, "github");
    const fields = codeFields(issued.code, issued.verifier);
    const unauthenticated = await tokenRequest(
      origin,
      { ...fields, client_id: clientId },
      null,
    );
    assert.equal(unauthenticated.status, 401);
    const other = Buffer.from(
      "other-oce:secret-for-other-oce-client-0123456789",
    ).toString("base64");
    assert.equal(
      (await tokenRequest(origin, fields, `Basic ${other}`)).status,
      400,
    );
    const result = await readTokens(await tokenRequest(origin, fields));
    assert.equal((await tokenRequest(origin, fields)).status, 400);

    const wrongPkce = await authorizeCode(origin, "slack");
    const wrongVerifier = "A".repeat(43);
    assert.equal(
      (await tokenRequest(origin, codeFields(wrongPkce.code, wrongVerifier)))
        .status,
      400,
    );
    assert.equal(
      (
        await tokenRequest(
          origin,
          codeFields(wrongPkce.code, wrongPkce.verifier),
        )
      ).status,
      400,
    );

    const wrongExchangeRedirect = await authorizeCode(origin, "slack");
    assert.equal(
      (
        await tokenRequest(origin, {
          ...codeFields(
            wrongExchangeRedirect.code,
            wrongExchangeRedirect.verifier,
          ),
          redirect_uri: "https://oce.example.test/oauth/callback",
        })
      ).status,
      400,
    );

    const refresh = {
      grant_type: "refresh_token",
      refresh_token: result.refresh_token,
    };
    assert.equal(
      (await tokenRequest(origin, refresh, `Basic ${other}`)).status,
      400,
    );
    const next = await readTokens(
      await tokenRequest(
        origin,
        {
          ...refresh,
          client_id: clientId,
          client_secret: clientSecret,
        },
        null,
      ),
    );
    assert.equal((await tokenRequest(origin, refresh)).status, 400);
    for (const value of [
      apiKey,
      clientSecret,
      result.access_token,
      result.refresh_token,
      next.access_token,
      next.refresh_token,
      callback.searchParams.get("session_uri"),
    ])
      if (value) assert.equal(logs.join("").includes(value), false);
  },
);

await test(
  "public OAuth limits pending enrollments and simultaneous verification of the same enrollment",
  { timeout: 20_000 },
  async (t) => {
    const provider = new ComposioFixture();
    const verifying = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const { origin } = await fixture(t, async (req, res, backend, issuer) => {
      if (req.url === "/api/v3.1/connected_accounts/complete_auth") {
        verifying.resolve();
        await resume.promise;
      }
      await provider.handle(req, res, backend, issuer);
    });
    const first = await startConsent(origin, "slack");
    await Promise.all(
      Array.from({ length: 31 }, () => startConsent(origin, "slack")),
    );
    assert.equal(provider.accounts.size, 32);
    const extra = authorization(origin, "slack");
    const refused = await fetch(extra.url, { redirect: "manual" });
    assert.equal(refused.status, 302);
    assert.equal(refused.headers.has("set-cookie"), false);
    assert.equal(
      location(refused).searchParams.get("error"),
      "temporarily_unavailable",
    );
    assert.equal(location(refused).searchParams.get("state"), extra.state);
    assert.equal(provider.accounts.size, 32);

    const callback = await consent(first.consentUrl);
    const options: RequestInit = {
      headers: { cookie: first.cookie },
      redirect: "manual",
    };
    const completing = fetch(callback, options);
    await verifying.promise;
    try {
      const concurrent = await fetch(callback, {
        ...options,
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(concurrent.status, 409);
      assert.deepEqual(await concurrent.json(), {
        error: "enrollment_in_progress",
      });
    } finally {
      resume.resolve();
    }
    assert.ok(location(await completing).searchParams.get("code"));
    await startConsent(origin, "slack");
    assert.equal(provider.accounts.size, 33);
  },
);
