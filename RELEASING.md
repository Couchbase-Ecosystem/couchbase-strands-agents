# Releasing

The two packages are released separately, each from its own tag.

## Python package

1. Configure PyPI trusted publishing for GitHub environment `pypi` and workflow `.github/workflows/release-python.yml`.
2. Tag a release such as `python-v0.1.0`.
3. Pushing the tag runs the release workflow, builds from `python/`, checks the artifacts with Twine, and publishes to PyPI.

## TypeScript package

1. Configure npm trusted publishing for `@couchbase-examples/strands-couchbase-memory` with GitHub organization `Couchbase-Ecosystem`, repository `couchbase-strands-agents`, workflow `release-typescript.yml` and environment `npm`. npm only lets you add a trusted publisher to a package that already exists, so the first version has to be published by a maintainer by hand; see [`typescript/RELEASING.md`](typescript/RELEASING.md).
2. Update the `typescript/package.json` version and `typescript/CHANGELOG.md`.
3. Tag a release such as `typescript-v0.1.0`. The tag must match the `package.json` version, or the workflow stops.
4. Pushing the tag runs the release workflow: checks, live tests against Couchbase Server 8, a clean-project install of the packed tarball that type-checks the examples and runs `examples/smoke-test.ts`, `npm publish --dry-run`, then `npm publish --provenance --access public` over OIDC (no `NPM_TOKEN`).

The release workflows can also be triggered manually with `workflow_dispatch` against an existing release tag. The TypeScript workflow defaults to `dry_run: true` when run manually, so it stops after `npm publish --dry-run`.

## At the first release

Remove "they are not published to PyPI or npm yet" from the root `README.md`.
