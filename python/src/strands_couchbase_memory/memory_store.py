"""Strands MemoryStore implementation backed by Couchbase Vector Search."""

from __future__ import annotations

import asyncio
import inspect
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol, TypedDict, cast
from uuid import uuid4

import couchbase.search as couchbase_search
from couchbase.auth import PasswordAuthenticator
from couchbase.cluster import Cluster
from couchbase.collection import Collection
from couchbase.options import ClusterOptions, SearchOptions
from couchbase.vector_search import VectorQuery, VectorSearch
from strands.memory import AddMessagesContext, MemoryEntry, MemoryStore, MemoryStoreConfig
from strands.memory import SearchOptions as StrandsSearchOptions
from strands.types.content import Message
from typing_extensions import Unpack

DEFAULT_NAME = "couchbase"
DEFAULT_DESCRIPTION = "Long-term semantic memory stored in Couchbase Vector Search."
DEFAULT_CONNECTION_STRING = "couchbase://localhost"
DEFAULT_BUCKET = "strands_memory"
DEFAULT_SCOPE = "_default"
DEFAULT_COLLECTION = "_default"
DEFAULT_SEARCH_INDEX = "strands-memory-index"
DEFAULT_CONTENT_FIELD = "content"
DEFAULT_VECTOR_FIELD = "embedding"
DEFAULT_METADATA_FIELD = "metadata"
DEFAULT_NAMESPACE_FIELD = "namespace"
DEFAULT_NAMESPACE = "default"
DEFAULT_MAX_RESULTS = 5

JsonMap = dict[str, Any]
EmbeddingCallable = Callable[[str], list[float] | Awaitable[list[float]]]


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
    num_candidates: int


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


class CouchbaseBackend(Protocol):
    """Small backend protocol used by unit tests and the SDK adapter."""

    async def upsert(self, key: str, document: MemoryDocument) -> None:
        """Store or replace a memory document."""
        ...

    async def vector_search(
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
        """Run a vector search and return normalized hits."""
        ...

    async def close(self) -> None:
        """Close network resources if the backend owns them."""
        ...


class CouchbaseSdkBackend:
    """Couchbase Python SDK adapter.

    It uses KV for writes and Couchbase Search `VectorQuery` / `VectorSearch`
    for semantic recall. Search indexes are intentionally not created by this
    class because Couchbase vector index definitions are deployment- and
    dimension-specific. The README and setup docs show how to create them.
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
        self._owns_cluster = cluster is None
        self._cluster = cluster or Cluster.connect(
            connection_string,
            ClusterOptions(PasswordAuthenticator(username, password)),
        )
        self._bucket = self._cluster.bucket(bucket_name)
        self._scope = self._bucket.scope(scope_name) if scope_name != DEFAULT_SCOPE else self._bucket.default_scope()
        self._collection = collection or (
            self._scope.collection(collection_name)
            if collection_name != DEFAULT_COLLECTION
            else self._bucket.default_collection()
        )

    async def upsert(self, key: str, document: MemoryDocument) -> None:
        await asyncio.to_thread(self._collection.upsert, key, document)

    async def vector_search(
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
        def _search() -> list[SearchHit]:
            prefilter = couchbase_search.MatchQuery(namespace, field=namespace_field)
            vector_query = VectorQuery.create(
                vector_field,
                query_vector,
                num_candidates=num_candidates or max(limit * 3, limit),
                prefilter=prefilter,
            )
            vector_search = VectorSearch.from_vector_query(vector_query)
            request = couchbase_search.SearchRequest.create(vector_search)
            result = self._scope.search(
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

    async def close(self) -> None:
        if self._owns_cluster:
            close = getattr(self._cluster, "close", None)
            if close is not None:
                await asyncio.to_thread(close)


class CouchbaseMemoryStore(MemoryStore):
    """Couchbase Vector Search implementation of the Strands MemoryStore protocol."""

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
        self.search_index_name = (
            store_config.get("search_index_name") or os.getenv("COUCHBASE_SEARCH_INDEX") or DEFAULT_SEARCH_INDEX
        )
        self.dimensions = store_config.get("dimensions")
        self.num_candidates = store_config.get("num_candidates")
        provider = store_config.get("embedding_provider")
        if provider is None:
            raise ValueError("embedding_provider is required")
        self.embedding_provider = provider
        backend = store_config.get("backend")
        self._backend = backend or CouchbaseSdkBackend(
            connection_string=store_config.get("connection_string")
            or os.getenv("COUCHBASE_CONNECTION_STRING")
            or DEFAULT_CONNECTION_STRING,
            username=store_config.get("username") or os.getenv("COUCHBASE_USERNAME") or "",
            password=store_config.get("password") or os.getenv("COUCHBASE_PASSWORD") or "",
            bucket_name=store_config.get("bucket_name") or os.getenv("COUCHBASE_BUCKET") or DEFAULT_BUCKET,
            scope_name=store_config.get("scope_name") or os.getenv("COUCHBASE_SCOPE") or DEFAULT_SCOPE,
            collection_name=store_config.get("collection_name")
            or os.getenv("COUCHBASE_COLLECTION")
            or DEFAULT_COLLECTION,
            cluster=store_config.get("cluster"),
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
            vector_field=self.vector_field,
            query_vector=query_vector,
            limit=limit,
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
        """Store one memory document and return its Couchbase document key."""
        if not self.writable:
            raise RuntimeError(f"Memory store {self.name!r} is not writable")
        if not content.strip():
            raise ValueError("content must not be empty")
        clean_metadata = dict(metadata or {})
        key = str(clean_metadata.pop("id", clean_metadata.pop("memory_id", f"memory::{self.namespace}::{uuid4()}")))
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
        await self._backend.upsert(key, document)
        return key

    async def add_messages(self, messages: list[Message], context: AddMessagesContext | None = None) -> list[str]:
        """Store raw conversation turns as discrete memory entries.

        Vector databases do not do server-side extraction. This method preserves
        role/content structure for callers that opt into raw message storage.
        For model-distilled facts, configure Strands extraction to use `add`.
        """
        keys: list[str] = []
        sequence_numbers = context.sequence_numbers if context else None
        for index, message in enumerate(messages):
            content = _message_to_text(message)
            if not content:
                continue
            role = str(message.get("role", "unknown"))
            metadata: JsonMap = {"role": role, "source": "strands.add_messages"}
            if sequence_numbers and index < len(sequence_numbers):
                metadata["sequence_number"] = sequence_numbers[index]
            keys.append(await self.add(content, metadata))
        return keys

    async def close(self) -> None:
        """Close backend resources."""
        await self._backend.close()

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


def _message_to_text(message: Message) -> str:
    parts: list[str] = []
    for block in message.get("content", []):
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts).strip()
