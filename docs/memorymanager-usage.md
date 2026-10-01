# Strands MemoryManager usage

`CouchbaseMemoryStore` plugs into the native Strands `MemoryManager` API. It is a `MemoryStore` implementation that applications construct in trusted code and attach to a `MemoryManager`.

## What Strands does with the store

When a store is attached to a `MemoryManager`, Strands can use it for three related behaviors documented by the Strands SDK:

1. **Recall** — `search_memory` lets the agent search stored knowledge on demand.
2. **Injection** — relevant memory can be searched and folded into the model prompt before a call.
3. **Extraction** — conversation messages can be distilled into durable memories and written to writable stores.

Recall and injection are enabled by default when you attach a store. Writing is opt-in through either the `add_memory` tool or automatic extraction on a writable store.

## Basic MemoryManager setup

Python:

```python
from strands import Agent
from strands.memory import MemoryManager
from strands_couchbase import CouchbaseMemoryStore

store = CouchbaseMemoryStore(
    name="preferences",
    description="User preferences and stable facts.",
    embedding_provider=embedding_provider,
    dimensions=1536,
    writable=True,
    extraction=True,
)

agent = Agent(memory_manager=MemoryManager(stores=[store]))
```

TypeScript:

```ts
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { CouchbaseMemoryStore } from '@couchbase-ecosystem/strands-couchbase'

const store = new CouchbaseMemoryStore({
  name: 'preferences',
  description: 'User preferences and stable facts.',
  embeddingProvider,
  dimensions: 1536,
  writable: true,
  extraction: true,
})

const agent = new Agent({ memoryManager: new MemoryManager({ stores: [store] }) })
```

## Enabling explicit writes with `add_memory`

Strands' `add_memory` tool is opt-in. Enable it when you want the model to choose what to save:

Python:

```python
agent = Agent(
    memory_manager=MemoryManager(
        stores=[store],
        add_tool_config=True,
    )
)
```

In this mode, the model can ask Strands to save content, but Couchbase connection details and namespace remain fixed in the store configuration.

## Search semantics

Direct calls to `store.search(query, options)` return Strands `MemoryEntry` values ordered by Couchbase vector distance/relevance.

For the default Hyperscale backend, `score` is the SQL++ `APPROX_VECTOR_DISTANCE` result. Lower distances are closer matches. For the optional Search-service backend, `score` comes from Couchbase Search rows and follows Search-service scoring semantics.

Example returned entry:

```json
{
  "content": "User prefers dark-mode dashboards.",
  "metadata": {
    "category": "preference",
    "id": "memory::default::<sha256>",
    "score": 0.12,
    "namespace": "default"
  }
}
```

## Write semantics

`add(content, metadata)` stores one Couchbase JSON document and returns its document key.

- If `metadata.id` is a string, it is used as the document key.
- Otherwise, if `metadata.memory_id` is a string, it is used as the document key.
- Otherwise, the connector builds the key from the content: `memory::<namespace>::<sha256 of the trimmed content>`.
- The chosen key is removed from stored metadata to avoid duplicating identity fields in the document body.

Identical content is stored once per namespace. Without an explicit id, `add` first checks whether the key exists and, if so, returns it without calling the embedding provider. Otherwise it writes with Couchbase's atomic `insert`, which still guards against concurrent writers; if a document with the same key already exists, `add` returns the existing key and leaves that document (including its `created_at` and metadata) unchanged. This matches Strands' `TestMemoryStore`, and it keeps extraction from storing the same fact again when a later session restates it or when Strands retries a batch (extraction writes are at-least-once). Only surrounding whitespace is ignored, so `User lives in Denver.` and `User lives in Denver, Colorado.` are still two memories.

With an explicit `metadata.id` / `metadata.memory_id`, `add` uses `upsert` and overwrites any existing document with that key.

Stored document shape:

```json
{
  "content": "User prefers dark-mode dashboards.",
  "embedding": [0.12, -0.03, 0.44],
  "metadata": {"category": "preference"},
  "namespace": "default",
  "created_at": "2026-08-19T00:00:00Z",
  "updated_at": "2026-08-19T00:00:00Z"
}
```

## Extraction semantics

With `extraction=True` / `extraction: true`, Strands uses its client-side `ModelExtractor`: it asks the model to distill conversation turns into short facts (for example `User lives in Denver.`) and writes each fact through `add`. Questions, small talk, and assistant replies are not stored verbatim.

The store deliberately does not implement `add_messages` / `addMessages`. Strands treats any store that has that method as doing server-side extraction, skips `ModelExtractor`, and hands it the raw message batch, which would save every user and assistant turn as its own memory. To use a different model or prompt for extraction, pass an explicit extractor, for example `extraction={"extractor": ModelExtractor(model=...)}` / `extraction: { extractor: new ModelExtractor({ model }) }`.

## Flushing and shutdown

Strands extraction runs in the background. Call `flush()` on the `MemoryManager` before `store.close()`, otherwise pending extraction writes run against a closed Couchbase connection and fail (Strands logs `memory extraction failed`; the SDK error is `cluster_closed (1006)`).

Python:

```python
memory_manager = MemoryManager(stores=[store])
agent = Agent(memory_manager=memory_manager)
await agent.invoke_async("I prefer dark-mode dashboards.")
await memory_manager.flush()
await store.close()
```

TypeScript:

```ts
const memoryManager = new MemoryManager({ stores: [store] })
const agent = new Agent({ memoryManager })
await agent.invoke('I prefer dark-mode dashboards.')
await memoryManager.flush()
await store.close()
```

## Common errors

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `embedding_provider is required` / constructor error | No embedding provider was configured | Pass an object/function that returns vectors. |
| `embedding provider returned N dimensions; expected M` | Embedding model output does not match configured `dimensions` or vector index dimensions | Align embedding provider, store config, and vector index `dimension`. |
| Query error about invalid metric | `COUCHBASE_DISTANCE_METRIC` does not match Couchbase-supported values or the index `similarity` | Use one of `COSINE`, `DOT`, `L2`, `EUCLIDEAN`, `L2_SQUARED`, `EUCLIDEAN_SQUARED`, and match the index. |
| Empty Hyperscale results | Index missing/wrong, metric mismatch, namespace mismatch, or too few centroids probed | Verify `CREATE VECTOR INDEX`, namespace, and increase `centroids_to_probe` / `centroidsToProbe`. In both packages, `initialize()` catches a missing or mismatched index at agent setup. |
| Auth or timeout errors | Wrong credentials, service not ready, Capella IP allowlist, TLS mismatch | Verify connection string, user permissions, allowed IPs, and `couchbase://` vs `couchbases://`. |

## References

- Strands Memory overview — `https://strandsagents.com/docs/user-guide/concepts/memory/overview/`
- Strands Bedrock Knowledge Base Store — `https://strandsagents.com/docs/user-guide/concepts/memory/bedrock-knowledge-base/`
