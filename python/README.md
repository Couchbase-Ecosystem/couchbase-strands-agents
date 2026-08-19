# Python Couchbase MemoryStore package

`strands-couchbase-memory` implements the Strands Agents `MemoryStore` protocol with Couchbase Vector Search.

## Install for development

```bash
python -m pip install -e '.[dev]'
```

## Minimal usage

```python
from strands.memory import MemoryManager
from strands import Agent
from strands_couchbase_memory import CouchbaseMemoryStore

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

## Checks

```bash
ruff format src tests examples
ruff check src tests examples
mypy src
pytest
python -m build
```

Live integration tests are skipped unless `COUCHBASE_INTEGRATION_TESTS=1` and the Couchbase env vars in `.env.example` point at a cluster with a compatible Hyperscale Vector Index.
