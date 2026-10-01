# Couchbase memory for Strands Agents

Long-term memory for [Strands Agents](https://strandsagents.com), stored in Couchbase and recalled with vector search. This repository contains a Python and a TypeScript package. Each implements the Strands `MemoryStore` interface on top of Couchbase Hyperscale Vector Search.

The packages are prepared for publishing as separate Strands extensions, but they are not published to PyPI or npm yet.

## What you can use this for

- Give a Strands agent memory that survives restarts and new sessions, backed by Couchbase Capella or Couchbase Server.
- Store short facts that the agent's model extracts from the conversation (not raw conversation turns), and have Strands `MemoryManager` add the relevant ones to the prompt automatically.
- Share one Couchbase bucket across users, tenants or agents, each isolated in its own namespace.

The packages don't create embeddings. You pass an embedding function, so you can use OpenAI, Amazon Bedrock, a local model or anything else.

## Packages

| Language | Package | Start here |
| --- | --- | --- |
| TypeScript | `@couchbase-examples/strands-couchbase-memory` | [`typescript/README.md`](typescript/README.md): install, a 10-minute quickstart, configuration and troubleshooting |
| Python | `strands-couchbase-memory` | [`python/README.md`](python/README.md) |

Both need Couchbase Server 8.0 or later (or Capella) with the Data, Query and Index services.

## Documentation

- [`docs/couchbase-setup.md`](docs/couchbase-setup.md): Couchbase with Docker or the Capella free tier, and creating the vector index.
- [`docs/tutorial.md`](docs/tutorial.md): a walkthrough of both packages against the same collection.
- [`docs/memorymanager-usage.md`](docs/memorymanager-usage.md): how Strands `MemoryManager` uses the store for recall, injection and extraction.
- [`docs/vector-backends.md`](docs/vector-backends.md): Hyperscale, Composite and Search-service vector indexes, and `APPROX_VECTOR_DISTANCE` tuning.
- [`docs/security-and-multitenancy.md`](docs/security-and-multitenancy.md): tenant namespaces, credentials and prompt injection.
- [`docs/research-and-feasibility.md`](docs/research-and-feasibility.md): the Strands contract, reference integrations and design decisions.

## Development

Each package README lists its checks. Repository-wide:

```bash
./scripts/secret-scan.sh
```

Releases are described in [`RELEASING.md`](RELEASING.md).

## License

Apache-2.0.
