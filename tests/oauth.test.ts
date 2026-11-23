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
  readTokens,
  startConsent,
  tokenRequest,
} from "./helpers/https.js";

await test(
  "HTTPS OAuth requires the exact redirect, browser ticket, active binding, S256 and a confidential client",
  { timeout: 20_000 },
  async (t) => {
    const provider = new ComposioFixture();
    const { origin, logs } = await fixture(t, provider.handle);

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
    const pending = await fetch(account.callback, { headers: browser });
    assert.equal(pending.status, 409);
    const callback = await consent(started.consentUrl);
    assert.equal((await fetch(callback)).status, 403);

    const originalUser = account.user_id;
    account.user_id = "another-oce-subject";
    assert.equal((await fetch(callback, { headers: browser })).status, 502);
    account.user_id = originalUser;

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
    ])
      assert.equal(logs.join("").includes(value), false);
  },
);
