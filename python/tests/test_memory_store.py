from __future__ import annotations

from typing import Any, cast

import pytest
from couchbase.exceptions import DocumentExistsException
from strands.memory import MemoryManager, ModelExtractor

from strands_couchbase_memory import CouchbaseMemoryStore, MemoryDocument
from strands_couchbase_memory.memory_store import CouchbaseSdkBackend, SearchHit


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

    async def insert_if_absent(self, key: str, document: MemoryDocument) -> bool:
        if key in self.documents:
            return False
        self.documents[key] = document
        return True

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
async def test_add_deduplicates_identical_content_and_keeps_original() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend)

    first = await store.add("The user lives in Denver.", {"source": "session-1"})
    original = dict(backend.documents[first])
    second = await store.add("  The user lives in Denver.\n", {"source": "session-2"})

    assert second == first
    assert first.startswith("memory::default::")
    assert len(backend.documents) == 1
    assert backend.documents[first] == original
    assert backend.documents[first]["metadata"] == {"source": "session-1"}


@pytest.mark.asyncio
async def test_add_does_not_merge_different_content() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend)

    first = await store.add("The user lives in Denver.")
    second = await store.add("the user lives in denver.")

    assert first != second
    assert len(backend.documents) == 2


@pytest.mark.asyncio
async def test_add_with_explicit_id_overwrites() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend)

    await store.add("The user lives in Denver.", {"id": "memory-1"})
    key = await store.add("The user lives in Boulder.", {"memory_id": "memory-1"})

    assert key == "memory-1"
    assert len(backend.documents) == 1
    assert backend.documents[key]["content"] == "The user lives in Boulder."


@pytest.mark.asyncio
async def test_same_content_in_two_namespaces_is_stored_twice() -> None:
    backend = FakeBackend()
    store_a = CouchbaseMemoryStore(
        name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend, namespace="tenant_a"
    )
    store_b = CouchbaseMemoryStore(
        name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend, namespace="tenant_b"
    )

    key_a = await store_a.add("The user lives in Denver.")
    key_b = await store_b.add("The user lives in Denver.")

    assert key_a != key_b
    assert key_a.startswith("memory::tenant_a::")
    assert key_b.startswith("memory::tenant_b::")
    assert len(backend.documents) == 2


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
    assert backend.search_calls[0]["vector_backend"] == "hyperscale"
    assert backend.search_calls[0]["distance_metric"] == "L2_SQUARED"


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


def test_extraction_true_resolves_to_model_extractor() -> None:
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=FakeBackend(),
        extraction=True,
    )

    manager = MemoryManager(stores=[store])

    # Strands only distills facts client-side for stores without `add_messages`;
    # otherwise raw turns are handed to the store as-is.
    [binding] = manager._extraction_stores
    assert isinstance(binding.config.extractor, ModelExtractor)


@pytest.mark.asyncio
async def test_sdk_backend_insert_if_absent_reports_existing_key() -> None:
    class FakeCollection:
        def __init__(self) -> None:
            self.documents: dict[str, Any] = {}

        def insert(self, key: str, document: Any) -> None:
            if key in self.documents:
                raise DocumentExistsException()
            self.documents[key] = document

    class FakeBucket:
        def default_scope(self) -> object:
            return object()

    class FakeCluster:
        def bucket(self, name: str) -> FakeBucket:
            return FakeBucket()

    collection = FakeCollection()
    backend = CouchbaseSdkBackend(
        connection_string="couchbase://localhost",
        username="",
        password="",
        bucket_name="strands_memory",
        scope_name="_default",
        collection_name="_default",
        cluster=cast(Any, FakeCluster()),
        collection=cast(Any, collection),
    )
    document = cast(MemoryDocument, {"content": "first"})

    assert await backend.insert_if_absent("memory::default::abc", document) is True
    assert await backend.insert_if_absent("memory::default::abc", cast(MemoryDocument, {"content": "x"})) is False
    assert collection.documents["memory::default::abc"] == {"content": "first"}
