from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

import pytest
from couchbase.exceptions import DocumentExistsException
from strands.memory import MemoryManager, ModelExtractor

import strands_couchbase
from strands_couchbase import CouchbaseMemoryStore, MemoryDocument
from strands_couchbase.memory_store import CouchbaseSdkBackend, IndexValidation, SearchHit


@pytest.fixture(autouse=True)
def clear_couchbase_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # A developer's or CI's COUCHBASE_* variables must not change what these tests see.
    for name in [
        "COUCHBASE_CONNECTION_STRING",
        "COUCHBASE_USERNAME",
        "COUCHBASE_PASSWORD",
        "COUCHBASE_BUCKET",
        "COUCHBASE_SCOPE",
        "COUCHBASE_COLLECTION",
        "COUCHBASE_SEARCH_INDEX",
        "COUCHBASE_VECTOR_BACKEND",
        "COUCHBASE_DISTANCE_METRIC",
        "COUCHBASE_NAMESPACE",
    ]:
        monkeypatch.delenv(name, raising=False)


class FakeEmbeddingProvider:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        if "bad" in text:
            return [1.0]
        return [float(len(text) % 3), 1.0, 0.5]


class FakeBackend:
    def __init__(self) -> None:
        self.documents: dict[str, MemoryDocument] = {}
        self.search_calls: list[dict[str, Any]] = []
        self.initialize_calls: list[IndexValidation | None] = []

    async def initialize(self, validation: IndexValidation | None = None) -> None:
        self.initialize_calls.append(validation)

    async def upsert(self, key: str, document: MemoryDocument) -> None:
        self.documents[key] = document

    async def exists(self, key: str) -> bool:
        return key in self.documents

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
async def test_add_derives_pinned_key_from_content() -> None:
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=FakeBackend())

    key = await store.add("The user lives in Denver.")

    # Must match the TypeScript test. A format change here breaks dedupe against existing documents.
    assert key == "memory::default::e41780f3836366c4355c59adda79e297c41ea63d3c04bbc62a609ffd2bc5ac0a"


@pytest.mark.asyncio
async def test_add_skips_embedding_for_duplicate_content() -> None:
    embedder = FakeEmbeddingProvider()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=embedder, backend=FakeBackend())

    await store.add("The user lives in Denver.")
    await store.add("The user lives in Denver.")

    assert embedder.calls == ["The user lives in Denver."]


@pytest.mark.asyncio
async def test_add_keeps_original_when_insert_races_after_exists_check() -> None:
    class RacingBackend(FakeBackend):
        async def exists(self, key: str) -> bool:
            return False

    backend = RacingBackend()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend)

    first = await store.add("The user lives in Denver.", {"source": "session-1"})
    second = await store.add("The user lives in Denver.", {"source": "session-2"})

    assert second == first
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


class FakeCollection:
    def __init__(self, insert_error: Exception | None = None) -> None:
        self.documents: dict[str, Any] = {}
        self.insert_error = insert_error

    def insert(self, key: str, document: Any) -> None:
        if self.insert_error is not None:
            raise self.insert_error
        if key in self.documents:
            raise DocumentExistsException()
        self.documents[key] = document

    def exists(self, key: str) -> Any:
        return SimpleNamespace(exists=key in self.documents)


def make_sdk_backend(collection: FakeCollection) -> CouchbaseSdkBackend:
    class FakeBucket:
        def default_scope(self) -> object:
            return object()

    class FakeCluster:
        def bucket(self, name: str) -> FakeBucket:
            return FakeBucket()

    return CouchbaseSdkBackend(
        connection_string="couchbase://localhost",
        username="",
        password="",
        bucket_name="strands_memory",
        scope_name="_default",
        collection_name="_default",
        cluster=cast(Any, FakeCluster()),
        collection=cast(Any, collection),
    )


@pytest.mark.asyncio
async def test_sdk_backend_insert_if_absent_reports_existing_key() -> None:
    collection = FakeCollection()
    backend = make_sdk_backend(collection)
    document = cast(MemoryDocument, {"content": "first"})

    assert await backend.insert_if_absent("memory::default::abc", document) is True
    assert await backend.insert_if_absent("memory::default::abc", cast(MemoryDocument, {"content": "x"})) is False
    assert collection.documents["memory::default::abc"] == {"content": "first"}


@pytest.mark.asyncio
async def test_sdk_backend_insert_if_absent_reraises_other_errors() -> None:
    backend = make_sdk_backend(FakeCollection(insert_error=TimeoutError("write timed out")))

    with pytest.raises(TimeoutError, match="write timed out"):
        await backend.insert_if_absent("memory::default::abc", cast(MemoryDocument, {"content": "first"}))


@pytest.mark.asyncio
async def test_sdk_backend_exists_reports_key_presence() -> None:
    collection = FakeCollection()
    backend = make_sdk_backend(collection)

    assert await backend.exists("memory::default::abc") is False
    await backend.insert_if_absent("memory::default::abc", cast(MemoryDocument, {"content": "first"}))
    assert await backend.exists("memory::default::abc") is True


@pytest.mark.asyncio
async def test_sdk_backend_search_prefilters_hyphenated_namespace_with_term_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import strands_couchbase.memory_store as memory_store

    vector_queries: list[Any] = []
    create = memory_store.VectorQuery.create

    def capture(*args: Any, **kwargs: Any) -> Any:
        vector_queries.append(create(*args, **kwargs))
        return vector_queries[-1]

    monkeypatch.setattr(memory_store.VectorQuery, "create", capture)

    class FakeScope:
        def search(self, *args: Any) -> Any:
            return SimpleNamespace(rows=lambda: [])

    backend = make_sdk_backend(FakeCollection())
    backend._scope = cast(Any, FakeScope())

    await backend.vector_search(
        search_index_name="search-index",
        vector_backend="search",
        distance_metric="L2_SQUARED",
        vector_field="embedding",
        query_vector=[1.0, 0.0, 0.0],
        limit=3,
        centroids_to_probe=None,
        num_candidates=None,
        namespace="tenant-a",
        namespace_field="namespace",
        content_field="content",
        metadata_field="metadata",
    )

    # A match query would analyze `tenant-a` into `tenant` + `a` and also match `tenant-b`.
    assert vector_queries[0].prefilter.encodable == {"field": "namespace", "term": "tenant-a"}


@pytest.mark.asyncio
@pytest.mark.parametrize(("centroids_to_probe", "nprobes"), [(16, 16), (None, 8)])
async def test_sdk_backend_hyperscale_search_passes_centroids_to_probe_as_nprobes(
    centroids_to_probe: int | None, nprobes: int
) -> None:
    statements: list[str] = []

    class FakeScope:
        def query(self, statement: str, options: Any) -> Any:
            statements.append(statement)
            return SimpleNamespace(rows=lambda: [])

    backend = make_sdk_backend(FakeCollection())
    backend._scope = cast(Any, FakeScope())
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=backend,
        distance_metric="COSINE",
        centroids_to_probe=centroids_to_probe,
    )

    await store.search("dashboards")

    sql = " ".join(statements[0].split())
    assert f"APPROX_VECTOR_DISTANCE( `embedding`, $query_vector, 'COSINE', {nprobes} )" in sql


@pytest.mark.asyncio
@pytest.mark.parametrize(("num_candidates", "expected"), [(40, 40), (None, 15)])
async def test_sdk_backend_search_service_passes_num_candidates_to_the_vector_query(
    monkeypatch: pytest.MonkeyPatch, num_candidates: int | None, expected: int
) -> None:
    import strands_couchbase.memory_store as memory_store

    vector_queries: list[Any] = []
    create = memory_store.VectorQuery.create

    def capture(*args: Any, **kwargs: Any) -> Any:
        vector_queries.append(create(*args, **kwargs))
        return vector_queries[-1]

    monkeypatch.setattr(memory_store.VectorQuery, "create", capture)

    class FakeScope:
        def search(self, *args: Any) -> Any:
            return SimpleNamespace(rows=lambda: [])

    backend = make_sdk_backend(FakeCollection())
    backend._scope = cast(Any, FakeScope())
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=backend,
        vector_backend="search",
        max_search_results=5,
        num_candidates=num_candidates,
    )

    await store.search("dashboards")

    assert vector_queries[0].num_candidates == expected


def test_public_exports_match_the_contract() -> None:
    assert sorted(strands_couchbase.__all__) == [
        "CouchbaseMemoryStore",
        "CouchbaseMemoryStoreConfig",
        "DistanceMetric",
        "EmbeddingProvider",
        "MemoryDocument",
    ]


@pytest.mark.asyncio
async def test_initialize_validates_the_index_with_the_store_config() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=backend,
        dimensions=3,
        vector_field="vec",
        distance_metric="COSINE",
    )

    await store.initialize()

    assert backend.initialize_calls == [
        IndexValidation(
            vector_backend="hyperscale",
            search_index_name="strands-memory-search-index",
            vector_field="vec",
            namespace_field="namespace",
            distance_metric="COSINE",
            dimensions=3,
        )
    ]


@pytest.mark.asyncio
async def test_initialize_only_connects_when_validate_on_initialize_is_false() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(
        name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend, validate_on_initialize=False
    )

    await store.initialize()

    assert backend.initialize_calls == [None]


@pytest.mark.asyncio
async def test_memory_manager_surfaces_initialize_failures() -> None:
    class BrokenBackend(FakeBackend):
        async def initialize(self, validation: IndexValidation | None = None) -> None:
            raise RuntimeError("No vector index on `embedding`")

    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=BrokenBackend())
    manager = MemoryManager(stores=[store])

    with pytest.raises(RuntimeError, match="No vector index"):
        await manager._init_stores()


@pytest.mark.asyncio
async def test_search_passes_centroids_to_probe_and_num_candidates_separately() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        backend=backend,
        centroids_to_probe=16,
        num_candidates=40,
    )

    await store.search("dashboards")

    assert backend.search_calls[0]["centroids_to_probe"] == 16
    assert backend.search_calls[0]["num_candidates"] == 40


@pytest.mark.asyncio
async def test_search_leaves_centroids_to_probe_and_num_candidates_to_the_backend_defaults() -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend)

    await store.search("dashboards")

    assert backend.search_calls[0]["centroids_to_probe"] is None
    assert backend.search_calls[0]["num_candidates"] is None


@pytest.mark.parametrize("name", ["centroids_to_probe", "num_candidates"])
@pytest.mark.parametrize("value", [0, -1, 1.5, True, "8"])
def test_rejects_non_positive_integer_options(name: str, value: Any) -> None:
    config: dict[str, Any] = {name: value}
    with pytest.raises(ValueError, match=f"{name} must be a positive integer"):
        CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=FakeBackend(), **config)


def test_rejects_an_unknown_distance_metric_in_the_constructor() -> None:
    with pytest.raises(
        ValueError,
        match=r"distance_metric must be one of COSINE, DOT, L2, EUCLIDEAN, L2_SQUARED, EUCLIDEAN_SQUARED; "
        r"got 'HAMMING'",
    ):
        CouchbaseMemoryStore(
            name="cb",
            embedding_provider=FakeEmbeddingProvider(),
            backend=FakeBackend(),
            distance_metric=cast(Any, "HAMMING"),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "expected"), [("cosine", "COSINE"), (" euclidean_squared ", "EUCLIDEAN_SQUARED")])
async def test_normalizes_distance_metric(value: str, expected: str) -> None:
    backend = FakeBackend()
    store = CouchbaseMemoryStore(
        name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend, distance_metric=cast(Any, value)
    )

    await store.search("dashboards")

    assert backend.search_calls[0]["distance_metric"] == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("value", "expected"), [("HYPERSCALE", "hyperscale"), (" Search ", "search")])
async def test_normalizes_couchbase_vector_backend_env(
    monkeypatch: pytest.MonkeyPatch, value: str, expected: str
) -> None:
    monkeypatch.setenv("COUCHBASE_VECTOR_BACKEND", value)
    backend = FakeBackend()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend)

    await store.search("dashboards")

    assert backend.search_calls[0]["vector_backend"] == expected


def test_rejects_an_unknown_couchbase_vector_backend_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COUCHBASE_VECTOR_BACKEND", "fts")
    with pytest.raises(ValueError, match="vector_backend must be 'hyperscale' or 'search'; got 'fts'"):
        CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=FakeBackend())


@pytest.mark.asyncio
async def test_normalizes_couchbase_distance_metric_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COUCHBASE_DISTANCE_METRIC", "cosine")
    backend = FakeBackend()
    store = CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=backend)

    await store.search("dashboards")

    assert backend.search_calls[0]["distance_metric"] == "COSINE"


def test_rejects_an_unknown_couchbase_distance_metric_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COUCHBASE_DISTANCE_METRIC", "manhattan")
    with pytest.raises(ValueError, match="distance_metric must be one of"):
        CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), backend=FakeBackend())


@pytest.mark.parametrize(
    "credentials",
    [{}, {"username": "app"}, {"password": "secret"}, {"username": "", "password": "secret"}],
)
def test_requires_credentials_when_the_store_owns_the_connection(credentials: dict[str, Any]) -> None:
    with pytest.raises(ValueError, match="Couchbase credentials are required"):
        CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), **credentials)


def test_treats_empty_credential_env_vars_as_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COUCHBASE_USERNAME", "")
    monkeypatch.setenv("COUCHBASE_PASSWORD", "")
    with pytest.raises(ValueError, match="Couchbase credentials are required"):
        CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider())


def test_reads_credentials_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COUCHBASE_USERNAME", "app")
    monkeypatch.setenv("COUCHBASE_PASSWORD", "secret")

    CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider())


def test_does_not_require_credentials_with_a_caller_provided_cluster() -> None:
    class FakeBucket:
        def default_scope(self) -> object:
            return object()

        def default_collection(self) -> object:
            return object()

    class FakeCluster:
        def bucket(self, name: str) -> FakeBucket:
            return FakeBucket()

    CouchbaseMemoryStore(name="cb", embedding_provider=FakeEmbeddingProvider(), cluster=cast(Any, FakeCluster()))


@pytest.mark.asyncio
async def test_constructor_makes_no_network_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    import socket

    import strands_couchbase.memory_store as memory_store

    connects: list[Any] = []

    def no_connect(*args: Any, **kwargs: Any) -> Any:
        connects.append(args)
        raise AssertionError("Cluster.connect must not run in the constructor")

    def no_socket(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the constructor must not open sockets")

    monkeypatch.setattr(memory_store.Cluster, "connect", no_connect)
    monkeypatch.setattr(socket, "create_connection", no_socket)
    monkeypatch.setattr(socket.socket, "connect", no_socket)

    store = CouchbaseMemoryStore(
        name="cb",
        embedding_provider=FakeEmbeddingProvider(),
        connection_string="couchbase://127.0.0.1:1",
        username="app",
        password="secret",
    )
    await store.close()

    assert connects == []
