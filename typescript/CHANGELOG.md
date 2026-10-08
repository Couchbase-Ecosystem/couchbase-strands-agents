# Changelog

All notable changes to `@couchbase-ecosystem/strands-couchbase` are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-07

No changes to the package code or its dependency ranges.

- First version published by the release workflow over npm trusted publishing, so it carries an npm provenance attestation. `0.1.0` was published by hand and has none.

## [0.1.0] - 2026-10-01

Initial release.

- `CouchbaseMemoryStore`, a Strands Agents `MemoryStore` backed by Couchbase Hyperscale Vector Search (SQL++ `APPROX_VECTOR_DISTANCE`), with an optional Search-service vector backend.
- `extraction: true` distills facts with the agent's model through Strands' `ModelExtractor` and stores them via `add`; raw conversation turns are not stored.
- Namespace isolation, configurable field names, distance metric and centroids-to-probe.
- ESM-only; requires Node.js 22 or later and `@strands-agents/sdk` `>=1.13.0 <2.0.0`.

[Unreleased]: https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/compare/typescript-v0.1.1...HEAD
[0.1.1]: https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/compare/typescript-v0.1.0...typescript-v0.1.1
[0.1.0]: https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/releases/tag/typescript-v0.1.0
