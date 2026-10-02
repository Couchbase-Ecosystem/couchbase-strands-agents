"""Strands MemoryStore implementation backed by Couchbase Hyperscale Vector Search."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Protocol, TypedDict, cast

import couchbase.search as couchbase_search
from couchbase.auth import PasswordAuthenticator
from couchbase.cluster import Cluster, QueryScanConsistency
from couchbase.collection import Collection
from couchbase.exceptions import (
    AuthenticationException,
    BucketNotFoundException,
    DocumentExistsException,
    SearchIndexNotFoundException,
)
from couchbase.options import ClusterOptions, QueryOptions, SearchOptions
from couchbase.vector_search import VectorQuery, VectorSearch
from strands.memory import MemoryEntry, MemoryStore, MemoryStoreConfig
from strands.memory import SearchOptions as StrandsSearchOptions
from typing_extensions import Unpack

DEFAULT_NAME = "couchbase"
DEFAULT_DESCRIPTION = "Long-term semantic memory stored in Couchbase Hyperscale Vector Search."
DEFAULT_CONNECTION_STRING = "couchbase://localhost"
DEFAULT_BUCKET = "strands_memory"
DEFAULT_SCOPE = "_default"
DEFAULT_COLLECTION = "_default"
DEFAULT_SEARCH_INDEX = "strands-memory-search-index"
DEFAULT_VECTOR_BACKEND = "hyperscale"
DEFAULT_DISTANCE_METRIC = "L2_SQUARED"
DEFAULT_CONTENT_FIELD = "content"
DEFAULT_VECTOR_FIELD = "embedding"
DEFAULT_METADATA_FIELD = "metadata"
DEFAULT_NAMESPACE_FIELD = "namespace"
DEFAULT_NAMESPACE = "default"
DEFAULT_MAX_RESULTS = 5
DEFAULT_CENTROIDS_TO_PROBE = 8
SETUP_DOCS_URL = "https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/couchbase-setup.md"

JsonMap = dict[str, Any]
EmbeddingCallable = Callable[[str], list[float] | Awaitable[list[float]]]

DistanceMetric = Literal["COSINE", "DOT", "L2", "EUCLIDEAN", "L2_SQUARED", "EUCLIDEAN_SQUARED"]
"""Distance metrics accepted by SQL++ ``APPROX_VECTOR_DISTANCE``. Must match the vector index ``similarity``."""

DISTANCE_METRICS: tuple[DistanceMetric, ...] = ("COSINE", "DOT", "L2", "EUCLIDEAN", "L2_SQUARED", "EUCLIDEAN_SQUARED")


class EmbeddingProvider(Protocol):
    """Provider that converts text into an embedding vector.

    The connector accepts any object with this method, so applications can use
    OpenAI, Bedrock, Cohere, local sentence-transformers, Capella Model Services,
    or any other embedding service without coupling this package to a vendor.
    """

    def embed(self, text: str) -> list[float] | Awaitable[list[float]]:
        """Return an embedding vector for text."""
        ...


class CouchbaseMemoryStoreConfig(MemoryStoreConfig, total=False):
    """Configuration for :class:`CouchbaseMemoryStore`."""

    connection_string: str
    username: str
    password: str
    bucket_name: str
    scope_name: str
    collection_name: str
    search_index_name: str
    vector_backend: str
    distance_metric: DistanceMetric
    """Must match the Hyperscale index ``similarity``. Only used by the ``hyperscale`` backend."""
    content_field: str
    vector_field: str
    metadata_field: str
    namespace_field: str
    namespace: str
    dimensions: int
    embedding_provider: EmbeddingProvider | EmbeddingCallable
    cluster: Cluster
    collection: Collection
    backend: CouchbaseBackend
    """Internal test seam; not part of the public API."""
    centroids_to_probe: int
    """Hyperscale only: centroids to probe (``nprobes`` in ``APPROX_VECTOR_DISTANCE``). Default 8."""
    num_candidates: int
    """Search only: nearest-neighbour candidates for ``VectorQuery``. Default ``3 * limit``."""
    validate_on_initialize: bool
    """Check the vector index in ``initialize()``. Default True. Set to False when the credentials can't read
    ``system:indexes`` (Hyperscale) or the Search index definition; ``initialize()`` still connects."""


class MemoryDocument(TypedDict):
    """Stored Couchbase memory document shape."""

    content: str
    embedding: list[float]
    metadata: JsonMap
    namespace: str
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class SearchHit:
    """Backend-neutral search hit returned by CouchbaseBackend."""

    id: str
    score: float | None
    content: str
    metadata: JsonMap
    namespace: str | None = None


@dataclass(frozen=True)
class IndexValidation:
    """What ``initialize()`` checks against the vector index. Internal."""

    vector_backend: str
    search_index_name: str
    vector_field: str
    namespace_field: str
    distance_metric: DistanceMetric
    dimensions: int | None = None


class CouchbaseBackend(Protocol):
    """Storage seam used by CouchbaseMemoryStore and swapped for fakes in tests.

    Internal, not part of the public API: it may change in any release.
    """

    async def initialize(self, validation: IndexValidation | None = None) -> None:
        """Connect and, when validation is given, check that a matching vector index exists."""
        ...

    async def upsert(self, key: str, document: MemoryDocument) -> None:
        """Store or replace a memory document."""
        ...

    async def exists(self, key: str) -> bool:
        """Return whether a document with this key exists."""
        ...

    async def insert_if_absent(self, key: str, document: MemoryDocument) -> bool:
        """Store a memory document unless the key exists. Return False if it already existed."""
        ...

    async def vector_search(
        self,
        *,
        search_index_name: str,
        vector_backend: str,
        distance_metric: str,
        vector_field: str,
        query_vector: list[float],
        limit: int,
        centroids_to_probe: int | None,
        num_candidates: int | None,
        namespace: str,
        namespace_field: str,
        content_field: str,
        metadata_field: str,
    ) -> list[SearchHit]:
        """Run a vector search and return normalized hits."""
        ...

    async def close(self) -> None:
        """Close network resources if the backend owns them."""
        ...


class CouchbaseSdkBackend:
    """Couchbase Python SDK adapter. Internal, not part of the public API.

    The default recall path uses Hyperscale Vector Indexes through SQL++
    `APPROX_VECTOR_DISTANCE`, which is Couchbase's preferred high-performance
    vector-search path. The older Search-service `VectorQuery` API remains
    available by setting `vector_backend="search"` for deployments that still
    use Search Vector Indexes.

    Without a caller-provided cluster, nothing connects in the constructor: the first
    ``initialize``, ``add``, ``search`` or ``close`` call connects, once.
    """

    def __init__(
        self,
        *,
        connection_string: str,
        username: str,
        password: str,
        bucket_name: str,
        scope_name: str,
        collection_name: str,
        cluster: Cluster | None = None,
        collection: Collection | None = None,
    ) -> None:
        self._connection_string = connection_string
        self._username = username
        self._password = password
        self._bucket_name = bucket_name
        self._scope_name = scope_name
        self._collection_name = collection_name
        self._owns_cluster = cluster is None
        self._configured_collection = collection
        self._connect_lock = asyncio.Lock()
        self._cluster: Cluster | None = None
        self._scope: Any = None
        self._collection: Any = collection
        if cluster is not None:
            self._cluster = cluster
            self._resolve_bucket_handles(cluster)

    async def initialize(self, validation: IndexValidation | None = None) -> None:
        await self._get_cluster()
        if validation is None:
            return
        if validation.vector_backend == "search":
            await self._validate_search_index(validation)
        else:
            await self._validate_hyperscale_index(validation)

    async def upsert(self, key: str, document: MemoryDocument) -> None:
        collection = await self._get_collection()
        await asyncio.to_thread(collection.upsert, key, document)

    async def exists(self, key: str) -> bool:
        collection = await self._get_collection()
        result = await asyncio.to_thread(collection.exists, key)
        return bool(result.exists)

    async def insert_if_absent(self, key: str, document: MemoryDocument) -> bool:
        collection = await self._get_collection()
        try:
            await asyncio.to_thread(collection.insert, key, document)
        except DocumentExistsException:
            return False
        return True

    async def vector_search(
        self,
        *,
        search_index_name: str,
        vector_backend: str,
        distance_metric: str,
        vector_field: str,
        query_vector: list[float],
        limit: int,
        centroids_to_probe: int | None,
        num_candidates: int | None,
        namespace: str,
        namespace_field: str,
        content_field: str,
        metadata_field: str,
    ) -> list[SearchHit]:
        if vector_backend == "search":
            return await self._search_service_vector_search(
                search_index_name=search_index_name,
                vector_field=vector_field,
                query_vector=query_vector,
                limit=limit,
                num_candidates=num_candidates,
                namespace=namespace,
                namespace_field=namespace_field,
                content_field=content_field,
                metadata_field=metadata_field,
            )
        if vector_backend != "hyperscale":
            raise ValueError("vector_backend must be 'hyperscale' or 'search'")
        return await self._hyperscale_vector_search(
            vector_field=vector_field,
            query_vector=query_vector,
            limit=limit,
            namespace=namespace,
            namespace_field=namespace_field,
            content_field=content_field,
            metadata_field=metadata_field,
            centroids_to_probe=centroids_to_probe,
            distance_metric=distance_metric,
        )

    async def close(self) -> None:
        # Holding the lock waits out a connect that is still running, so its cluster gets closed too.
        async with self._connect_lock:
            cluster = self._cluster
        if self._owns_cluster and cluster is not None:
            close = getattr(cluster, "close", None)
            if close is not None:
                await asyncio.to_thread(close)

    async def _hyperscale_vector_search(
        self,
        *,
        vector_field: str,
        query_vector: list[float],
        limit: int,
        namespace: str,
        namespace_field: str,
        content_field: str,
        metadata_field: str,
        centroids_to_probe: int | None,
        distance_metric: str,
    ) -> list[SearchHit]:
        scope = await self._get_scope()

        def _search() -> list[SearchHit]:
            collection = _quote_identifier(self._collection_name)
            content_expr = _quote_path(content_field)
            metadata_expr = _quote_path(metadata_field)
            namespace_expr = _quote_path(namespace_field)
            vector_expr = _quote_path(vector_field)
            distance_metric_literal = _quote_string_literal(_validate_distance_metric(distance_metric))
            nprobes = int(centroids_to_probe or DEFAULT_CENTROIDS_TO_PROBE)
            statement = f"""
                SELECT META().id AS id,
                       {content_expr} AS content,
                       {metadata_expr} AS metadata,
                       {namespace_expr} AS namespace_value,
                       APPROX_VECTOR_DISTANCE(
                           {vector_expr},
                           $query_vector,
                           {distance_metric_literal},
                           {nprobes}
                       ) AS distance
                FROM {collection}
                WHERE {namespace_expr} = $namespace
                ORDER BY distance
                LIMIT {int(limit)}
            """
            result = scope.query(
                statement,
                QueryOptions(
                    named_parameters={
                        "query_vector": query_vector,
                        "namespace": namespace,
                    },
                    scan_consistency=QueryScanConsistency.REQUEST_PLUS,
                ),
            )
            hits: list[SearchHit] = []
            for row in result.rows():
                metadata = row.get("metadata") or {}
                if not isinstance(metadata, dict):
                    metadata = {"value": metadata}
                hits.append(
                    SearchHit(
                        id=str(row.get("id", "")),
                        score=cast(float | None, row.get("distance")),
                        content=str(row.get("content", "")),
                        metadata=metadata,
                        namespace=cast(str | None, row.get("namespace_value")),
                    )
                )
            return hits

        return await asyncio.to_thread(_search)

    async def _search_service_vector_search(
        self,
        *,
        search_index_name: str,
        vector_field: str,
        query_vector: list[float],
        limit: int,
        num_candidates: int | None,
        namespace: str,
        namespace_field: str,
        content_field: str,
        metadata_field: str,
    ) -> list[SearchHit]:
        scope = await self._get_scope()

        def _search() -> list[SearchHit]:
            # A term query matches the namespace exactly. A match query would analyze it, so with the standard
            # analyzer `tenant-a` would also match `tenant-b`. The namespace field must use the keyword analyzer.
            prefilter = couchbase_search.TermQuery(namespace, field=namespace_field)
            vector_query = VectorQuery.create(
                vector_field,
                query_vector,
                num_candidates=num_candidates or max(limit * 3, limit),
                prefilter=prefilter,
            )
            vector_search = VectorSearch.from_vector_query(vector_query)
            request = couchbase_search.SearchRequest.create(vector_search)
            result = scope.search(
                search_index_name,
                request,
                SearchOptions(limit=limit, fields=[content_field, metadata_field, namespace_field]),
            )
            hits: list[SearchHit] = []
            for row in result.rows():
                fields = dict(getattr(row, "fields", None) or {})
                metadata = fields.get(metadata_field) or {}
                if not isinstance(metadata, dict):
                    metadata = {"value": metadata}
                content = fields.get(content_field, "")
                hits.append(
                    SearchHit(
                        id=str(getattr(row, "id", "")),
                        score=cast(float | None, getattr(row, "score", None)),
                        content=str(content),
                        metadata=metadata,
                        namespace=cast(str | None, fields.get(namespace_field)),
                    )
                )
            return hits

        return await asyncio.to_thread(_search)

    async def _validate_hyperscale_index(self, validation: IndexValidation) -> None:
        cluster = await self._get_cluster()
        keyspace = f"{self._bucket_name}.{self._scope_name}.{self._collection_name}"
        # Indexes on _default._default are listed with keyspace_id = bucket and no bucket_id.
        statement = """
            SELECT i.name, i.index_key, i.`with` AS index_options
            FROM system:indexes AS i
            WHERE i.`using` = 'gsi'
              AND ((i.bucket_id = $bucket AND i.scope_id = $scope AND i.keyspace_id = $collection)
                OR (i.bucket_id IS MISSING AND i.keyspace_id = $bucket
                    AND $scope = '_default' AND $collection = '_default'))
        """
        parameters = {"bucket": self._bucket_name, "scope": self._scope_name, "collection": self._collection_name}
        try:
            rows = await asyncio.to_thread(
                lambda: list(cluster.query(statement, QueryOptions(named_parameters=parameters)).rows())
            )
        except Exception as err:
            raise RuntimeError(
                f"Could not read system:indexes to check the vector index for {keyspace}: {err}. "
                "Set validate_on_initialize=False if these credentials cannot read system:indexes."
            ) from err
        vector_key = f"{_quote_path(validation.vector_field)} VECTOR".upper()
        candidates = [
            row
            for row in rows
            if isinstance(row.get("index_key"), list)
            and any(isinstance(key, str) and key.upper() == vector_key for key in row["index_key"])
        ]
        if not candidates:
            raise RuntimeError(
                f"No vector index on `{validation.vector_field}` found for {keyspace} in system:indexes. "
                f"Create a Hyperscale Vector Index ({SETUP_DOCS_URL}), or set validate_on_initialize=False "
                "if these credentials cannot read system:indexes."
            )
        metric = _canonical_metric(validation.distance_metric)
        problems: list[str] = []
        for row in candidates:
            options = row.get("index_options")
            if not isinstance(options, dict):
                options = {}
            raw_similarity = options.get("similarity")
            similarity = raw_similarity.upper() if isinstance(raw_similarity, str) else None
            raw_dimension = options.get("dimension")
            dimension = raw_dimension if type(raw_dimension) is int else None
            row_problems: list[str] = []
            if similarity is not None and _canonical_metric(similarity) != metric:
                row_problems.append(
                    f"similarity {similarity} does not match distance_metric {validation.distance_metric}"
                )
            if validation.dimensions is not None and dimension is not None and dimension != validation.dimensions:
                row_problems.append(f"dimension {dimension} does not match dimensions {validation.dimensions}")
            if not row_problems:
                return
            problems.append(f"{row.get('name')}: {'; '.join(row_problems)}")
        raise RuntimeError(
            f"No vector index on `{validation.vector_field}` for {keyspace} matches the store config "
            f"({' | '.join(problems)}). See {SETUP_DOCS_URL}."
        )

    async def _validate_search_index(self, validation: IndexValidation) -> None:
        scope = await self._get_scope()
        name = validation.search_index_name
        scope_collection = f"{self._scope_name}.{self._collection_name}"
        try:
            index = await asyncio.to_thread(lambda: scope.search_indexes().get_index(name))
        except SearchIndexNotFoundException as err:
            raise RuntimeError(
                f"Search index '{name}' not found in {self._bucket_name}.{self._scope_name}. "
                f"Create it ({SETUP_DOCS_URL}), or set validate_on_initialize=False if these credentials "
                "cannot read Search index definitions."
            ) from err
        except Exception as err:
            raise RuntimeError(
                f"Could not read Search index '{name}' in {self._bucket_name}.{self._scope_name}: {err}. "
                "Set validate_on_initialize=False if these credentials cannot read Search index definitions."
            ) from err
        params = getattr(index, "params", None)
        mapping = params.get("mapping") if isinstance(params, dict) else None
        if not isinstance(mapping, dict):
            mapping = {}
        type_mappings = _search_type_mappings(mapping, scope_collection)

        vector_fields = [
            field
            for type_mapping in type_mappings
            for field in _find_search_fields(type_mapping, validation.vector_field)
            if field.get("type") in ("vector", "vector_base64")
        ]
        if not vector_fields:
            raise RuntimeError(
                f"Search index '{name}' has no vector field mapped at '{validation.vector_field}' for "
                f"{scope_collection}. See {SETUP_DOCS_URL}."
            )
        if validation.dimensions is not None and not any(
            field.get("dims") == validation.dimensions for field in vector_fields
        ):
            dims = ", ".join(str(field.get("dims")) for field in vector_fields)
            raise RuntimeError(
                f"Search index '{name}' vector field '{validation.vector_field}' has dims {dims}; "
                f"expected {validation.dimensions}. See {SETUP_DOCS_URL}."
            )

        # The namespace prefilter is an exact term query, so the field must not be split into words.
        keyword_mapped = any(
            (field.get("analyzer") or type_mapping.get("default_analyzer") or mapping.get("default_analyzer"))
            == "keyword"
            for type_mapping in type_mappings
            for field in _find_search_fields(type_mapping, validation.namespace_field)
            if field.get("type") in (None, "text")
        )
        if not keyword_mapped:
            raise RuntimeError(
                f"Search index '{name}' must map '{validation.namespace_field}' as a text field with the keyword "
                f"analyzer so namespaces match exactly. See {SETUP_DOCS_URL}."
            )

    async def _get_cluster(self) -> Cluster:
        if self._cluster is not None:
            return self._cluster
        async with self._connect_lock:
            if self._cluster is None:
                cluster: Cluster | None = None
                try:
                    cluster = await asyncio.to_thread(
                        Cluster.connect,
                        self._connection_string,
                        ClusterOptions(PasswordAuthenticator(self._username, self._password)),
                    )
                    # The SDK opens the bucket here, so a missing bucket fails now rather than on first use.
                    self._resolve_bucket_handles(cluster)
                except BucketNotFoundException as err:
                    await _close_quietly(cluster)
                    raise RuntimeError(
                        f"Bucket '{self._bucket_name}' not found on Couchbase at {self._connection_string}. "
                        f"Create it or fix bucket_name. See {SETUP_DOCS_URL}."
                    ) from err
                except Exception as err:
                    await _close_quietly(cluster)
                    raise _connection_error(self._connection_string, self._username, err) from err
                self._cluster = cluster
        return self._cluster

    async def _get_scope(self) -> Any:
        await self._get_cluster()
        return self._scope

    async def _get_collection(self) -> Any:
        if self._collection is None:
            await self._get_cluster()
        return self._collection

    def _resolve_bucket_handles(self, cluster: Cluster) -> None:
        bucket = cluster.bucket(self._bucket_name)
        self._scope = bucket.default_scope() if self._scope_name == DEFAULT_SCOPE else bucket.scope(self._scope_name)
        self._collection = self._configured_collection or (
            bucket.default_collection()
            if self._collection_name == DEFAULT_COLLECTION
            else self._scope.collection(self._collection_name)
        )


class CouchbaseMemoryStore(MemoryStore):
    """Couchbase Hyperscale Vector Search implementation of the Strands MemoryStore protocol.

    The store deliberately does not implement ``add_messages``. Strands treats any
    store with ``add_messages`` as doing server-side extraction and skips its
    ``ModelExtractor``, which would save every raw turn. Leaving it out makes
    ``extraction=True`` distill facts with the agent's model and store them via ``add``.
    """

    name: str
    description: str | None
    max_search_results: int | None
    writable: bool
    extraction: Any

    def __init__(self, **store_config: Unpack[CouchbaseMemoryStoreConfig]) -> None:
        self.name = store_config.get("name", DEFAULT_NAME)
        self.description = store_config.get("description", DEFAULT_DESCRIPTION)
        self.max_search_results = store_config.get("max_search_results", DEFAULT_MAX_RESULTS)
        self.writable = store_config.get("writable", True)
        self.extraction = store_config.get("extraction")
        self.content_field = store_config.get("content_field", DEFAULT_CONTENT_FIELD)
        self.vector_field = store_config.get("vector_field", DEFAULT_VECTOR_FIELD)
        self.metadata_field = store_config.get("metadata_field", DEFAULT_METADATA_FIELD)
        self.namespace_field = store_config.get("namespace_field", DEFAULT_NAMESPACE_FIELD)
        self.namespace = store_config.get("namespace") or os.getenv("COUCHBASE_NAMESPACE") or DEFAULT_NAMESPACE
        self.vector_backend = (
            (store_config.get("vector_backend") or os.getenv("COUCHBASE_VECTOR_BACKEND") or DEFAULT_VECTOR_BACKEND)
            .strip()
            .lower()
        )
        if self.vector_backend not in {"hyperscale", "search"}:
            raise ValueError(f"vector_backend must be 'hyperscale' or 'search'; got '{self.vector_backend}'")
        self.distance_metric: DistanceMetric = _validate_distance_metric(
            store_config.get("distance_metric") or os.getenv("COUCHBASE_DISTANCE_METRIC") or DEFAULT_DISTANCE_METRIC
        )
        self.search_index_name = (
            store_config.get("search_index_name") or os.getenv("COUCHBASE_SEARCH_INDEX") or DEFAULT_SEARCH_INDEX
        )
        self.dimensions = store_config.get("dimensions")
        self.centroids_to_probe = _validate_positive_integer(
            "centroids_to_probe", store_config.get("centroids_to_probe")
        )
        self.num_candidates = _validate_positive_integer("num_candidates", store_config.get("num_candidates"))
        self.validate_on_initialize = store_config.get("validate_on_initialize", True)
        provider = store_config.get("embedding_provider")
        if provider is None:
            raise ValueError("embedding_provider is required")
        self.embedding_provider = provider
        backend = store_config.get("backend")
        self._backend = backend or self._create_sdk_backend(store_config)

    async def initialize(self) -> None:
        """Connect to Couchbase and check the vector index.

        Strands ``MemoryManager`` awaits this during agent setup, so a missing index, a config
        mismatch or bad credentials fail there instead of every search failing later and being
        swallowed. Call it yourself when using the store without ``MemoryManager``. With
        ``validate_on_initialize=False`` it only connects.
        """
        if not self.validate_on_initialize:
            await self._backend.initialize()
            return
        await self._backend.initialize(
            IndexValidation(
                vector_backend=self.vector_backend,
                search_index_name=self.search_index_name,
                vector_field=self.vector_field,
                namespace_field=self.namespace_field,
                distance_metric=self.distance_metric,
                dimensions=self.dimensions,
            )
        )

    @staticmethod
    def _create_sdk_backend(store_config: CouchbaseMemoryStoreConfig) -> CouchbaseSdkBackend:
        username = store_config.get("username") or os.getenv("COUCHBASE_USERNAME") or ""
        password = store_config.get("password") or os.getenv("COUCHBASE_PASSWORD") or ""
        cluster = store_config.get("cluster")
        # With a caller-provided cluster the credentials were already used to connect it.
        if cluster is None and (not username or not password):
            raise ValueError(
                "Couchbase credentials are required: pass username and password, or set COUCHBASE_USERNAME and "
                "COUCHBASE_PASSWORD, or pass a connected cluster."
            )
        return CouchbaseSdkBackend(
            connection_string=store_config.get("connection_string")
            or os.getenv("COUCHBASE_CONNECTION_STRING")
            or DEFAULT_CONNECTION_STRING,
            username=username,
            password=password,
            bucket_name=store_config.get("bucket_name") or os.getenv("COUCHBASE_BUCKET") or DEFAULT_BUCKET,
            scope_name=store_config.get("scope_name") or os.getenv("COUCHBASE_SCOPE") or DEFAULT_SCOPE,
            collection_name=store_config.get("collection_name")
            or os.getenv("COUCHBASE_COLLECTION")
            or DEFAULT_COLLECTION,
            cluster=cluster,
            collection=store_config.get("collection"),
        )

    async def search(self, query: str, options: StrandsSearchOptions | None = None) -> list[MemoryEntry]:
        """Search memories by vector similarity, ordered by Couchbase relevance."""
        if not query.strip():
            return []
        limit = (options or {}).get("max_search_results") or self.max_search_results or DEFAULT_MAX_RESULTS
        query_vector = await self._embed(query)
        hits = await self._backend.vector_search(
            search_index_name=self.search_index_name,
            vector_backend=self.vector_backend,
            distance_metric=self.distance_metric,
            vector_field=self.vector_field,
            query_vector=query_vector,
            limit=limit,
            centroids_to_probe=self.centroids_to_probe,
            num_candidates=self.num_candidates,
            namespace=self.namespace,
            namespace_field=self.namespace_field,
            content_field=self.content_field,
            metadata_field=self.metadata_field,
        )
        entries: list[MemoryEntry] = []
        for hit in hits:
            metadata = dict(hit.metadata)
            metadata.setdefault("id", hit.id)
            metadata.setdefault("score", hit.score)
            metadata.setdefault("namespace", hit.namespace or self.namespace)
            entries.append(MemoryEntry(content=hit.content, metadata=metadata))
        return entries

    async def add(self, content: str, metadata: Mapping[str, Any] | None = None) -> str:
        """Store one memory document and return its Couchbase document key.

        Without ``metadata["id"]`` or ``metadata["memory_id"]``, the key is derived from the
        trimmed content, so a repeat of the same fact returns the existing key and keeps the
        original document. With an explicit id, the document is overwritten.
        """
        if not self.writable:
            raise RuntimeError(f"Memory store {self.name!r} is not writable")
        if not content.strip():
            raise ValueError("content must not be empty")
        clean_metadata = dict(metadata or {})
        explicit_id = clean_metadata.pop("id", clean_metadata.pop("memory_id", None))
        key = str(explicit_id) if explicit_id is not None else self._content_key(content)
        # Skip the embedding call for a repeated fact; insert_if_absent below stays the race-safe guard.
        if explicit_id is None and await self._backend.exists(key):
            return key
        vector = await self._embed(content)
        now = datetime.now(timezone.utc).isoformat()
        document: MemoryDocument = {
            "content": content,
            "embedding": vector,
            "metadata": clean_metadata,
            "namespace": self.namespace,
            "created_at": now,
            "updated_at": now,
        }
        if explicit_id is not None:
            await self._backend.upsert(key, document)
        else:
            await self._backend.insert_if_absent(key, document)
        return key

    async def close(self) -> None:
        """Close the Couchbase connection if the store opened it.

        With background extraction (``extraction=True``), call ``await memory_manager.flush()``
        first: extraction writes still running when the connection closes fail, and Strands only
        logs ``memory extraction failed``. Closing a store that never connected does nothing.
        """
        await self._backend.close()

    def _content_key(self, content: str) -> str:
        # str.strip() differs slightly from JavaScript's String.prototype.trim(): JS also trims a
        # BOM (\ufeff) and Python also trims \x1c-\x1f. Extracted facts won't realistically
        # contain these, so keys match across both SDKs in practice.
        digest = hashlib.sha256(content.strip().encode("utf-8")).hexdigest()
        return f"memory::{self.namespace}::{digest}"

    async def _embed(self, text: str) -> list[float]:
        provider = self.embedding_provider
        if callable(provider) and not hasattr(provider, "embed"):
            result = provider(text)
        else:
            result = cast(EmbeddingProvider, provider).embed(text)
        if inspect.isawaitable(result):
            result = await result
        vector = [float(value) for value in result]
        if not vector:
            raise ValueError("embedding provider returned an empty vector")
        if self.dimensions is not None and len(vector) != self.dimensions:
            raise ValueError(f"embedding provider returned {len(vector)} dimensions; expected {self.dimensions}")
        return vector


def _validate_distance_metric(distance_metric: str) -> DistanceMetric:
    metric = distance_metric.strip().upper()
    for allowed in DISTANCE_METRICS:
        if metric == allowed:
            return allowed
    raise ValueError(f"distance_metric must be one of {', '.join(DISTANCE_METRICS)}; got '{distance_metric}'")


def _canonical_metric(metric: str) -> str:
    """EUCLIDEAN and L2 are aliases, as are EUCLIDEAN_SQUARED and L2_SQUARED."""
    upper = metric.upper()
    return {"EUCLIDEAN": "L2", "EUCLIDEAN_SQUARED": "L2_SQUARED"}.get(upper, upper)


def _validate_positive_integer(name: str, value: int | None) -> int | None:
    if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value < 1):
        raise ValueError(f"{name} must be a positive integer; got {value!r}")
    return value


async def _close_quietly(cluster: Cluster | None) -> None:
    """Close a cluster this backend opened but will not keep; the original setup error matters more."""
    if cluster is None:
        return
    with contextlib.suppress(Exception):
        await asyncio.to_thread(cluster.close)


def _connection_error(connection_string: str, username: str, err: Exception) -> RuntimeError:
    target = f"Couchbase at {connection_string} as '{username}'"
    if isinstance(err, AuthenticationException):
        return RuntimeError(f"Authentication failed connecting to {target}. Check the username and password.")
    return RuntimeError(f"Could not connect to {target}: {err}. Check the connection string and network access.")


def _search_type_mappings(mapping: JsonMap, scope_collection: str) -> list[JsonMap]:
    """Type mappings that apply to the store's collection (``scope.collection`` or ``scope.collection.<type>``)."""
    types = mapping.get("types")
    matches = [
        type_mapping
        for name, type_mapping in (types.items() if isinstance(types, dict) else [])
        if (name == scope_collection or name.startswith(f"{scope_collection}.")) and isinstance(type_mapping, dict)
    ]
    default_mapping = mapping.get("default_mapping")
    if isinstance(default_mapping, dict) and default_mapping.get("enabled") is not False:
        matches.append(default_mapping)
    return [type_mapping for type_mapping in matches if type_mapping.get("enabled") is not False]


def _find_search_fields(type_mapping: JsonMap, path: str) -> list[JsonMap]:
    """Field mappings at a dotted path in a Search type mapping."""
    segments = path.split(".")
    node: Any = type_mapping
    for segment in segments:
        properties = node.get("properties") if isinstance(node, dict) else None
        node = properties.get(segment) if isinstance(properties, dict) else None
        if not isinstance(node, dict):
            return []
    leaf = segments[-1]
    fields = node.get("fields")
    return [
        field
        for field in (fields if isinstance(fields, list) else [])
        if isinstance(field, dict) and field.get("index") is not False and field.get("name") in (None, leaf)
    ]


def _quote_string_literal(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _quote_identifier(identifier: str) -> str:
    """Quote one SQL++ identifier segment with backticks."""
    if not identifier or "\x00" in identifier:
        raise ValueError("SQL++ identifiers must be non-empty strings")
    return f"`{identifier.replace('`', '``')}`"


def _quote_path(path: str) -> str:
    """Quote a dotted SQL++ field path such as metadata.category."""
    return ".".join(_quote_identifier(part) for part in path.split("."))
