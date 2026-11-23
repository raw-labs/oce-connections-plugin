#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { connectionsServer } from "./server.js";

try {
  process.umask(0o077);
  const file = process.argv[2];
  if (!file || process.argv.length !== 3)
    throw new Error("A configuration file is required.");
  const config = loadConfig(file, process.env);
  const server = connectionsServer({
    ...config,
    composio: { apiKey: config.apiKey, apiBaseUrl: config.composioOrigin },
  });
  server.once("error", () => {
    process.stderr.write("Connections failed to listen.\n");
    process.exitCode = 1;
    server.close();
  });
  server.listen(config.listenPort, config.listenHost, () => {
    process.stdout.write("Connections HTTPS service ready.\n");
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => server.close());
  });
} catch {
  process.stderr.write(
    "Connections startup failed. Check the configuration, credentials, TLS files and database.\n",
  );
  process.exitCode = 1;
}
