from __future__ import annotations

from typing import Any

import pytest

from strands_couchbase import CouchbaseMemoryStore

pytestmark = pytest.mark.integration


# Expects the 3-dimension L2_SQUARED Hyperscale Vector Index from scripts/setup-live-couchbase.sh.
def live_store(settings: dict[str, str], **overrides: Any) -> CouchbaseMemoryStore:
    config: dict[str, Any] = {
        "name": "cb-live-init",
        "embedding_provider": lambda _text: [1.0, 0.0, 0.0],
        "dimensions": 3,
        "distance_metric": "L2_SQUARED",
        "vector_backend": "hyperscale",
        **settings,
        **overrides,
    }
    return CouchbaseMemoryStore(**config)


async def initialize_and_close(store: CouchbaseMemoryStore) -> None:
    try:
        await store.initialize()
    finally:
        await store.close()


async def test_accepts_the_configured_hyperscale_vector_index(live_settings: dict[str, str]) -> None:
    await initialize_and_close(live_store(live_settings))


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        pytest.param({"dimensions": 4}, "does not match dimensions 4", id="dimension mismatch"),
        pytest.param({"distance_metric": "COSINE"}, "does not match distance_metric COSINE", id="metric mismatch"),
        pytest.param({"vector_field": "no_such_vector"}, "No vector index on `no_such_vector`", id="no index"),
        pytest.param(
            {"password": "definitely-wrong-password"},
            "Authentication failed connecting to Couchbase",
            id="bad credentials",
        ),
    ],
)
async def test_rejects_a_mismatched_setup(
    live_settings: dict[str, str], overrides: dict[str, Any], message: str
) -> None:
    with pytest.raises(RuntimeError) as raised:
        await initialize_and_close(live_store(live_settings, **overrides))

    assert message in str(raised.value)
    # Connection failures are chained from the SDK error, so the original cause stays visible.
    if "password" in overrides:
        assert raised.value.__cause__ is not None
