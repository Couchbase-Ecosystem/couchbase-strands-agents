# Changelog

All notable changes to `@couchbase-examples/strands-couchbase-memory` are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

Initial release.

- `CouchbaseMemoryStore`, a Strands Agents `MemoryStore` backed by Couchbase Hyperscale Vector Search (SQL++ `APPROX_VECTOR_DISTANCE`), with an optional Search-service vector backend.
- `extraction: true` distills facts with the agent's model through Strands' `ModelExtractor` and stores them via `add`; raw conversation turns are not stored.
- Namespace isolation, configurable field names, distance metric and centroids-to-probe.
- ESM-only; requires Node.js 22 or later and `@strands-agents/sdk` `>=1.13.0 <2.0.0`.
