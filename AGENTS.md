# Contributor guide

- OCE owns saved connections and agent grants. Connections owns OAuth issuance,
  exact account mappings and dispatch receipts. Composio owns downstream provider
  credentials and execution. Use one provider-neutral CLI and skill.
- Keep the project key in the Connections service. Bind consent completion to its
  originating browser ticket. Preserve exact account, subject, toolkit and auth
  configuration bindings. Resolve account authority from the validated grant.
- Persist a dispatch receipt before external effects. Serialize conflicting operations
  and keep uncertain outcomes explicit. Never automatically replay a mutation.
  Validate our envelopes. Provider schemas are advisory.
- Keep provider I/O in its adapter and durable state in the local store. Use strict
  TypeScript, runtime validation and parameterized SQL. Avoid `any`, unsafe casts,
  blanket suppressions and sibling-repository runtime imports.
- README.md owns setup, configuration and operational limits. RELEASING.md owns
  versioning, workflows and private package access. Preserve licenses and revisions
  in THIRD_PARTY_NOTICES.md.
- Review changed files. Run `pnpm check`, `pnpm build` and relevant HTTPS service,
  CLI and integration verification. Inspect the packed artifact and clean fixtures.
- Use RAW Labs' Depot Linux ARM runners. Package versions come from package.json.
  Keep the GitHub Packages package private and use workflow tokens to publish.
  Public release tarballs are the unauthenticated download path.
- Work only on the requested slice. Preserve unrelated work and push only when authorized.
