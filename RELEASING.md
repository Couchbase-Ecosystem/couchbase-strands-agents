# Releasing

The two packages are released separately, each from its own tag: `typescript-v*` and `python-v*`.

## TypeScript package

Published to npm as [`@couchbase-ecosystem/strands-couchbase`](https://www.npmjs.com/package/@couchbase-ecosystem/strands-couchbase) by `.github/workflows/release-typescript.yml`, using npm trusted publishing (OIDC) with `--provenance`. No npm token is stored in GitHub. The full checklist is in [`typescript/RELEASING.md`](typescript/RELEASING.md). In short:

1. `draft-release-typescript.yml` keeps a draft GitHub release for the next TypeScript version up to date on every merge to `main`.
2. Open a release PR that bumps `typescript/package.json` (and the lockfile) and moves the `Unreleased` entries in `typescript/CHANGELOG.md` under the new version.
3. After it merges, tag that commit `typescript-v<version>` and push the tag. The tag must match the `package.json` version, or the workflow stops.
4. The tag push runs the checks, live tests against Couchbase Server 8, a clean-project install of the packed tarball, `npm publish --provenance`, and then publishes the draft GitHub release.

## Python package

Published to PyPI as [`strands-couchbase`](https://pypi.org/project/strands-couchbase/) by `.github/workflows/release-python.yml`, using PyPI trusted publishing (OIDC) from the GitHub environment `pypi`, with attestations. No PyPI token is stored in GitHub. The full checklist, including the one-time PyPI and GitHub setup, is in [`python/RELEASING.md`](python/RELEASING.md). In short:

1. `draft-release-python.yml` keeps a draft GitHub release for the next Python version up to date on every merge to `main`, named after the newest version in `python/CHANGELOG.md`.
2. Open a release PR that moves the `Unreleased` entries in `python/CHANGELOG.md` under the new version and dates them. There is no version to bump: `hatch-vcs` takes it from the tag.
3. After it merges, `git fetch`, then tag that exact commit hash `python-v<version>` and push the tag. The version built at the tag must be exactly `<version>`, or the workflow stops.
4. The tag push checks the version is not already on PyPI, runs the checks, live tests against Couchbase Server 8, a clean-venv install of the built wheel, `twine check`, publishes to PyPI, and then publishes the draft GitHub release.

## Manual runs

Both release workflows can be run with `workflow_dispatch` against an existing release tag, and both default to `dry_run: true` when run manually: they run every check, then stop without publishing or touching the GitHub release. The TypeScript dry run also runs `npm publish --dry-run`. A Python dry run from a branch, or without a tag, stops at the version check, because the build has a development version.
