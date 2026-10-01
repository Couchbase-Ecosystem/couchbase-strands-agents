# Releasing the TypeScript package

Releases are published by `.github/workflows/release-typescript.yml` with npm trusted publishing (OIDC) and `--provenance`. No npm token is stored in GitHub.

## How the pieces fit

| Piece | What it does |
| --- | --- |
| `.github/workflows/draft-release-typescript.yml` | On every push to `main`, regenerates a draft GitHub release for the next version. If `package.json` still holds a version that is already tagged, the draft is named after the next patch as a placeholder. Hand edits to the draft are overwritten on the next merge. |
| `scripts/typescript-release-notes.sh` | Builds the notes: GitHub's generated notes since the previous `typescript-v*` tag, filtered to the PRs that touched the TypeScript package. |
| `.github/release.yml` | Groups the notes by PR label (Features, Fixes, Testing and CI, …). PRs labelled `skip-changelog` are left out. |
| `.github/workflows/label-pull-requests.yml` | Labels PRs from their conventional-commit title and changed paths, so the notes stay grouped. |
| `.github/workflows/release-typescript.yml` | On a `typescript-v*` tag: checks the tag matches `package.json` and that the version is not on npm yet, runs every check and the live tests, installs the packed tarball in a clean project, publishes to npm with provenance, then publishes the draft GitHub release (or creates one if there is no draft). |

## Every release

1. Look at the draft release on the [Releases page](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/releases) to see what has merged since the last release, and pick the next version (semver; anything that breaks the public API before 1.0 is a minor bump).
2. Open a release PR titled `chore(release): typescript <version>` that:
   - sets `version` in `package.json` and updates the lockfile with `npm install --package-lock-only`;
   - moves the entries under `## [Unreleased]` in `CHANGELOG.md` into a new `## [<version>] - <YYYY-MM-DD>` section, and updates the compare links at the bottom.

   When it merges, the draft is renamed to `typescript-v<version>`.
3. Optionally edit the draft's wording. Do this after the release PR merges, because each merge regenerates the draft.
4. Tag the merge commit and push the tag:

   ```bash
   git switch main && git pull
   git tag typescript-v<version>
   git push origin typescript-v<version>
   ```

   The workflow fails if the tag and `package.json` disagree, or if the version is already on npm.
5. Watch the **Release - TypeScript** run. When it passes, the package is on npm with a provenance attestation and the GitHub release is published.
6. Check the result:

   ```bash
   npm view @couchbase-ecosystem/strands-couchbase@<version> dist.attestations
   gh release view typescript-v<version>
   ```

A version with a prerelease suffix (`0.2.0-rc.1`) is published under the `next` dist-tag and marked as a prerelease on GitHub, so `npm install` keeps getting the latest stable version.

### Dry run

To rehearse without publishing, run the workflow manually from the Actions tab with `tag: typescript-v<version>` and `dry_run: true` (the default). It runs every check, the live tests, the clean-project install and `npm publish --dry-run`, then stops. It does not touch the GitHub release.

### If something goes wrong

- **The workflow failed before `npm publish`.** Fix the problem on `main`. If the fix changes the released code, delete the tag (`git push origin :refs/tags/typescript-v<version>`), then tag the new commit and push again. Otherwise re-run the failed jobs.
- **npm publish succeeded but the GitHub release job failed.** Re-run only that job. It publishes the draft, or creates the release if there is no draft.
- **A bad version reached npm.** npm versions can't be reused. Deprecate it with `npm deprecate @couchbase-ecosystem/strands-couchbase@<version> "<reason>"` and release a new patch. Use `npm unpublish` only within 72 hours, and only if nobody can depend on the version yet.

## npm settings

These are configured on npmjs.com for `@couchbase-ecosystem/strands-couchbase` and should stay this way:

- **Trusted publishing**: GitHub Actions, organization `Couchbase-Ecosystem`, repository `couchbase-strands-agents`, workflow `release-typescript.yml`, environment `npm`. Renaming the workflow file or the `npm` environment breaks publishing until this is updated.
- **Publishing access**: "Require two-factor authentication and disallow tokens", so that only the workflow can publish.

## History

`0.1.0` was published by hand on 2026-10-01, because npm only lets you add a trusted publisher to a package that already exists. It has no provenance attestation. The tag-triggered workflow runs for `typescript-v0.1.0` failed with `E404` at `npm publish`, as expected, because the package did not exist yet. Every later version is published by the workflow.
