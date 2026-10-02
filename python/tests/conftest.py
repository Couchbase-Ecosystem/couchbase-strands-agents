from __future__ import annotations

import os

import pytest

LIVE_ENV = os.getenv("COUCHBASE_INTEGRATION_TESTS") == "1"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Skip ``integration`` tests unless COUCHBASE_INTEGRATION_TESTS is exactly "1"."""
    if LIVE_ENV:
        return
    skip_live = pytest.mark.skip(reason="Set COUCHBASE_INTEGRATION_TESTS=1 to run the live Couchbase tests.")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip_live)


@pytest.fixture(scope="session")
def live_settings() -> dict[str, str]:
    """Connection settings for the cluster from scripts/setup-live-couchbase.sh, overridable by COUCHBASE_*."""
    return {
        "connection_string": os.getenv("COUCHBASE_CONNECTION_STRING", "couchbase://localhost"),
        "username": os.getenv("COUCHBASE_USERNAME", "Administrator"),
        "password": os.getenv("COUCHBASE_PASSWORD", "password"),
        "bucket_name": os.getenv("COUCHBASE_BUCKET", "strands_memory"),
        "scope_name": os.getenv("COUCHBASE_SCOPE", "_default"),
        "collection_name": os.getenv("COUCHBASE_COLLECTION", "_default"),
    }
