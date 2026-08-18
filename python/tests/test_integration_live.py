from __future__ import annotations

import os

import pytest

from strands_couchbase_memory import CouchbaseMemoryStore

pytestmark = pytest.mark.integration


class DeterministicEmbeddingProvider:
    async def embed(self, text: str) -> list[float]:
        vector = [0.0, 0.0, 0.0]
        vector[len(text) % 3] = 1.0
        return vector


@pytest.mark.skipif(
    not os.getenv("COUCHBASE_INTEGRATION_TESTS"),
    reason="Set COUCHBASE_INTEGRATION_TESTS=1 and Couchbase env vars to run live tests.",
)
@pytest.mark.asyncio
async def test_live_couchbase_add_and_search_round_trip() -> None:
    store = CouchbaseMemoryStore(
        name="cb-live",
        embedding_provider=DeterministicEmbeddingProvider(),
        dimensions=3,
        connection_string=os.getenv("COUCHBASE_CONNECTION_STRING", "couchbase://localhost"),
        username=os.getenv("COUCHBASE_USERNAME", "Administrator"),
        password=os.getenv("COUCHBASE_PASSWORD", "password"),
        bucket_name=os.getenv("COUCHBASE_BUCKET", "strands_memory"),
        scope_name=os.getenv("COUCHBASE_SCOPE", "_default"),
        collection_name=os.getenv("COUCHBASE_COLLECTION", "_default"),
        search_index_name=os.getenv("COUCHBASE_SEARCH_INDEX", "strands-memory-index"),
        namespace=os.getenv("COUCHBASE_NAMESPACE", "pytest"),
    )
    try:
        key = await store.add("live integration memory prefers dark mode", {"test": "live"})
        assert key
        results = await store.search("dark mode", {"max_search_results": 3})
        assert any("dark mode" in entry.content for entry in results)
    finally:
        await store.close()
