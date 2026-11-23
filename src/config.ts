import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !/[\\#\s]/.test(value)
  );
});

const fileSchema = z.strictObject({
  origin: httpsUrl.refine((value) => new URL(value).origin === value),
  listenHost: z.string().min(1).default("0.0.0.0"),
  listenPort: z.number().int().min(1).max(65535).default(8443),
  database: z.string().min(1),
  tls: z.strictObject({ cert: z.string().min(1), key: z.string().min(1) }),
  oauthClients: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9._~-]{1,256}$/),
        secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        redirectUris: z
          .array(
            httpsUrl.refine((value) => {
              const params = new URL(value).searchParams;
              return !["code", "state", "error"].some((key) => params.has(key));
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  authConfigIds: z.record(z.string(), z.string().min(1).max(256)).default({}),
  composioOrigin: httpsUrl
    .refine((value) => new URL(value).origin === value)
    .default("https://backend.composio.dev"),
});

export function loadConfig(file: string, env: NodeJS.ProcessEnv) {
  const parsed = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (
    new Set(parsed.oauthClients.map(({ id }) => id)).size !==
    parsed.oauthClients.length
  )
    throw new Error("Duplicate OAuth client IDs.");
  const oauthClients = parsed.oauthClients.map(
    ({ id, redirectUris, secretEnv }) => {
      const secret = env[secretEnv];
      if (!secret || !/^[\x21-\x7e]{32,2048}$/.test(secret))
        throw new Error("Missing or invalid OAuth client secret.");
      return { id, redirectUris, secret };
    },
  );
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey || !/^[\x21-\x7e]+$/.test(apiKey))
    throw new Error("Missing or invalid Composio project credential.");
  return {
    ...parsed,
    database: resolve(parsed.database),
    tls: {
      cert: readFileSync(parsed.tls.cert),
      key: readFileSync(parsed.tls.key),
    },
    oauthClients,
    apiKey,
  };
}
