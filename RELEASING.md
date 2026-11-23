# Packages and releases

The public successor repository is `raw-labs/oce-connections-plugin`. Its package
is `@raw-labs/oce-connections-plugin`. The original Gateway plugin has its own
repository and package.

The source of the package version is `package.json`. Release Please manages the
release PR, changelog and tag. Review the release PR after the required `verify`
check passes. CI and publication run on RAW Labs' Depot Linux ARM runners with
the pinned Node, pnpm and locked dependency graph.

Run `pnpm check`, `pnpm build` and `pnpm inspect:package` locally. The Release
workflow verifies the tagged build and publishes the same tarball to the private
GitHub Packages package and the public GitHub Release. Publication uses the
workflow token. Keep the registry package private and link it to this repository.
Public release archives require no registry credentials to download.

A failed publication can be resumed from the Release workflow with the existing
tag. Published versions and archives are immutable. Consumer workflows need
`packages: read` and access to the package in its **Manage Actions access**
settings. Local registry consumers need a classic PAT with `read:packages` and
applicable organization SSO authorization.
