# Repository Orientation

- Target repo: `couchbase-examples/couchbase-strands-agents`.
- Initial state: repository existed but was empty and private.
- Integration type: Strands Agents `MemoryStore` extension packages backed by Couchbase Vector Search.
- Ownership strategy: owned Couchbase example/extension repository. The task explicitly requires separate extension packages, not Strands core changes.
- Existing integration patterns: Strands extension-template has sibling `python/` and `typescript/` packages, CI per ecosystem, and skeleton MemoryStore components. Strands docs list community memory stores as independent packages.
- Build/test commands: Python uses hatch/ruff/mypy/pytest/build. TypeScript uses npm/tsc/eslint/prettier/vitest/npm pack.
- Docs/examples: root README for end users, language-specific READMEs, `docs/`, `python/examples`, and `typescript/examples`.
- Release/package locations: `python/pyproject.toml` for future PyPI release; `typescript/package.json` for future npm release.
- Open related issues or PRs: none found in this empty repo.
- Risks: Couchbase Hyperscale Vector Indexes are the preferred default; Search-service vector indexes are kept as a legacy fallback. Index definitions remain deployment- and dimension-specific, so the connector validates/uses an existing index instead of silently creating a wrong one.

# Integration Research

## Target Integration Contract

Strands current MemoryStore contract is asynchronous in both Python and TypeScript:

- Required store identity/config fields: `name`, optional `description`, optional default max search results, `writable`, optional `extraction`.
- Required method: `search(query, options)` returning ordered `MemoryEntry` objects.
- Optional write sinks: `add(content, metadata)` and `add_messages` / `addMessages(messages, context)`.
- Optional lifecycle: `initialize` and `get_tools`.
- `MemoryManager` injects and extracts memories; a vector database style store should implement `add` and let Strands client-side extraction distill facts unless raw message storage is desired.

Sources checked:

- `strands-agents/harness-sdk` `strands-py/src/strands/memory/types.py`.
- `strands-agents/harness-sdk` `strands-ts/src/memory/types.ts`.
- `strands-agents/extension-template` Python and TypeScript memory-store skeletons.
- Strands docs community memory-store listing, including Dakera example.

## Competitor References

| Reference | Why relevant | Key API/config patterns | Test/docs patterns |
| --- | --- | --- | --- |
| Strands Dakera MemoryStore docs | Independent MemoryStore package | `DakeraMemoryStore` with `MemoryManager(stores=[store])`, `writable=True`, `extraction=True` | Installable package docs with MemoryManager snippet |
| Strands tools MongoDB memory | Vector-backed Strands memory tool | Stores content, embedding, namespace, metadata; validates tenant namespace; uses vector search | Extensive env-var configuration and error handling |
| Strands tools Elasticsearch memory | Vector-backed Strands memory tool | Uses content/embedding/namespace/metadata fields and max results | Documents single-tenant env flow and bound multi-tenant class |
| Strands extension-template | Official extension package template | Sibling Python/TypeScript packages, MemoryStore skeletons, per-language CI | Hatch/pytest/ruff/mypy and npm/vitest/tsc/eslint |

## Existing Couchbase References

| Reference | What can be reused | Gaps |
| --- | --- | --- |
| Couchbase Hyperscale Vector Index docs | `CREATE VECTOR INDEX` plus SQL++ `APPROX_VECTOR_DISTANCE(...)` through Query/Index services | Preferred/default path; requires pre-created Hyperscale Vector Index |
| Couchbase Python/Node Search SDK docs | `SearchRequest.create(VectorSearch...)`, `scope.search(...)` | Confirmed this is the Search-service vector API, not Hyperscale |
| couchbase-examples/vector-search-cookbook | Capella/Couchbase vector search RAG patterns | Notebook-oriented; not a Strands MemoryStore |

## Design Implications

- API shape: `CouchbaseMemoryStore` in both languages, taking Couchbase connection/index fields plus an embedding provider callback/object.
- Required Couchbase features: KV writes and SQL++ vector queries over a pre-existing Hyperscale Vector Index.
- Main risks: Hyperscale index creation differs by dimensions/similarity/centroid tuning; automatic creation could create incorrect mappings.
- Recommended implementation path: owned extension packages in this repo with explicit setup docs and gated live integration tests.

# Couchbase Capability Matrix

| Required capability | Required by target integration | Couchbase support | Evidence | Implementation decision |
| --- | --- | --- | --- | --- |
| Connection/auth | Connect with credentials to cluster | Python and Node SDKs support password auth and Capella/local connection strings | Couchbase SDK examples | Constructor/env config in both languages |
| CRUD/KV | `add` must persist memories | Couchbase collections support upsert/get/remove | SDK collection examples | Use KV `upsert` for memory documents |
| Query/filtering | Isolate tenants/namespaces | SQL++ `WHERE` filters with fields included in the Hyperscale Vector Index | Couchbase Hyperscale docs and live Docker tests | Filter by configurable namespace field |
| Index management | Vector search requires index | Couchbase supports Hyperscale Vector Indexes via `CREATE VECTOR INDEX`; Search Vector Indexes remain a fallback | Couchbase Hyperscale docs | Do not auto-create; document setup and fail clearly if missing |
| Search/vector search | `search` must return relevant entries | Couchbase Hyperscale Vector Index via SQL++ `APPROX_VECTOR_DISTANCE` | Couchbase docs and live Docker tests | Use Query service by default; legacy Search-service backend optional |
| Transactions/durability | Not required by Strands MemoryStore | Couchbase supports durability options, not needed for baseline | SDK capability | Keep baseline simple; document advanced users can extend |
| Streaming/change events | Not required | Couchbase DCP/eventing exists but not needed | Product capability | Out of scope |
| Local test environment | Required where possible | Couchbase Docker can run locally, but vector Search index setup is heavier than unit CI | Pre-pulled local image and SDK docs | Add gated integration tests and setup docs; run unit/build in CI by default |

# Feasibility Decision

Status: Implementable with limitations

Reason:

- Strands exposes a public MemoryStore interface in both Python and TypeScript.
- Couchbase supports KV writes and Hyperscale vector search through SQL++ in the official Python and Node SDKs.
- The connector can stay model-vendor-neutral by accepting an embedding provider callback/object.
- The only material limitation is that vector index creation is not safely generic, because vector dimensions, similarity metrics, and centroid tuning are deployment-specific.

Evidence:

- Strands MemoryStore protocol files in `strands-agents/harness-sdk`.
- Strands extension-template MemoryStore skeletons for Python and TypeScript.
- Couchbase Hyperscale Vector Index docs using `CREATE VECTOR INDEX` and `APPROX_VECTOR_DISTANCE`.
- Couchbase Python SDK 4.6.2 and Node SDK 4.7.1: `VectorQuery` / `VectorSearch` remain Search-service APIs; Hyperscale uses SQL++ query APIs.

Implementation path:

- Owned Couchbase example/extension repository with separate Python and TypeScript packages.
- Implement `search`, `add`, and raw `add_messages`/`addMessages` for completeness.
- Require a pre-created Couchbase Hyperscale Vector Index by default and document legacy Search-service setup separately.
