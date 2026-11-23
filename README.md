# OCE Connections

This repository is the successor to [OpenClaw Connections](https://github.com/raw-labs/openclaw-connections). It retains the Composio adapter and connector catalog. OCE owns saved connections and agent grants. The service runs HTTPS and registers OCE as a confidential OAuth client with exact redirect URIs. It exchanges S256-protected codes for five-minute access tokens and rotating refresh tokens.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm inspect:package
```

See [RELEASING.md](RELEASING.md) for distribution and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for provenance.
