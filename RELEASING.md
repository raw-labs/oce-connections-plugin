# Packages and releases

The public successor repository is `raw-labs/oce-connections-plugin`. Its
package is `@raw-labs/oce-connections-plugin`. The original Gateway plugin has
its own repository and package. This successor keeps the inherited version
history. Gateway deployments need a fresh enrollment through OCE when
moving to the successor.

`package.json` owns the version. Release Please opens the release PR and
maintains the changelog and tag. The bootstrap SHA starts the successor's
first release notes after the fork point. Review the release PR after its required
`verify` check passes. CI and publication run on RAW Labs' Depot Linux ARM
runners with the pinned Node, pnpm and Go toolchains and the frozen lockfile.

Run `pnpm check`, `pnpm build` and `pnpm inspect:package` locally. The tarball
includes the built service, the CLI source, the skill, dev integration assets
and notices. Install the public release tarball using npm to resolve the
service's public dependencies. Build the native CLI from the included source
with `CGO_ENABLED=0 go build -trimpath -buildvcs=false -o oce-connections ./cli`.
Generate Linux image overlays from the source checkout using the
[dev integration guide](dev/oce/README.md).

The Release workflow verifies the tagged build and publishes the same tarball
to the private GitHub Packages package and the public GitHub Release. It uses
the workflow token and checks private visibility and repository linkage.
Public release archives require no registry credentials to download.

A failed publication can be resumed from the Release workflow with the
existing tag. Published versions and archives are immutable. Consumer
workflows need `packages: read` and access to the package in its **Manage
Actions access** settings. Local registry consumers need a classic PAT with
`read:packages` and applicable organization SSO authorization.

CI has read-only permissions for contributor PRs. Keep release jobs confined
to main and maintainer dispatch. Enable secret scanning, push protection and
private vulnerability reporting.
