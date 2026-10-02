"""Connectivity check for CouchbaseMemoryStore: no agent, no model and no API key.

Writes one memory into a fresh smoke-<uuid> namespace, searches for it, deletes that one
document and exits non-zero if the search did not return it. COUCHBASE_NAMESPACE is ignored, so
running it never touches existing memories. The vectors are toys made from a hash of the text,
so this proves the round trip works, not that recall is meaningful.

Connection settings come from the COUCHBASE_* environment variables, except COUCHBASE_NAMESPACE.
EMBEDDING_DIMENSIONS (default 3) must match the vector index, as created by
scripts/setup-live-couchbase.sh or examples/setup.py.

Run: python examples/smoke_test.py
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import sys
import uuid

from couchbase.auth import PasswordAuthenticator
from couchbase.cluster import Cluster
from couchbase.options import ClusterOptions

from strands_couchbase import CouchbaseMemoryStore

DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "3"))
CONTENT = "Alex prefers dark-mode dashboards and async standups."


def toy_embedding(text: str) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [(digest[i % len(digest)] + i) / 255 for i in range(DIMENSIONS)]


async def main() -> int:
    bucket = os.getenv("COUCHBASE_BUCKET", "strands_memory")
    scope = os.getenv("COUCHBASE_SCOPE", "_default")
    collection = os.getenv("COUCHBASE_COLLECTION", "_default")
    # Never COUCHBASE_NAMESPACE: .env.example sets it to the store's default namespace.
    namespace = f"smoke-{uuid.uuid4()}"
    cluster = Cluster(
        os.getenv("COUCHBASE_CONNECTION_STRING", "couchbase://localhost"),
        ClusterOptions(
            PasswordAuthenticator(
                os.getenv("COUCHBASE_USERNAME", "Administrator"), os.getenv("COUCHBASE_PASSWORD", "password")
            )
        ),
    )
    store = CouchbaseMemoryStore(
        name="couchbase-smoke",
        cluster=cluster,
        bucket_name=bucket,
        scope_name=scope,
        collection_name=collection,
        namespace=namespace,
        embedding_provider=toy_embedding,
        dimensions=DIMENSIONS,
    )
    key: str | None = None
    try:
        # MemoryManager calls this during agent setup; standalone use calls it directly.
        await store.initialize()
        key = await store.add(CONTENT, {"category": "preference"})
        print(f"stored key: {key}")
        entries = await store.search(CONTENT, {"max_search_results": 3})
        for entry in entries:
            print(f"hit: {entry.content} metadata={entry.metadata}")
        if not any(entry.content == CONTENT for entry in entries):
            print(f"smoke test failed: search in namespace {namespace!r} did not return the stored memory")
            return 1
        return 0
    finally:
        try:
            # Remove only the document this run wrote, never a whole namespace.
            if key is not None:
                cluster.bucket(bucket).scope(scope).collection(collection).remove(key)
        finally:
            cluster.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
