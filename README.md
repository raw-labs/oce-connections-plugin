# OCE Connections

OCE Connections is the OCE-native successor to [OpenClaw Connections](https://github.com/raw-labs/openclaw-connections).
It provides a standalone HTTPS service, the `oce-connections` CLI, and an
OpenClaw skill. OCE owns the saved connections and Agent grants. This service
owns the binding to the exact Composio account. Composio holds the downstream
credential and runs the actions.

An OCE user chooses a connection template, completes Composio-hosted consent
in the same browser, and grants the saved connection to an Agent in OCE. Each
enrollment has its own Composio subject and account. To give one Agent access to
two accounts on the same provider, assign each account to its own configured
plugin slot. Both slots use the same CLI and skill.

## Build and test

Use Node.js 24.16 or later, pnpm 10.33.0, the Go patch pinned in
[`go.mod`](go.mod), and OpenSSL for the test certificate.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm inspect:package
```

`pnpm test` starts the built HTTPS service in child processes, drives its real
OAuth endpoints with a test client, and runs the native CLI. The controlled
Composio backend provides two GitHub accounts and a Slack account. The suite
checks exact account binding, unauthorized actions and overrides, refresh and
revocation, credential handling, and restart and interrupted-dispatch recovery.
It also builds Linux ARM64 and AMD64 dev overlays and checks the generated
request selectors and OAuth settings. The tests need permission to listen on
loopback. They use temporary databases and a test CA, with ordinary HTTPS
verification enabled.

## Run the HTTPS service

From the checkout, after building:

```sh
mkdir -p .local/tls
cp dev/service.example.json .local/service.json
# Set the HTTPS origin, certificate paths and exact OCE callback URIs.
# Supply COMPOSIO_API_KEY and the registered client secrets from your secret store.
node dist/main.js .local/service.json
```

- The service binds to the configured host and port and serves TLS itself.
  The public `origin` is the canonical OAuth issuer and Composio callback
  origin. If using the sample OCE slot aliases, route each HTTPS origin to the
  service and cover the issuer and each alias with valid TLS certificates.
- Use a dedicated Composio project. Set its **Callback identity verification**
  URL to `https://YOUR_CONNECTIONS_ISSUER/oauth/complete`. Composio requires
  a public HTTPS URL for this project setting. The local test backend supplies
  the same callback contract over loopback. [Composio callback verification](https://docs.composio.dev/reference/api-reference/connected-accounts#callback-identity-verification)
- Set `COMPOSIO_API_KEY` only in the service environment. For each confidential
  OAuth client, list its permitted `connectorIds`, full redirect URIs and the
  environment variable that supplies its distinct secret. Use a random secret
  of at least 32 printable characters. Register the redirect URI shown by OCE,
  including any path or query. The service supports `client_secret_basic` and
  `client_secret_post`.
- The service uses the [fork's catalog](assets/catalog.json). Composio-managed
  connectors reuse a matching enabled auth configuration or create one through
  Composio. Use `authConfigIds` for existing OAuth auth configurations. New
  enrollments require a Composio configuration that supports OAuth callback
  verification. API-key-only setups cannot complete this flow.
- Store the database on a private, persistent local volume. Run one service
  process per database. Stop it before copying the file for backup. Treat the
  database as sensitive because it holds account references and action results.

The configured HTTPS origin is the issuer. Connections publishes RFC 8414
metadata at `/.well-known/oauth-authorization-server`. Every template uses
`GET /oauth/authorize` and supplies its `connector` separately in OCE
`authorizationParameters`. Connections checks the connector against the
registered client before creating a browser ticket and starting Composio
consent. OCE supplies state and S256 PKCE. The callback needs both the
original browser ticket and Composio's single-use session proof. The service
redeems the proof for the enrolled subject and reads the account server-side.
Only an active account matching the account ID, subject, toolkit and auth
configuration can produce a code. Finish one enrollment at a time in each
browser. An enrollment expires after ten minutes or sooner if Composio's setup
expires. If verification fails after the proof is consumed, start a new
enrollment. A service instance accepts up to 32 pending enrollments and one
verification at a time per enrollment.

`POST /oauth/token` exchanges a two-minute, single-use code for a five-minute
access token and a 30-day rotating refresh token. Code and token values are
stored as hashes. Losing a refresh exchange after consumption can require
reconnecting. `POST /oauth/revoke` revokes the selected saved connection's
token family without affecting another enrollment. Revocation takes effect
immediately. An action already dispatched to the provider may finish. Queued
actions and receipt reads require an active grant. OCE owns detaching an
Agent from a saved connection.
Composio project administration handles deletion of the underlying connected
account, including orphaned or abandoned enrollments.

## Use the CLI

The [Connections skill](skills/connections/SKILL.md) describes the workflow.
In OCE, use `--slot NAME` for the assigned account and let OpenShell resolve
the corresponding environment placeholder on the permitted HTTPS request.

```sh
oce-connections --slot github-work actions --query 'list repositories'
oce-connections --slot github-work describe ACTION
oce-connections --slot github-work run ACTION --version VERSION --request-id UUID < arguments.json
oce-connections --slot github-work receipt UUID
```

For direct development, the built binary is `.local/oce-connections`.
It reads `OCE_CONNECTIONS_URL` and `OCE_CONNECTIONS_TOKEN` by default. For
`--slot github-work`, the variables are `OCE_CONNECTIONS_GITHUB_WORK_URL`
and `OCE_CONNECTIONS_GITHUB_WORK_TOKEN`. Use access tokens from a test OAuth
client. The test suite is a repeatable example of that flow. For a private
test CA, set `OCE_CONNECTIONS_CA_FILE` to its PEM certificate.

The Bearer grant selects the account for search, description, execution and
receipt lookup. Discovery uses the active account's toolkit and excludes
deprecated actions, custom actions and known raw proxy actions. The service
caches the toolkit catalog for five minutes. Run `actions` to populate it.
After expiry or restart, `describe` and new `run` calls return
`catalog_refresh_required` until discovery repopulates it. Unknown actions,
stale versions and invalid call envelopes are rejected before provider I/O.
Downstream provider scopes and resource permissions apply when Composio executes
the action. The service checks the current account binding and exact action
version before constructing the upstream request. It accepts bounded JSON
arguments and treats provider schemas as advisory.

A request UUID is scoped to one grant. Reusing it with the same action,
version and arguments retrieves the prior outcome. Different arguments with
the same UUID are rejected. A receipt is committed before dispatch. If the
service loses a response or is interrupted during dispatch, the outcome
remains `outcome_unknown` and the request is never automatically replayed.
Use `receipt` and reconcile the provider-side outcome before another
mutation. Result data is available for seven days. Large results are paged.
Request IDs and outcomes remain so the service can refuse replays.
An instance accepts up to eight active or queued dispatches per grant and
128 total queued or active operations in the dispatch and auth-config queue.
Excess dispatches return `too_many_pending_requests` before any provider I/O.

## OCE development integration

See the [dev image and registration guide](dev/oce/README.md). The bundle
includes the native Linux CLI, skill, manual OAuth templates, single-slot
plugin registrations, and exact native HTTP request selectors. The dev overlay
installs them into the pinned OCE checkout and builds the worker placeholder
allowlist. The target is a dedicated OpenClaw Harness on Kubernetes with
OpenShell Bearer delivery. The pinned OpenShell path cannot enforce HTTPS
before substitution, so the overlay refuses Connections credential deployment
until a qualified transport is available.

The service starts with a fresh SQLite database. Existing Gateway plugin
state stays in the predecessor and accounts are enrolled again through OCE.
See [packaging and release details](RELEASING.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
