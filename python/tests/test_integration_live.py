from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Iterator
from datetime import timedelta
from typing import Any, TypeVar

import pytest
from couchbase.auth import PasswordAuthenticator
from couchbase.cluster import Cluster, QueryScanConsistency
from couchbase.options import ClusterOptions, QueryOptions
from strands import Agent
from strands.memory import MemoryManager
from strands.models import Model

from strands_couchbase import CouchbaseMemoryStore

pytestmark = pytest.mark.integration

T = TypeVar("T")

# One axis per topic, so ranking is predictable: a query about a topic must rank that topic's memory first.
TOPICS = [
    re.compile(r"dashboard|dark.mode|theme", re.IGNORECASE),
    re.compile(r"live|denver|city|home", re.IGNORECASE),
    re.compile(r"coffee|drink|oat", re.IGNORECASE),
]

FACTS = ["User prefers dark-mode dashboards.", "User lives in Denver.", "User drinks oat-milk coffee."]


def topic_embedding(text: str) -> list[float]:
    vector = [1.0 if topic.search(text) else 0.0 for topic in TOPICS]
    return vector if any(vector) else [0.1, 0.1, 0.1]


class StubModel(Model):
    """Answers chat turns with a fixed reply, and extraction prompts with FACTS as a JSON array."""

    def __init__(self) -> None:
        self.config: dict[str, Any] = {"model_id": "stub-model"}
        self.extraction_calls = 0

    def update_config(self, **model_config: Any) -> None:
        self.config.update(model_config)

    def get_config(self) -> Any:
        return self.config

    def structured_output(self, *args: Any, **kwargs: Any) -> AsyncGenerator[dict[str, Any], None]:
        raise NotImplementedError

    async def stream(  # type: ignore[override]
        self, messages: Any, tool_specs: Any = None, system_prompt: str | None = None, **kwargs: Any
    ) -> AsyncIterator[dict[str, Any]]:
        prompt = "\n".join(block.get("text", "") for message in messages for block in message["content"])
        is_extraction = prompt.startswith("Extract facts from") or "extract" in (system_prompt or "").lower()
        if is_extraction:
            self.extraction_calls += 1
        text = json.dumps([{"content": fact} for fact in FACTS]) if is_extraction else "Noted."
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


async def wait_for(read: Callable[[], Awaitable[T]], done: Callable[[T], bool], timeout_seconds: float = 30.0) -> T:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    value = await read()
    while not done(value) and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(1.0)
        value = await read()
    return value


@pytest.fixture(scope="module")
def cluster(live_settings: dict[str, str]) -> Iterator[Cluster]:
    cluster = Cluster(
        live_settings["connection_string"],
        ClusterOptions(PasswordAuthenticator(live_settings["username"], live_settings["password"])),
    )
    cluster.wait_until_ready(timedelta(seconds=30))
    try:
        yield cluster
    finally:
        cluster.close()


class LiveStores:
    """Creates stores in per-run unique namespaces, and deletes every namespace it handed out."""

    def __init__(self, cluster: Cluster, settings: dict[str, str]) -> None:
        self.cluster = cluster
        self.settings = settings
        self.namespaces: list[str] = []

    def new(self, **overrides: Any) -> CouchbaseMemoryStore:
        namespace = f"pytest-{uuid.uuid4()}"
        self.namespaces.append(namespace)
        config: dict[str, Any] = {
            "name": "cb-live",
            "embedding_provider": topic_embedding,
            "dimensions": 3,
            "cluster": self.cluster,
            "bucket_name": self.settings["bucket_name"],
            "scope_name": self.settings["scope_name"],
            "collection_name": self.settings["collection_name"],
            "namespace": namespace,
            **overrides,
        }
        return CouchbaseMemoryStore(**config)

    def documents_in(self, namespace: str) -> list[dict[str, Any]]:
        return self._query(
            "SELECT META().id AS id, content, metadata FROM {} WHERE `namespace` = $namespace", namespace
        )

    def delete_namespace(self, namespace: str) -> None:
        self._query("DELETE FROM {} WHERE `namespace` = $namespace", namespace)

    def _query(self, statement: str, namespace: str) -> list[dict[str, Any]]:
        scope = self.cluster.bucket(self.settings["bucket_name"]).scope(self.settings["scope_name"])
        result = scope.query(
            statement.format(f"`{self.settings['collection_name']}`"),
            QueryOptions(named_parameters={"namespace": namespace}, scan_consistency=QueryScanConsistency.REQUEST_PLUS),
        )
        return list(result.rows())


@pytest.fixture
def stores(cluster: Cluster, live_settings: dict[str, str]) -> Iterator[LiveStores]:
    live = LiveStores(cluster, live_settings)
    try:
        yield live
    finally:
        for namespace in live.namespaces:
            live.delete_namespace(namespace)


async def test_ranks_the_closest_memory_first_through_hyperscale_vector_search(stores: LiveStores) -> None:
    store = stores.new()
    for fact in FACTS:
        await store.add(fact, {"test": "live"})

    results = await wait_for(
        lambda: store.search("Where does the user live?", {"max_search_results": 5}),
        lambda hits: len(hits) == len(FACTS),
    )

    assert sorted(entry.content for entry in results) == sorted(FACTS)
    assert results[0].content == "User lives in Denver."
    assert all(entry.metadata["namespace"] == store.namespace for entry in results)
    assert all(entry.metadata["test"] == "live" for entry in results)

    coffee = await store.search("What does the user drink?", {"max_search_results": 5})
    assert coffee[0].content == "User drinks oat-milk coffee."


async def test_dedupes_the_same_content_on_the_live_cluster(stores: LiveStores) -> None:
    store = stores.new()

    first = await store.add("User lives in Denver.", {"attempt": 1})
    second = await store.add("User lives in Denver.", {"attempt": 2})

    assert first == second
    documents = stores.documents_in(store.namespace)
    assert len(documents) == 1
    assert documents[0]["id"] == first
    # The first write wins; the repeat does not overwrite it.
    assert documents[0]["metadata"] == {"attempt": 1}


async def test_stores_extracted_facts_not_raw_turns_through_memory_manager_with_extraction(
    stores: LiveStores,
) -> None:
    model = StubModel()
    store = stores.new(writable=True, extraction=True)
    memory_manager = MemoryManager(stores=[store])
    agent = Agent(model=model, memory_manager=memory_manager, callback_handler=None)

    await agent.invoke_async("I prefer dark-mode dashboards, I live in Denver and I drink oat-milk coffee.")
    await memory_manager.flush()

    assert model.extraction_calls > 0
    documents = await wait_for(
        lambda: asyncio.to_thread(stores.documents_in, store.namespace),
        lambda docs: len(docs) >= len(FACTS),
    )
    # Regression for #6: raw user/assistant turns must never be stored as memories.
    assert sorted(doc["content"] for doc in documents) == sorted(FACTS)

    results = await store.search("How does the user like dashboards?")
    assert results[0].content == "User prefers dark-mode dashboards."
