---
doc_type: runbook
project: workspace
status: active
truth_mode: maintained
created: 2026-10-06
verified: 2026-10-06
verified_by: manual
---

# Release maintenance

Applies only to chenhaoxiang/pi-messenger. The community project remains [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger).

## Branch and version contract

- `main` integrates our fixes and is the GitHub default/release branch. Topic branches use pull requests and regular merges.
- `upstream-main` mirrors only the community `main` exactly; never add documentation, version bumps, merge commits, or fork fixes to that mirror. Existing historical branches are retained.
- The `upstream` remote fetches only `refs/heads/main` and has push URL `DISABLED`. Refresh the mirror with a normal fast-forward push; if it has diverged, stop and preserve both tips rather than force-pushing.
- Package version: `<community-base-version>-fork.<N>`; release tag: `v<package-version>`. N starts at 1 and increments for each fork release on the same community base. Never reuse tags or replace published assets.
- `-fork.N` identifies a maintained fork; GitHub Releases are marked stable/latest, not experimental prereleases. This does not change SemVer ordering in npm.

## Baseline for this release

Version **0.15.2-fork.1** retains the maintained integration of community 0.15.2 and our reliability changes: durable processed markers, payload fingerprints, scoped/session-bound inbox processing, stale lock recovery and bounded dedupe. Current community main is already an ancestor; no runtime behavior changes are made by this release maintenance.

## Publish every version

1. Fetch origin/main and create an isolated worktree from the latest remote integration branch. Keep all pre-existing dirty work untouched.
2. Merge only reviewed community changes when needed; resolve conflicts without discarding fork fixes. Update package version, lockfile metadata (when present), and both README files.
3. Run `npm test -- --maxWorkers=2 --minWorkers=1` with disposable provider-free fixtures. Keep concurrency bounded on busy machines; do not use live coordination state or Crew tasks. Review the exact diff and required CI.
4. Merge the PR normally, then verify the remote main contains the validated head.
5. At that exact main commit, run `npm pack --ignore-scripts --pack-destination tmp/release`. Inspect/extract the tarball and smoke-load it in an isolated Pi agent directory without model requests.
6. Write `release-manifest.json` with repository, version, exact source commit, community base, mirror tip, package filename and SHA-256. Generate `SHA256SUMS` for both the tarball and manifest.
7. Create a GitHub Release with `gh release create v<version> --target <exact-main-sha> --latest`, attaching the tarball, manifest and checksums. Never run `npm publish` against the upstream author's package.
8. Download the published assets afresh, verify `shasum -a 256 -c SHA256SUMS`, and smoke-load the downloaded package. Record the PR, tests and installation limitations in release notes.

## Installation

Prefer the pinned git command in README. For offline/artifact installs, download the three release assets into a temporary directory, verify the checksums, then extract the package into a permanent user-owned package directory and run `pi install /absolute/path/to/package`. Do not leave an active install under a temporary release directory. Restart Pi or use `/reload` after installation; disk changes do not hot-reload existing sessions.

Keep the previous release/source available for rollback. Installation must not overwrite live coordination data, remove active reservations or restart unrelated sessions.

## 中文摘要

`main` 是保留我们修复的维护主线，`upstream-main` 只镜像社区主分支。版本使用社区基线加 `-fork.N`，每次通过测试的版本都发布固定 tag、GitHub Release、可安装包、来源清单和 SHA-256 校验文件。社区镜像领先不代表该新功能已进入本次发布；不能用纯社区树覆盖我们的修复。安装后需重启或 reload，已有会话不会自动切换。
