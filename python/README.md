# Python Couchbase MemoryStore package

`strands-couchbase` implements the Strands Agents `MemoryStore` protocol with Couchbase Hyperscale Vector Search.

## Install for development

```bash
python -m pip install -e '.[dev]'
```

## Minimal usage

```python
from strands.memory import MemoryManager
from strands import Agent
from strands_couchbase import CouchbaseMemoryStore

class Embeddings:
    async def embed(self, text: str) -> list[float]:
        # Replace with your embedding API.
        return [0.0, 1.0, 0.0]

store = CouchbaseMemoryStore(
    name="couchbase",
    connection_string="couchbase://localhost",
    username="Administrator",
    password="password",
    bucket_name="strands_memory",
    distance_metric="L2_SQUARED",
    dimensions=3,
    embedding_provider=Embeddings(),
    writable=True,
    extraction=True,
)
agent = Agent(memory_manager=MemoryManager(stores=[store]))
```

## Run the example

Create the bucket and the Hyperscale Vector Index first; see [`docs/couchbase-setup.md`](../docs/couchbase-setup.md). The example uses a 3-dimension toy embedding, so it needs a 3-dimension index.

```bash
cp .env.example .env
# edit .env for your Couchbase connection
python examples/basic_memory.py
```

## Configuration

Use constructor arguments or environment variables. Constructor arguments take precedence.

| Purpose | Argument | Env var | Default |
| --- | --- | --- | --- |
| Connection string | `connection_string` | `COUCHBASE_CONNECTION_STRING` | `couchbase://localhost` |
| Username | `username` | `COUCHBASE_USERNAME` | none |
| Password | `password` | `COUCHBASE_PASSWORD` | none |
| Bucket | `bucket_name` | `COUCHBASE_BUCKET` | `strands_memory` |
| Scope | `scope_name` | `COUCHBASE_SCOPE` | `_default` |
| Collection | `collection_name` | `COUCHBASE_COLLECTION` | `_default` |
| Vector backend | `vector_backend` | `COUCHBASE_VECTOR_BACKEND` | `hyperscale` |
| Distance metric | `distance_metric` | `COUCHBASE_DISTANCE_METRIC` | `L2_SQUARED` |
| Search-service index | `search_index_name` | `COUCHBASE_SEARCH_INDEX` | `strands-memory-search-index` |
| Namespace | `namespace` | `COUCHBASE_NAMESPACE` | `default` |

With `extraction=True`, call `await memory_manager.flush()` before closing the store so background extraction finishes writing.

## Checks

```bash
ruff format src tests examples
ruff check src tests examples
mypy src
pytest
python -m build
```

Live integration tests are skipped unless `COUCHBASE_INTEGRATION_TESTS=1` and the Couchbase env vars in `.env.example` point at a cluster with a compatible Hyperscale Vector Index.
