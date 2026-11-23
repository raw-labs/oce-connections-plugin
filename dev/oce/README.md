# Connections in OCE dev images

The first integration uses bundled dev assets and a dedicated OpenClaw
Harness on Kubernetes with OpenShell. The test OAuth client can exercise the
service independently. Build these assets without custom plugin import.

The draft contracts used here are typed Sources and Connection Templates,
saved-account Agent access, and native HTTP credential delivery. Custom
plugin import is a later distribution option. [OCE #7010](https://github.com/openclaw/openclaw-enterprise/pull/7010)
· [OCE #4673](https://github.com/openclaw/openclaw-enterprise/pull/4673)
· [OCE #7097](https://github.com/openclaw/openclaw-enterprise/pull/7097)
· [OCE #4734](https://github.com/openclaw/openclaw-enterprise/pull/4734)

## Build the runtime overlay

Copy [slots.example.json](slots.example.json) and set the issuer and distinct
API DNS names. All API names can serve the same Connections process. Choose
one slot for each account that an Agent can attach, including multiple for the
same provider. The aliases keep the OpenShell credential selectors disjoint
and each slot has its own placeholder.

```sh
pnpm install --frozen-lockfile
pnpm build:oce dev/oce/slots.example.json .local/oce-dev
```

Use an empty output directory. The command builds both Linux architectures
with the pinned Go toolchain. It writes runtime filesystem overlays, a
managed catalog fragment, manual OAuth templates, and the request policy
registration inputs. For an ARM64 dev image:

```sh
docker buildx build --load --platform linux/arm64 \
  --build-context connections-overlay=.local/oce-dev/runtime/linux-arm64 \
  --build-arg OCE_RUNTIME_IMAGE=YOUR_OCE_RUNTIME_IMAGE \
  -f dev/oce/Dockerfile -t oce-runtime:connections-dev dev/oce
docker run --rm --entrypoint /usr/local/bin/oce-connections \
  oce-runtime:connections-dev help
```

Use the `linux-amd64` overlay for AMD64. Use the image for the OCE Gateway and
dedicated Harness runtime. The executable is installed at
`/usr/local/lib/oce/plugins/connections/bin/oce-connections` and linked on
`PATH`. Network policy matches the native executable's resolved path.
The image fixes slot URLs in `/etc/oce-connections/slots.json`. The CLI reads
the assigned placeholder from the slot's environment variable and sends it
as `Authorization: Bearer`. OpenShell's trust bundle must be available to the
native CLI. No Composio credential belongs in these images.

## Wire the controller for the pilot

The current draft's managed runtime still specializes CLI installation and
request-guard selection for Google Workspace. Its native worker environment
patch forwards the Google placeholder specifically. The generated assets
require OCE's managed CLI registration and scoped worker placeholder
propagation to admit Connections before this flow can run in a live
deployment. They have been prepared for those inputs. This repository
contains the service and the dev overlay. See the upstream
[managed request registry](https://github.com/openclaw/openclaw-enterprise/blob/9ee73bafa34d54d0081e3fe1437c0f302ec1821f/apps/controller/src/drivers/plugin/managed-request-policies.ts)
and [worker environment patch](https://github.com/openclaw/openclaw-enterprise/blob/34cb490338766bb45ee3d9f6da13a84a6daab910/deploy/runtime/openclaw-google-worker-placeholder.patch).

1. Include the generated `catalog/` packages in OCE's managed catalog and merge
   `marketplace.fragment.json` into its entries. Use the release digest and
   binary and skill digests to qualify the dev image. Every registration
   declares one `account` credential slot and Bearer delivery to the Harness.
2. Register the generated `request-policy.mjs` with the OCE managed
   `releasedPolicies` map by calling
   `registerConnectionsRequestPolicies(releasedPolicies, registrations)`
   before computing the advertised guard version. Use the generated
   release SHA as the binding ID and the slot's `requestScope` as its binding
   config. Use `deploymentNetworks.credential` in the admitted network and
   injection rules. The registration allows only four method and path
   combinations on that slot's HTTPS origin. Its guard checks the
   normalized headers, query and call envelope. A live deployment requires
   the registered guard and its fail-closed HTTPS enforcement.
3. In OCE, create each generated `connection-templates/<slot>.json` as a manual
   OAuth template. Register its generated `clientId` as a confidential client
   with `client_secret_basic`. Configure that same client in the Connections
   service with the exact redirect URI OCE returns, the same secret, and only
   that template's connector. The issuer owns enrollment, refresh and
   revocation endpoints. Only the per-slot API alias is admitted for
   credential delivery.
4. Start consent from each template in OCE, save the connections, and attach
   each saved account to its corresponding plugin's `account` slot. Include
   the slot names in the Agent's deployment instructions. Validate that the
   worker receives each placeholder, that OpenShell replaces it only for
   the matched CLI request, and that one Agent can use the assigned slots
   independently. The fixture suite tests policy decisions and application
   isolation. Live OpenShell delivery requires the combined OCE environment.

The same CLI and skill bytes are reused for every slot. The only per-slot
inputs are the catalog entry, its selected account, the template, the
placeholder name and its HTTPS route.
