# Couchbase Hyperscale Vector Search MemoryStore for Strands Agents

This repository contains Python and TypeScript Strands Agents extension packages that implement the Strands `MemoryStore` interface with Couchbase Hyperscale Vector Search.

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
- Couchbase Capella or Couchbase Server with the Index and Query services enabled for Hyperscale Vector Indexes.
- A Couchbase bucket, scope, collection, and Hyperscale Vector Index on your vector field.
- An embedding provider that returns vectors with the same dimensions as the Hyperscale Vector Index.

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

## Vector index

By default, the connector uses Couchbase Hyperscale Vector Indexes through SQL++ `APPROX_VECTOR_DISTANCE`, because this is Couchbase's latest and preferred vector-search path. Create a Hyperscale Vector Index on your embedding field and include the fields returned by the connector:

```sql
CREATE VECTOR INDEX `strands-memory-vector-index`
ON `strands_memory`.`_default`.`_default` (`embedding` VECTOR)
INCLUDE (`content`, `metadata`, `namespace`)
USING GSI
WITH {
  "dimension": 3,
  "similarity": "L2_SQUARED",
  "description": "IVF,SQ8"
};
```

The connector also supports the legacy Search-service vector API by setting `COUCHBASE_VECTOR_BACKEND=search` (or `vector_backend="search"` / `vectorBackend: "search"`) and configuring a Search Vector Index.

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
    distance_metric="L2_SQUARED",
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
  distanceMetric: 'L2_SQUARED',
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
| Vector backend | `COUCHBASE_VECTOR_BACKEND` | `COUCHBASE_VECTOR_BACKEND` | `hyperscale` |
| Distance metric | `COUCHBASE_DISTANCE_METRIC` | `COUCHBASE_DISTANCE_METRIC` | `L2_SQUARED` |
| Legacy Search index | `COUCHBASE_SEARCH_INDEX` | `COUCHBASE_SEARCH_INDEX` | `strands-memory-search-index` |
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

1. Configure PyPI trusted publishing for GitHub environment `pypi` and workflow `.github/workflows/release-python.yml`.
2. Tag a release such as `python-v0.1.0`.
3. Pushing the tag runs the release workflow, builds from `python/`, checks the artifacts with Twine, and publishes to PyPI.

TypeScript package:

1. Configure repository secret `NPM_TOKEN` with publish access for `@couchbase-examples` and protect the GitHub environment `npm` as needed.
2. Update `typescript/package.json` version.
3. Tag a release such as `typescript-v0.1.0`.
4. Pushing the tag runs the release workflow, validates the package, and publishes with `npm publish --access public`.

The release workflows can also be triggered manually with `workflow_dispatch` against an existing release tag.

## Troubleshooting

- Connection failures: verify `COUCHBASE_CONNECTION_STRING`, credentials, TLS settings, and allowed IPs in Capella.
- Empty search results after writes: verify the Hyperscale Vector Index exists, the distance metric matches the query metric, and `num_candidates` / `numCandidates` probes enough centroids for your data.
- Vector dimension errors: ensure your embedding provider returns exactly the same number of dimensions as the Hyperscale Vector Index.
- Metadata filters not matching: make sure metadata and namespace fields are included in the Hyperscale Vector Index or switch to a Composite Vector Index when scalar filters should run before vector search.

## Research and design notes

See `docs/research-and-feasibility.md` for the Strands contract, reference integrations, Couchbase capability matrix, and feasibility decision.

## License

Apache-2.0.
