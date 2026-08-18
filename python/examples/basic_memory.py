"""Runnable Python example for CouchbaseMemoryStore.

This example uses a deterministic toy embedding provider so it can run without
an embedding API key. Replace DemoEmbeddingProvider with your production
embedding provider before using real data.
"""

from __future__ import annotations

import asyncio
import os

from strands_couchbase_memory import CouchbaseMemoryStore


class DemoEmbeddingProvider:
    """Tiny deterministic embedding provider for demos and smoke tests."""

    async def embed(self, text: str) -> list[float]:
        vector = [0.0, 0.0, 0.0]
        vector[len(text) % 3] = 1.0
        return vector


async def main() -> None:
    store = CouchbaseMemoryStore(
        name="couchbase-demo",
        connection_string=os.getenv("COUCHBASE_CONNECTION_STRING", "couchbase://localhost"),
        username=os.getenv("COUCHBASE_USERNAME", "Administrator"),
        password=os.getenv("COUCHBASE_PASSWORD", "password"),
        bucket_name=os.getenv("COUCHBASE_BUCKET", "strands_memory"),
        scope_name=os.getenv("COUCHBASE_SCOPE", "_default"),
        collection_name=os.getenv("COUCHBASE_COLLECTION", "_default"),
        search_index_name=os.getenv("COUCHBASE_SEARCH_INDEX", "strands-memory-index"),
        namespace=os.getenv("COUCHBASE_NAMESPACE", "demo"),
        embedding_provider=DemoEmbeddingProvider(),
        dimensions=3,
        writable=True,
    )
    try:
        key = await store.add("Alex prefers dark-mode dashboards and async standups.", {"category": "preference"})
        print(f"stored key: {key}")
        print("Search indexes update asynchronously; wait for indexing before expecting a hit.")
        entries = await store.search("How does Alex like to work?", {"max_search_results": 3})
        for entry in entries:
            print(f"hit: {entry.content} metadata={entry.metadata}")
    finally:
        await store.close()


if __name__ == "__main__":
    asyncio.run(main())
