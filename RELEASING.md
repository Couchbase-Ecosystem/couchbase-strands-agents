# Releasing

The two packages are released separately, each from its own tag: `typescript-v*` and `python-v*`.

## TypeScript package

Published to npm as [`@couchbase-ecosystem/strands-couchbase`](https://www.npmjs.com/package/@couchbase-ecosystem/strands-couchbase) by `.github/workflows/release-typescript.yml`, using npm trusted publishing (OIDC) with `--provenance`. No npm token is stored in GitHub. The full checklist is in [`typescript/RELEASING.md`](typescript/RELEASING.md). In short:

1. `draft-release-typescript.yml` keeps a draft GitHub release for the next TypeScript version up to date on every merge to `main`.
2. Open a release PR that bumps `typescript/package.json` (and the lockfile) and moves the `Unreleased` entries in `typescript/CHANGELOG.md` under the new version.
3. After it merges, tag that commit `typescript-v<version>` and push the tag. The tag must match the `package.json` version, or the workflow stops.
4. The tag push runs the checks, live tests against Couchbase Server 8, a clean-project install of the packed tarball, `npm publish --provenance`, and then publishes the draft GitHub release.

## Python package

Not on PyPI yet, and release drafting does not cover it yet.

1. Configure PyPI trusted publishing for GitHub environment `pypi` and workflow `.github/workflows/release-python.yml`.
2. Tag a release such as `python-v0.1.0`. The version comes from the tag (`hatch-vcs`).
3. Pushing the tag runs the release workflow, builds from `python/`, checks the artifacts with Twine, and publishes to PyPI. It does not create a GitHub release.

## Manual runs

Both release workflows can be run with `workflow_dispatch` against an existing release tag. The TypeScript workflow defaults to `dry_run: true` when run manually: it runs every check and `npm publish --dry-run`, then stops without publishing or touching the GitHub release.
