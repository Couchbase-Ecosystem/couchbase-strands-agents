from __future__ import annotations

from typing import Any

import pytest

from strands_couchbase_memory import CouchbaseMemoryStore, MemoryDocument
from strands_couchbase_memory.memory_store import SearchHit


class FakeEmbeddingProvider:
    async def embed(self, text: str) -> list[float]:
        if "bad" in text:
            return [1.0]
        return [float(len(text) % 3), 1.0, 0.5]


class FakeBackend:
    def __init__(self) -> None:
        self.documents: dict[str, MemoryDocument] = {}
        self.search_calls: list[dict[str, Any]] = []

    async def upsert(self, key: str, document: MemoryDocument) -> None:
        self.documents[key] = document

    async def vector_search(self, **kwargs: Any) -> list[SearchHit]:
        self.search_calls.append(kwargs)
        return [
            SearchHit(
                id="memory::default::1",
                score=0.92,
                content="User prefers dark-mode dashboards.",
                metadata={"category": "preference"},
                namespace=kwargs["namespace"],
            )
        ]

    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_add_stores_document_with_embedding_and_metadata() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=backend,
        dimensions=3,
        namespace="tenant_a",
        writable=True,
    )

    key = await store.add("User prefers dark-mode dashboards.", {"category": "preference", "id": "memory-1"})

    assert key == "memory-1"
    assert backend.documents[key]["content"] == "User prefers dark-mode dashboards."
    assert backend.documents[key]["namespace"] == "tenant_a"
    assert backend.documents[key]["metadata"] == {"category": "preference"}
    assert len(backend.documents[key]["embedding"]) == 3


@pytest.mark.asyncio
async def test_search_maps_hits_to_strands_memory_entries() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=backend,
        dimensions=3,
        namespace="tenant_b",
        max_search_results=7,
    )

    entries = await store.search("dashboard preferences", {"max_search_results": 2})

    assert len(entries) == 1
    assert entries[0].content == "User prefers dark-mode dashboards."
    assert entries[0].metadata == {
        "category": "preference",
        "id": "memory::default::1",
        "score": 0.92,
        "namespace": "tenant_b",
    }
    assert backend.search_calls[0]["limit"] == 2
    assert backend.search_calls[0]["namespace"] == "tenant_b"


@pytest.mark.asyncio
async def test_dimension_mismatch_fails_fast() -> None:
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=FakeBackend(),
        dimensions=3,
    )

    with pytest.raises(ValueError, match="expected 3"):
        await store.add("bad vector")


@pytest.mark.asyncio
async def test_non_writable_store_rejects_add() -> None:
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=FakeBackend(),
        writable=False,
    )

    with pytest.raises(RuntimeError, match="not writable"):
        await store.add("hello")


@pytest.mark.asyncio
async def test_add_messages_preserves_role_metadata() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend)

    keys = await store.add_messages(
        [
            {"role": "user", "content": [{"text": "Remember my timezone is UTC."}]},
            {"role": "assistant", "content": [{"text": "Noted."}]},
        ]
    )

    assert len(keys) == 2
    stored = list(backend.documents.values())
    assert stored[0]["metadata"]["role"] == "user"
    assert stored[1]["metadata"]["role"] == "assistant"
