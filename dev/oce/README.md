# Connections in OCE dev images

The bundled integration targets Dedicated OpenClaw on Kubernetes with
OpenShell. OCE main supports manual OAuth templates and Credential Client
registration. The dev overlay uses the staged native HTTP credential path
introduced by #7097 and the saved account selection work in #4673. Plugin
upload remains a later distribution path. [OCE #7097](https://github.com/openclaw/openclaw-enterprise/pull/7097)
· [OCE #4673](https://github.com/openclaw/openclaw-enterprise/pull/4673)
· [OCE #4734](https://github.com/openclaw/openclaw-enterprise/pull/4734)
· [OpenClaw #203881](https://github.com/openclaw/openclaw/pull/203881)

## Stage the bundle

Copy [slots.example.json](slots.example.json) and set the HTTPS issuer and
distinct API DNS names. All API names can serve the same Connections process.
Choose one slot for each account an Agent may attach, including multiple
accounts for the same provider. Each slot has its own placeholder and API host.

```sh
pnpm install --frozen-lockfile
pnpm build:oce dev/oce/slots.example.json .local/oce-dev
```

Use an empty output directory. The stage builds both Linux architectures with
the pinned Go toolchain and writes filesystem overlays, managed catalog
packages, manual Connection Templates, and OAuth Credential Client examples.

## Apply the local OCE overlay

Use a clean, disposable checkout of OCE commit
`03f8e1f2c5d6d970e3d24bb25e96aebd475c30ea`. Run this command from the Connections
repository:

```sh
pnpm install:oce .local/oce-dev /absolute/path/to/oce-dev-checkout
```

The installer applies [the pinned dev patch](oce-main.patch), merges the
catalog entries, and registers one reviewed CLI policy per release with OCE's
managed catalog. The controller matches the saved OAuth Source to its
original template version, connector, issuer, scope and exact slot host.
Its deployment description registers the executable and four exact HTTPS API
method/path pairs with the staged native policy. The runtime recipe installs
the same CLI and skill in the image, and applies a worker environment patch
that forwards only the bundled slots' OpenShell placeholders. It accepts
the native Source alias that OCE validates during Harness launch.

With the patched checkout's dependencies installed, verify its controller
registration from the Connections repository:

```sh
node dev/oce/verify-overlay.mjs .local/oce-dev /absolute/path/to/oce-dev-checkout
```

Build the Controller and runtime from that patched checkout using OCE's dev
image build. Use the patched runtime image for the Gateway and Dedicated
Harness. The executable lives at
`/usr/local/lib/oce/plugins/connections/bin/oce-connections` and is linked
on `PATH`. The Gateway loads the skill from its managed plugin catalog.
The CLI uses the fixed slot URLs in `/etc/oce-connections/slots.json` and
the OpenShell trust bundle.

For a CLI and image layout smoke test, the [overlay Dockerfile](Dockerfile)
can also layer the stage onto an existing runtime image:

```sh
docker buildx build --load --platform linux/arm64 \
  --build-context connections-overlay=.local/oce-dev/runtime/linux-arm64 \
  --build-arg OCE_RUNTIME_IMAGE=YOUR_OCE_RUNTIME_IMAGE \
  -f dev/oce/Dockerfile -t oce-runtime:connections-dev dev/oce
docker run --rm --entrypoint /usr/local/bin/oce-connections oce-runtime:connections-dev help
```

Use `linux-amd64` for AMD64. This smoke test exercises the image layout. The
patched Controller and worker build provide the managed integration.

## Register and connect

1. In OCE, register the generated `credential-clients/<slot>.json` as an
   OAuth Credential Client with a write-only secret. Current OCE main
   requires the `tokenUrl` on the client as well as the template. If using
   #7384, enter the endpoints on the template and use its issuer metadata
   verification. Configure the same client ID and secret in the Connections
   service with the exact callback URI OCE shows and that slot's connector.
   [Current OCE configuration](https://github.com/openclaw/openclaw-enterprise/blob/03f8e1f2c5d6d970e3d24bb25e96aebd475c30ea/docs/reference/connection-templates.md#register-a-client)
   · [OCE #7384](https://github.com/openclaw/openclaw-enterprise/pull/7384)
2. Create each generated `connection-templates/<slot>.json` in OCE and
   choose its matching client. The canonical issuer metadata and all templates
   share `/oauth/authorize`, `/oauth/token` and `/oauth/revoke`. The template's
   `authorizationParameters.connector` selects the toolkit. The Harness
   request policy uses the slot's separate API alias and the action routes.
3. Start consent in Console, save the connection and select it in the
   matching plugin's `account` slot. Include the slot name in the Agent's
   instructions.

## Live transport requirement

At the pinned revision, OCE documents that the native OpenShell path can
substitute credentials into matching plaintext requests. The dev patch
refuses a Connections credential binding at deployment policy compilation,
before Provider attachment. Qualification must show that the selected
OpenShell transport refuses plaintext before credential substitution,
independently of the CLI's TLS settings and the destination port.
[OCE transport limitation](https://github.com/openclaw/openclaw-enterprise/blob/03f8e1f2c5d6d970e3d24bb25e96aebd475c30ea/docs/reference/credential-sources.md#implementation-status)

After qualifying that transport, verify Console Connect, slot selection,
deployment, CLI execution, renewal after token expiry, and denial after the
Agent binding is removed. Removing the Agent binding exercises OCE's
delivery authority. Retiring the saved OAuth Source exercises service
revocation separately.
