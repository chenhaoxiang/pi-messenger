# Project guidance

This is the maintained nicobailon/pi-messenger fork. Develop in an isolated worktree, preserve existing reliability behavior and unrelated work.

- `main` is our maintained integration/release branch; use PRs and regular merges.
- `upstream-main` mirrors only community main, with no fork commits. The upstream remote is read-only and main-only.
- Publish every validated version as `v<community-version>-fork.<revision>` with a package tarball, provenance manifest and SHA-256 checksums. Do not publish under the upstream npm identity.
- Run the provider-free test suite with bounded workers; tests must not read live mesh history or mutate production Crew state.
- Retain durable marker, fingerprint, inbox/session binding, stale-lock recovery and fail-closed dedupe guarantees. Disk installation is distinct from reloading running Pi sessions.

## Documentation map

- `README.md` / `README.zh-CN.md`: English-first and full Chinese use, configuration and safety boundaries.
- `docs/releasing.md`: branch/version/release contract and verified artifact installation.
