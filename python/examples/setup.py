"""One-time Couchbase setup for the quickstart. Safe to run again.

Hyperscale Vector Indexes are trained on vectors already in the collection, so creating one on an empty
collection fails with ErrTraining. This script seeds placeholder vectors into a `_seed` namespace (the
store never returns them, because every search filters on its own namespace), creates the index with
the dimension and similarity from your config, waits until it is online, and checks that
CouchbaseMemoryStore accepts it.

Python doesn't read .env by itself. Export it first, then run (the bucket must already exist):

    set -a; source .env; set +a
    python examples/setup.py
"""

from __future__ import annotations

import asyncio
import math
import os
import random
import sys
import time
from datetime import timedelta
from typing import Any

from couchbase.auth import PasswordAuthenticator
from couchbase.cluster import Cluster
from couchbase.exceptions import ServiceUnavailableException
from couchbase.options import ClusterOptions, QueryOptions

from strands_couchbase import CouchbaseMemoryStore

INDEX_NAME = "strands-memory-vector-index"
SEED_NAMESPACE = "_seed"
SEED_COUNT = 256

# The index reports these metrics under either name.
METRIC_ALIASES = {"EUCLIDEAN": "L2", "EUCLIDEAN_SQUARED": "L2_SQUARED"}


def main() -> None:
    env = os.environ
    connection_string = env.get("COUCHBASE_CONNECTION_STRING") or "couchbase://localhost"
    username = env.get("COUCHBASE_USERNAME")
    password = env.get("COUCHBASE_PASSWORD")
    bucket_name = env.get("COUCHBASE_BUCKET") or "strands_memory"
    scope_name = env.get("COUCHBASE_SCOPE") or "_default"
    collection_name = env.get("COUCHBASE_COLLECTION") or "_default"
    distance_metric = (env.get("COUCHBASE_DISTANCE_METRIC") or "L2_SQUARED").strip().upper()
    dimensions_value = env.get("EMBEDDING_DIMENSIONS") or "1536"

    if not username or not password:
        sys.exit(
            "Set COUCHBASE_USERNAME and COUCHBASE_PASSWORD: copy .env.example to .env, then run "
            "`set -a; source .env; set +a` before this script."
        )
    if not dimensions_value.isdigit() or int(dimensions_value) < 1:
        sys.exit("EMBEDDING_DIMENSIONS must be a positive integer.")
    dimensions = int(dimensions_value)

    keyspace = f"`{bucket_name}`.`{scope_name}`.`{collection_name}`"
    cluster = Cluster(connection_string, ClusterOptions(PasswordAuthenticator(username, password)))
    try:
        cluster.wait_until_ready(timedelta(seconds=30))
        wait_for_query_service(cluster)
        collection = cluster.bucket(bucket_name).scope(scope_name).collection(collection_name)

        print(f"Seeding {SEED_COUNT} training vectors ({dimensions} dimensions) into namespace '{SEED_NAMESPACE}'...")
        # Seeded, so running the script again rewrites the same seed documents.
        rng = random.Random(42)
        try:
            for i in range(SEED_COUNT):
                vector = [rng.uniform(-1, 1) for _ in range(dimensions)]
                norm = math.hypot(*vector)
                collection.upsert(
                    f"memory::{SEED_NAMESPACE}::{i}",
                    {
                        "content": f"seed vector {i}",
                        "embedding": [value / norm for value in vector],
                        "metadata": {"seed": True},
                        "namespace": SEED_NAMESPACE,
                    },
                )
        except Exception as err:
            raise RuntimeError(f"Could not write to {keyspace}. Does the bucket '{bucket_name}' exist?") from err

        existing = index_state(cluster, bucket_name, scope_name, collection_name)
        if existing is None:
            print(f"Creating Hyperscale Vector Index {INDEX_NAME} (dimension {dimensions}, {distance_metric})...")
            cluster.query(
                f"""CREATE VECTOR INDEX `{INDEX_NAME}` ON {keyspace} (`embedding` VECTOR)
                INCLUDE (`content`, `metadata`, `namespace`)
                USING GSI
                WITH {{"dimension": {dimensions}, "similarity": "{distance_metric}", "description": "IVF,SQ8"}}"""
            ).execute()
        else:
            options = existing.get("index_options") or {}
            dimension, similarity = options.get("dimension"), options.get("similarity")
            if dimension != dimensions or normalize_metric(similarity) != normalize_metric(distance_metric):
                sys.exit(
                    f"Index {INDEX_NAME} already exists with dimension {dimension} and similarity {similarity}, "
                    f"but the config asks for {dimensions} and {distance_metric}. "
                    f"Drop it (DROP INDEX `{INDEX_NAME}` ON {keyspace}) and run this script again."
                )
            print(f"Index {INDEX_NAME} already exists.")

        deadline = time.monotonic() + 300
        while (index_state(cluster, bucket_name, scope_name, collection_name) or {}).get("state") != "online":
            if time.monotonic() > deadline:
                sys.exit(f"Index {INDEX_NAME} did not come online within 5 minutes.")
            time.sleep(2)

        # The same check MemoryManager runs when an agent starts: is there a vector index the store can use?
        store = CouchbaseMemoryStore(
            name="setup-check",
            cluster=cluster,
            bucket_name=bucket_name,
            scope_name=scope_name,
            collection_name=collection_name,
            distance_metric=distance_metric,
            dimensions=dimensions,
            embedding_provider=lambda text: [],
        )
        asyncio.run(store.initialize())
        print(f"Index {INDEX_NAME} is online. Couchbase is ready.")
    finally:
        cluster.close()


def wait_for_query_service(cluster: Cluster) -> None:
    # On a cluster that was just initialized, the Query service takes a few more seconds to come up than the
    # Data service, and wait_until_ready() doesn't wait for a service the cluster doesn't list yet.
    deadline = time.monotonic() + 120
    while True:
        try:
            cluster.query("SELECT RAW 1").execute()
            return
        except ServiceUnavailableException:
            if time.monotonic() > deadline:
                raise
            time.sleep(2)


def index_state(cluster: Cluster, bucket: str, scope: str, collection: str) -> dict[str, Any] | None:
    # Indexes on _default._default are listed with keyspace_id = bucket and no bucket_id.
    result = cluster.query(
        """SELECT i.state, i.`with` AS index_options FROM system:indexes AS i
        WHERE i.name = $name
          AND ((i.bucket_id = $bucket AND i.scope_id = $scope AND i.keyspace_id = $collection)
            OR (i.bucket_id IS MISSING AND i.keyspace_id = $bucket AND $scope = '_default'
                AND $collection = '_default'))""",
        QueryOptions(named_parameters={"name": INDEX_NAME, "bucket": bucket, "scope": scope, "collection": collection}),
    )
    rows = list(result.rows())
    return rows[0] if rows else None


def normalize_metric(metric: object) -> str:
    name = str(metric or "").strip().upper()
    return METRIC_ALIASES.get(name, name)


if __name__ == "__main__":
    main()
