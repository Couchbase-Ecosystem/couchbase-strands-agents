# Couchbase Vector Search MemoryStore for Strands Agents

This repository contains Python and TypeScript Strands Agents extension packages that implement the Strands `MemoryStore` interface with Couchbase Vector Search.

The packages are prepared for publishing as separate Strands extensions, but they are not published to PyPI or npm yet.

## What you can use this for

- Give a Strands agent long-term semantic memory backed by Couchbase Capella or Couchbase Server.
- Store model-extracted memories in Couchbase and recall relevant entries automatically through Strands `MemoryManager` injection.
- Share one Couchbase bucket across tenants or agents by configuring isolated namespaces.

This integration does not generate embeddings itself. You provide an embedding provider/callback so the memory store is not coupled to OpenAI, Bedrock, Cohere, Hugging Face, or any other vendor.

## Packages

| Language | Package directory | Package name | Main class |
| --- | --- | --- | --- |
| Python | `python/` | `strands-couchbase-memory` | `CouchbaseMemoryStore` |
| TypeScript | `typescript/` | `@couchbase-examples/strands-couchbase-memory` | `CouchbaseMemoryStore` |

## Requirements

- Strands Agents with `MemoryStore` support.
- Couchbase Capella or Couchbase Server with the Search service and Vector Search enabled.
- A Couchbase bucket, scope, collection, and Search index that indexes your vector field.
- An embedding provider that returns vectors with the same dimensions as the Search index.

## Choose Capella or local Couchbase

Use Couchbase Capella when your Strands application runs from a hosted environment or must be reachable over the public internet. A local Docker Couchbase Server is ideal for development and CI-style testing, but it is not reachable by hosted SaaS runtimes unless you expose it deliberately.

## Couchbase data model

Each stored memory is written as a JSON document:

```json
{
  "content": "User prefers dark-mode dashboards.",
  "embedding": [0.12, -0.03, 0.44],
  "metadata": {"category": "preference"},
  "namespace": "default",
  "created_at": "2026-08-18T00:00:00Z",
  "updated_at": "2026-08-18T00:00:00Z"
}
```

Default field names are configurable:

- content: `content`
- vector: `embedding`
- metadata: `metadata`
- namespace: `namespace`

## Search index

Create a Couchbase Search index that maps the vector field as a vector field and stores the fields returned by the connector. The exact index JSON depends on Couchbase version and Capella UI, but the index must include:

- a vector field named `embedding` (or your configured vector field), with dimensions matching your embedding provider;
- a text or stored field named `content`;
- a filterable/stored field named `namespace` for tenant isolation;
- stored `metadata` if you want metadata returned with search hits.

See `docs/couchbase-setup.md` for local and Capella setup notes.

## Python quickstart

Install from source until the package is published:

```bash
cd python
python -m pip install -e .
```

Use it with Strands:

```python
from strands import Agent
from strands.memory import MemoryManager
from strands_couchbase_memory import CouchbaseMemoryStore

class DemoEmbeddingProvider:
    async def embed(self, text: str) -> list[float]:
        # Replace with OpenAI, Bedrock, Cohere, Hugging Face, etc.
        values = [0.0, 0.0, 0.0]
        values[hash(text) % 3] = 1.0
        return values

store = CouchbaseMemoryStore(
    name="couchbase",
    connection_string="couchbase://localhost",
    username="Administrator",
    password="password",
    bucket_name="strands_memory",
    search_index_name="strands-memory-index",
    embedding_provider=DemoEmbeddingProvider(),
    dimensions=3,
    writable=True,
    extraction=True,
)

agent = Agent(memory_manager=MemoryManager(stores=[store]))
agent("Remember that I prefer dark-mode dashboards.")
agent("How do I like my dashboards?")
```

Run the complete example:

```bash
cd python
cp .env.example .env
# edit .env for your Couchbase connection and embedding provider
python examples/basic_memory.py
```

## TypeScript quickstart

Install from source until the package is published:

```bash
cd typescript
npm install
npm run build
```

Use it with Strands:

```ts
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { CouchbaseMemoryStore } from '@couchbase-examples/strands-couchbase-memory'

const store = new CouchbaseMemoryStore({
  name: 'couchbase',
  connectionString: 'couchbase://localhost',
  username: 'Administrator',
  password: 'password',
  bucketName: 'strands_memory',
  searchIndexName: 'strands-memory-index',
  dimensions: 3,
  writable: true,
  extraction: true,
  embeddingProvider: {
    async embed(text: string): Promise<number[]> {
      const values = [0, 0, 0]
      values[text.length % 3] = 1
      return values
    },
  },
})

const agent = new Agent({ memoryManager: new MemoryManager({ stores: [store] }) })
await agent.invoke('Remember that I prefer dark-mode dashboards.')
```

Run the complete example:

```bash
cd typescript
cp .env.example .env
# edit .env for your Couchbase connection and embedding provider
npm run example:basic
```

## Configuration

Use constructor arguments or environment variables. Constructor arguments take precedence.

| Purpose | Python env | TypeScript env | Default |
| --- | --- | --- | --- |
| Connection string | `COUCHBASE_CONNECTION_STRING` | `COUCHBASE_CONNECTION_STRING` | `couchbase://localhost` |
| Username | `COUCHBASE_USERNAME` | `COUCHBASE_USERNAME` | none |
| Password | `COUCHBASE_PASSWORD` | `COUCHBASE_PASSWORD` | none |
| Bucket | `COUCHBASE_BUCKET` | `COUCHBASE_BUCKET` | `strands_memory` |
| Scope | `COUCHBASE_SCOPE` | `COUCHBASE_SCOPE` | `_default` |
| Collection | `COUCHBASE_COLLECTION` | `COUCHBASE_COLLECTION` | `_default` |
| Search index | `COUCHBASE_SEARCH_INDEX` | `COUCHBASE_SEARCH_INDEX` | `strands-memory-index` |
| Namespace | `COUCHBASE_NAMESPACE` | `COUCHBASE_NAMESPACE` | `default` |

## Developer workflow

Python:

```bash
cd python
python -m pip install -e '.[dev]'
ruff format src tests examples
ruff check src tests examples
mypy src
pytest
python -m build
```

TypeScript:

```bash
cd typescript
npm install
npm run format:check
npm run lint
npm run type-check
npm test
npm run build
npm pack --dry-run
```

Repository-wide checks:

```bash
./scripts/secret-scan.sh
```

## Publish path (not performed yet)

Python package:

1. Tag a release such as `python-v0.1.0`.
2. Build from `python/` with `python -m build`.
3. Upload with `twine upload dist/*` from a maintainer machine configured for the target PyPI project.

TypeScript package:

1. Update `typescript/package.json` version.
2. Build and verify with `npm run build && npm pack --dry-run`.
3. Publish with `npm publish --access public` from a maintainer machine with npm publish access for `@couchbase-examples`.

The task explicitly says not to publish packages yet, so this repository stops at package preparation.

## Troubleshooting

- Connection failures: verify `COUCHBASE_CONNECTION_STRING`, credentials, TLS settings, and allowed IPs in Capella.
- Empty search results after writes: Search indexing is asynchronous; wait for the index to ingest documents and verify the index maps the configured vector field.
- Vector dimension errors: ensure your embedding provider returns exactly the same number of dimensions as the Search index.
- Metadata filters not matching: make sure metadata and namespace fields are indexed as filterable/stored fields in the Search index.

## Research and design notes

See `docs/research-and-feasibility.md` for the Strands contract, reference integrations, Couchbase capability matrix, and feasibility decision.

## License

Apache-2.0.
