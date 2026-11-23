import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { createServer as tcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { TestContext } from "node:test";
import { z } from "zod";

export const clientId = "oce-test";
export const clientSecret = "secret-for-oce-integration-client-0123456789";
export const apiKey = "project-key-for-integration-fixture";
export const redirectUri = "https://oce.example.test/oauth/callback?existing=1";
export const clientAuth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

const serverLog = "Connections HTTPS service ready.";
const formHeaders = { "content-type": "application/x-www-form-urlencoded" };
const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive().max(300),
  scope: z.literal("connections"),
});
export type Tokens = z.infer<typeof tokens>;

export async function fixture(
  t: TestContext,
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    origin: string,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oce-connections-"));
  const certPath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");
  const errors: unknown[] = [];
  const config = join(directory, "service.json");
  const database = join(directory, "connections.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-days",
      "1",
      "-out",
      certPath,
      "-keyout",
      keyPath,
    ],
    { stdio: "ignore" },
  );
  const tls = { cert: await readFile(certPath), key: await readFile(keyPath) };
  const originalCAs = getCACertificates("default");
  setDefaultCACertificates([...originalCAs, tls.cert.toString()]);
  t.after(() => setDefaultCACertificates(originalCAs));

  const provider = createServer(tls, (req, res) => {
    handle(req, res, backend).catch((error: unknown) => {
      errors.push(error);
      res.writeHead(500).end();
    });
  });
  const backend = `https://127.0.0.1:${await listen(provider)}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      provider.close((error) => (error ? reject(error) : resolve()));
    });
    assert.deepEqual(errors, []);
  });
  const temporary = tcpServer();
  const port = await listen(temporary);
  await new Promise<void>((resolve) => temporary.close(() => resolve()));
  const origin = `https://127.0.0.1:${port}`;
  await writeFile(
    config,
    JSON.stringify({
      origin,
      database,
      listenHost: "127.0.0.1",
      listenPort: port,
      tls: { cert: certPath, key: keyPath },
      composioOrigin: backend,
      oauthClients: [
        {
          id: clientId,
          connectorIds: ["github", "slack"],
          secretEnv: "TEST_OCE_SECRET",
          redirectUris: [redirectUri],
        },
        {
          id: "other-oce",
          connectorIds: ["github"],
          secretEnv: "TEST_OCE_OTHER_SECRET",
          redirectUris: [redirectUri],
        },
      ],
      authConfigIds: { slack: "auth-slack" },
    }),
  );
  const serviceEnv = {
    PATH: process.env.PATH,
    NODE_EXTRA_CA_CERTS: certPath,
    TEST_OCE_SECRET: clientSecret,
    TEST_OCE_OTHER_SECRET: "secret-for-other-oce-client-0123456789",
    COMPOSIO_API_KEY: apiKey,
  };
  const logs: string[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  async function stop(signal: NodeJS.Signals = "SIGTERM") {
    if (child?.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill(signal);
      await exit;
    }
  }
  t.after(() => stop());
  async function start() {
    child = spawn(process.execPath, ["dist/main.js", config], {
      env: serviceEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running = child;
    running.stderr?.on("data", (data: Buffer) => logs.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const earlyExit = () =>
        reject(new Error("HTTPS service exited during startup."));
      running.once("exit", earlyExit);
      running.once("error", reject);
      running.stdout?.on("data", (data: Buffer) => {
        const message = data.toString();
        logs.push(message);
        output += message;
        if (output.includes(serverLog)) {
          running.off("exit", earlyExit);
          resolve();
        }
      });
    });
  }
  await start();
  return { origin, database, certPath, logs, start, stop };
}

async function listen(server: Server | ReturnType<typeof tcpServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address: AddressInfo | string | null = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

export function authorization(origin: string, connector: string) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const url = new URL(`/oauth/authorize/${connector}`, origin);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    state,
    scope: "connections",
  }).toString();
  return { url, verifier, state };
}

export async function startConsent(origin: string, connector: string) {
  const params = authorization(origin, connector);
  const start = await fetch(params.url, { redirect: "manual" });
  assert.equal(start.status, 302);
  const consentUrl = location(start);
  const cookie = start.headers.getSetCookie()[0]?.split(";")[0];
  assert.ok(cookie);
  return { ...params, consentUrl, cookie };
}

export async function consent(url: URL) {
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302);
  return location(response);
}

export async function authorizeCode(origin: string, connector: string) {
  const started = await startConsent(origin, connector);
  const callback = await consent(started.consentUrl);
  const complete = await fetch(callback, {
    headers: { cookie: started.cookie },
    redirect: "manual",
  });
  assert.equal(complete.status, 302, await complete.text());
  const result = location(complete);
  assert.equal(
    result.origin + result.pathname,
    new URL(redirectUri).origin + new URL(redirectUri).pathname,
  );
  assert.equal(result.searchParams.get("existing"), "1");
  assert.equal(result.searchParams.get("state"), started.state);
  const code = result.searchParams.get("code");
  assert.ok(code);
  return { code, verifier: started.verifier };
}

export async function tokenRequest(
  origin: string,
  fields: Record<string, string>,
  authorization: string | null = clientAuth,
) {
  return fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: authorization ? { ...formHeaders, authorization } : formHeaders,
    body: new URLSearchParams(fields),
  });
}

export function codeFields(code: string, verifier: string) {
  return {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  };
}

export async function readTokens(response: Response): Promise<Tokens> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return tokens.parse(await response.json());
}

export function location(response: Response) {
  const location = response.headers.get("location");
  assert.ok(location);
  return new URL(location);
}

export function respond(res: ServerResponse, payload: unknown) {
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(payload));
}

export async function enroll(origin: string, connector: string) {
  const { code, verifier } = await authorizeCode(origin, connector);
  return readTokens(await tokenRequest(origin, codeFields(code, verifier)));
}

export function revoke(
  origin: string,
  token: string,
  authorization = clientAuth,
) {
  return fetch(`${origin}/oauth/revoke`, {
    method: "POST",
    headers: { ...formHeaders, authorization },
    body: new URLSearchParams({ token }),
  });
}
