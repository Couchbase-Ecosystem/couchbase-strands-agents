# Changelog

All notable changes to `strands-couchbase` are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

Initial release.

- `CouchbaseMemoryStore`, a Strands Agents `MemoryStore` backed by Couchbase Hyperscale Vector Search (SQL++ `APPROX_VECTOR_DISTANCE`), with an optional Search-service vector backend.
- `extraction=True` distills facts with the agent's model through Strands' `ModelExtractor` and stores them via `add`; raw conversation turns are not stored.
- `initialize()`, which `MemoryManager` awaits at agent startup, connects and checks that the vector index matches the configured field, `dimensions` and `distance_metric`. `validate_on_initialize=False` skips the index checks.
- The constructor validates the config and makes no network calls; the store connects on first use.
- Namespace isolation, configurable field names, distance metric (`COSINE`, `DOT`, `L2`/`EUCLIDEAN`, `L2_SQUARED`/`EUCLIDEAN_SQUARED`) and centroids-to-probe.
- Stored documents and keys are compatible with the TypeScript package.
- Requires Python 3.10 or later and `strands-agents` `>=1.45.0,<2.0.0`.

[Unreleased]: https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/compare/python-v0.1.0...HEAD
[0.1.0]: https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/releases/tag/python-v0.1.0
