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
- Risks: Couchbase vector Search indexes are deployment- and dimension-specific, so this connector validates/uses an existing index instead of silently creating a wrong one.

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
| Couchbase Python SDK vector_search example | `SearchRequest.create(VectorSearch.from_vector_query(VectorQuery(...)))`, `scope.search(...)` | Example assumes pre-created test index and sample docs |
| Couchbase Node.js SDK search docs/example | `SearchRequest.create(VectorSearch.fromVectorQuery(VectorQuery.create(...)))`, `scope.search(...)` | Example is not a Strands store and assumes sample index |
| Couchbase SDK vector search classes | Official APIs for VectorQuery and VectorSearch in Python/Node SDKs | Index creation JSON remains environment-specific |
| couchbase-examples/vector-search-cookbook | Capella/Couchbase vector search RAG patterns | Notebook-oriented; not a Strands MemoryStore |

## Design Implications

- API shape: `CouchbaseMemoryStore` in both languages, taking Couchbase connection/index fields plus an embedding provider callback/object.
- Required Couchbase features: KV writes and Couchbase Search vector queries over a pre-existing Search index.
- Main risks: Search index creation differs by Couchbase version/dimensions; automatic creation could create incorrect mappings.
- Recommended implementation path: owned extension packages in this repo with explicit setup docs and gated live integration tests.

# Couchbase Capability Matrix

| Required capability | Required by target integration | Couchbase support | Evidence | Implementation decision |
| --- | --- | --- | --- | --- |
| Connection/auth | Connect with credentials to cluster | Python and Node SDKs support password auth and Capella/local connection strings | Couchbase SDK examples | Constructor/env config in both languages |
| CRUD/KV | `add` must persist memories | Couchbase collections support upsert/get/remove | SDK collection examples | Use KV `upsert` for memory documents |
| Query/filtering | Isolate tenants/namespaces | Search vector query prefilter supports SearchQuery filters | Python/Node vector search examples | Filter by configurable namespace field |
| Index management | Vector search requires index | Couchbase Search supports vector fields, but definitions depend on dimensions/version | SDK vector examples rely on pre-existing index | Do not auto-create; validate through docs/tests and fail with clear setup guidance |
| Search/vector search | `search` must return relevant entries | Couchbase Vector Search via SDK `VectorQuery`/`VectorSearch` | Official Python and Node SDK vector APIs | Use scope search against configured Search index |
| Transactions/durability | Not required by Strands MemoryStore | Couchbase supports durability options, not needed for baseline | SDK capability | Keep baseline simple; document advanced users can extend |
| Streaming/change events | Not required | Couchbase DCP/eventing exists but not needed | Product capability | Out of scope |
| Local test environment | Required where possible | Couchbase Docker can run locally, but vector Search index setup is heavier than unit CI | Pre-pulled local image and SDK docs | Add gated integration tests and setup docs; run unit/build in CI by default |

# Feasibility Decision

Status: Implementable with limitations

Reason:

- Strands exposes a public MemoryStore interface in both Python and TypeScript.
- Couchbase supports KV writes and vector search through official Python and Node SDKs.
- The connector can stay model-vendor-neutral by accepting an embedding provider callback/object.
- The only material limitation is that Search index creation is not safely generic, because vector dimensions, field mappings, and scoped/global index placement are deployment-specific.

Evidence:

- Strands MemoryStore protocol files in `strands-agents/harness-sdk`.
- Strands extension-template MemoryStore skeletons for Python and TypeScript.
- Couchbase Python SDK vector search example using `VectorQuery`, `VectorSearch`, `SearchRequest`, and `scope.search`.
- Couchbase Node.js SDK search example using `VectorQuery.create`, `VectorSearch.fromVectorQuery`, `SearchRequest.create`, and `scope.search`.

Implementation path:

- Owned Couchbase example/extension repository with separate Python and TypeScript packages.
- Implement `search`, `add`, and raw `add_messages`/`addMessages` for completeness.
- Require a pre-created Couchbase Search index and document setup thoroughly.
