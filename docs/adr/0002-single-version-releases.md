# ADR 0002 — Single product version, tag-driven releases, no changesets

**Status:** Accepted (2026-07-03, closes refactor plan #22)

## Context

The refactor plan called for adopting [changesets](https://github.com/changesets/changesets)
to automate version bumps and changelogs "for the publishable packages". When the
plan was written, the publishing surface was unknown. It is now clear:

- Every workspace package is `private: true` **except `create-calame`**
  (`packages/create`), a ~100-line npx bootstrapper.
- `create-calame`'s version is **overwritten from the root `package.json`
  version** by `publish-npm.yml` at publish time.
- Releases are tag-driven: pushing `vX.Y.Z` builds the Docker image
  (`publish-docker.yml` → GHCR) and publishes `create-calame` — both carrying
  the same version.

So Calame is a **single-version product**, not a constellation of independently
versioned libraries. Changesets' core job — coordinating semver across multiple
published packages and their inter-dependencies — has no work to do here.

## Decision

1. **No changesets.** One product version, owned by the root `package.json`,
   flows to every artifact (Docker tag, npm version) at release time.
2. **`CHANGELOG.md` at the repo root**, [Keep a Changelog](https://keepachangelog.com)
   format, maintained by hand under an `Unreleased` heading as PRs merge.
   Commit messages follow Conventional Commits, so tooling-assisted generation
   remains possible later without changing this decision.
3. **Release procedure** (manual, documented here):
   1. Move the `Unreleased` section of `CHANGELOG.md` under the new version.
   2. Bump `version` in the root `package.json`.
   3. Commit, tag `vX.Y.Z`, push the tag — CI does the rest (GHCR image +
      npm publish).

## Consequences

- Zero new dependencies or bot workflows; contributors only have to update
  one changelog section per user-visible change.
- If the workspace ever publishes real libraries independently (e.g.
  `@calame/connectors` on npm), this decision must be revisited — that is
  exactly the moment changesets starts paying for itself.
- The root version is currently the only source of truth; forgetting the
  `package.json` bump before tagging would ship a stale version — the release
  procedure above exists to prevent that.
