from __future__ import annotations

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest
from couchbase.exceptions import (
    AuthenticationException,
    SearchIndexNotFoundException,
    UnAmbiguousTimeoutException,
)

import strands_couchbase.memory_store as memory_store
from strands_couchbase.memory_store import CouchbaseSdkBackend, IndexValidation

HYPERSCALE = IndexValidation(
    vector_backend="hyperscale",
    search_index_name="strands-memory-search-index",
    vector_field="embedding",
    namespace_field="namespace",
    distance_metric="L2_SQUARED",
    dimensions=3,
)
SEARCH = replace(HYPERSCALE, vector_backend="search")


def index_row(options: dict[str, Any], index_key: list[str] | None = None) -> dict[str, Any]:
    return {"name": "hv", "index_key": index_key or ["`embedding` VECTOR"], "index_options": options}


def search_index(namespace_field: dict[str, Any], dims: int = 3) -> Any:
    return SimpleNamespace(
        params={
            "mapping": {
                "default_analyzer": "standard",
                "default_mapping": {"enabled": False},
                "types": {
                    "_default._default": {
                        "enabled": True,
                        "properties": {
                            "embedding": {
                                "fields": [
                                    {"name": "embedding", "type": "vector", "dims": dims, "similarity": "l2_norm"}
                                ]
                            },
                            "namespace": {"fields": [{"name": "namespace", "type": "text", **namespace_field}]},
                        },
                    }
                },
            }
        }
    )


class FakeSearchIndexes:
    def __init__(self) -> None:
        self.result: Any = None
        self.error: Exception | None = None

    def get_index(self, name: str) -> Any:
        if self.error is not None:
            raise self.error
        return self.result


class FakeScope:
    def __init__(self) -> None:
        self.indexes = FakeSearchIndexes()

    def search_indexes(self) -> FakeSearchIndexes:
        return self.indexes

    def collection(self, name: str) -> object:
        return object()


class FakeBucket:
    def __init__(self, scope: FakeScope) -> None:
        self._scope = scope

    def default_scope(self) -> FakeScope:
        return self._scope

    def scope(self, name: str) -> FakeScope:
        return self._scope

    def default_collection(self) -> Any:
        return SimpleNamespace(exists=lambda key: SimpleNamespace(exists=False))


class FakeCluster:
    def __init__(self) -> None:
        self.scope = FakeScope()
        self.rows: list[dict[str, Any]] = []
        self.queries: list[tuple[str, Any]] = []
        self.closed = 0

    def bucket(self, name: str) -> FakeBucket:
        return FakeBucket(self.scope)

    def query(self, statement: str, options: Any) -> Any:
        self.queries.append((statement, options))
        return SimpleNamespace(rows=lambda: iter(self.rows))

    def close(self) -> None:
        self.closed += 1


class FakeConnect:
    def __init__(self) -> None:
        self.cluster = FakeCluster()
        self.calls: list[str] = []
        self.errors: list[Exception] = []

    def __call__(self, connection_string: str, *options: Any) -> FakeCluster:
        self.calls.append(connection_string)
        if self.errors:
            raise self.errors.pop(0)
        return self.cluster


@pytest.fixture
def connect(monkeypatch: pytest.MonkeyPatch) -> FakeConnect:
    fake = FakeConnect()
    monkeypatch.setattr(memory_store.Cluster, "connect", fake)
    return fake


def new_backend(collection_name: str = "_default") -> CouchbaseSdkBackend:
    return CouchbaseSdkBackend(
        connection_string="couchbase://example.com",
        username="app",
        password="secret",
        bucket_name="strands_memory",
        scope_name="_default",
        collection_name=collection_name,
    )


async def test_constructor_does_not_connect(connect: FakeConnect) -> None:
    new_backend()

    assert connect.calls == []


async def test_connects_lazily_once_on_first_use(connect: FakeConnect) -> None:
    backend = new_backend()

    await asyncio.gather(backend.initialize(), backend.exists("a"), backend.initialize())
    await backend.initialize()

    assert connect.calls == ["couchbase://example.com"]


async def test_close_without_connecting_does_nothing(connect: FakeConnect) -> None:
    await new_backend().close()

    assert connect.calls == []
    assert connect.cluster.closed == 0


async def test_close_closes_the_cluster_it_opened(connect: FakeConnect) -> None:
    backend = new_backend()
    await backend.initialize()

    await backend.close()

    assert connect.cluster.closed == 1


async def test_close_leaves_a_caller_provided_cluster_open(connect: FakeConnect) -> None:
    cluster = FakeCluster()
    backend = CouchbaseSdkBackend(
        connection_string="couchbase://example.com",
        username="",
        password="",
        bucket_name="strands_memory",
        scope_name="_default",
        collection_name="_default",
        cluster=cluster,  # type: ignore[arg-type]
    )

    await backend.initialize()
    await backend.close()

    assert connect.calls == []
    assert cluster.closed == 0


async def test_reports_authentication_failures_clearly_and_retries_on_the_next_call(connect: FakeConnect) -> None:
    backend = new_backend()
    error = AuthenticationException("authentication failure")
    connect.errors.append(error)

    with pytest.raises(
        RuntimeError, match="Authentication failed connecting to Couchbase at couchbase://example.com as 'app'"
    ) as excinfo:
        await backend.initialize()
    assert excinfo.value.__cause__ is error

    await backend.initialize()
    assert len(connect.calls) == 2


async def test_reports_network_failures_with_the_connection_string(connect: FakeConnect) -> None:
    backend = new_backend()
    error = UnAmbiguousTimeoutException("unambiguous timeout")
    connect.errors.append(error)

    with pytest.raises(RuntimeError, match="Could not connect to Couchbase at couchbase://example.com") as excinfo:
        await backend.initialize()
    assert excinfo.value.__cause__ is error


async def test_only_connects_when_no_validation_is_requested(connect: FakeConnect) -> None:
    backend = new_backend()

    await backend.initialize()

    assert connect.cluster.queries == []


async def test_raises_with_a_setup_link_when_no_vector_index_exists_on_the_field(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.rows = [index_row({}, ["`namespace`"])]

    with pytest.raises(
        RuntimeError,
        match=r"No vector index on `embedding` found for strands_memory\._default\._default"
        r".*couchbase-setup\.md.*validate_on_initialize=False",
    ):
        await backend.initialize(HYPERSCALE)


async def test_handles_default_collection_indexes_without_bucket_id(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.rows = [index_row({"similarity": "l2_squared", "dimension": 3})]

    await backend.initialize(HYPERSCALE)

    statement, options = connect.cluster.queries[0]
    assert "system:indexes" in statement
    assert "i.bucket_id IS MISSING AND i.keyspace_id = $bucket" in statement
    assert "$scope = '_default' AND $collection = '_default'" in statement


async def test_looks_up_named_collections_by_bucket_scope_and_collection(connect: FakeConnect) -> None:
    backend = new_backend("memories")
    connect.cluster.rows = [index_row({"similarity": "l2_squared", "dimension": 3})]

    await backend.initialize(HYPERSCALE)

    _, options = connect.cluster.queries[0]
    assert options["named_parameters"] == {
        "bucket": "strands_memory",
        "scope": "_default",
        "collection": "memories",
    }


@pytest.mark.parametrize(
    ("similarity", "distance_metric"),
    [
        ("euclidean_squared", "L2_SQUARED"),
        ("l2_squared", "EUCLIDEAN_SQUARED"),
        ("euclidean", "L2"),
        ("L2", "EUCLIDEAN"),
        ("cosine", "COSINE"),
        ("dot", "DOT"),
    ],
)
async def test_accepts_an_index_whose_similarity_and_dimension_match_including_aliases(
    connect: FakeConnect, similarity: str, distance_metric: Any
) -> None:
    backend = new_backend()
    connect.cluster.rows = [index_row({"similarity": similarity, "dimension": 3})]

    await backend.initialize(replace(HYPERSCALE, distance_metric=distance_metric))


async def test_raises_when_the_index_similarity_does_not_match_distance_metric(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.rows = [index_row({"similarity": "cosine", "dimension": 3})]

    with pytest.raises(RuntimeError, match="hv: similarity COSINE does not match distance_metric L2_SQUARED"):
        await backend.initialize(HYPERSCALE)


async def test_raises_when_the_index_dimension_does_not_match_dimensions(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.rows = [index_row({"similarity": "l2_squared", "dimension": 1536})]

    with pytest.raises(RuntimeError, match="hv: dimension 1536 does not match dimensions 3"):
        await backend.initialize(HYPERSCALE)


async def test_accepts_when_any_vector_index_matches(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.rows = [
        index_row({"similarity": "cosine", "dimension": 3}),
        index_row({"similarity": "l2_squared", "dimension": 3}),
    ]

    await backend.initialize(HYPERSCALE)


async def test_skips_the_dimension_check_when_dimensions_is_not_set(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.rows = [index_row({"similarity": "l2_squared", "dimension": 1536})]

    await backend.initialize(replace(HYPERSCALE, dimensions=None))


async def test_reports_unreadable_system_indexes(connect: FakeConnect) -> None:
    backend = new_backend()
    error = RuntimeError("User does not have credentials to run SELECT queries on system:indexes")

    def denied(statement: str, options: Any) -> Any:
        raise error

    connect.cluster.query = denied  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="validate_on_initialize=False") as excinfo:
        await backend.initialize(HYPERSCALE)
    assert excinfo.value.__cause__ is error


async def test_raises_when_the_search_index_does_not_exist(connect: FakeConnect) -> None:
    backend = new_backend()
    error = SearchIndexNotFoundException("index not found")
    connect.cluster.scope.indexes.error = error

    with pytest.raises(
        RuntimeError,
        match=r"Search index 'strands-memory-search-index' not found in strands_memory\._default"
        r".*couchbase-setup\.md.*validate_on_initialize=False",
    ) as excinfo:
        await backend.initialize(SEARCH)
    assert excinfo.value.__cause__ is error


async def test_accepts_a_search_index_with_a_keyword_namespace_field_and_matching_dims(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.scope.indexes.result = search_index({"analyzer": "keyword"})

    await backend.initialize(SEARCH)


async def test_rejects_a_search_index_whose_namespace_field_is_not_keyword_analyzed(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.scope.indexes.result = search_index({})

    with pytest.raises(RuntimeError, match="must map 'namespace' as a text field with the keyword analyzer"):
        await backend.initialize(SEARCH)


async def test_rejects_a_search_index_without_a_vector_field(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.scope.indexes.result = search_index({"analyzer": "keyword"})

    with pytest.raises(RuntimeError, match="has no vector field mapped at 'vec'"):
        await backend.initialize(replace(SEARCH, vector_field="vec"))


async def test_rejects_a_search_index_whose_vector_dims_do_not_match(connect: FakeConnect) -> None:
    backend = new_backend()
    connect.cluster.scope.indexes.result = search_index({"analyzer": "keyword"}, 1536)

    with pytest.raises(RuntimeError, match="has dims 1536; expected 3"):
        await backend.initialize(SEARCH)
