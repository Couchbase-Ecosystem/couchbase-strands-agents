# Couchbase setup for Strands memory

This guide covers development setup for the Couchbase Hyperscale Vector Search MemoryStore examples.

## Capella

Use Capella when the Strands application is not running on the same machine as Couchbase or when hosted infrastructure must reach the database.

1. Create or choose a Capella cluster with the Index and Query services enabled.
2. Allow the application IP address in the Capella networking settings.
3. Create a database credential with access to the target bucket/scope/collection and Hyperscale Vector Index.
4. Create a bucket such as `strands_memory`.
5. Create a scope and collection, or use `_default._default`.
6. Create a Hyperscale Vector Index with a vector field matching your embedding dimensions.
7. Set env vars from `.env.example` in the Python or TypeScript package.

## Local Couchbase Server

A local Couchbase Server is appropriate for development and gated integration tests.

```bash
docker run -d --name couchbase-strands \
  -p 8091-8097:8091-8097 -p 11210:11210 \
  couchbase:latest
```

Initialize Couchbase Server in the UI at http://localhost:8091 or with your normal automation. Enable at least Data, Query, Index, and Search services. For small local machines, use a small test bucket with zero replicas.

Example environment:

```bash
export COUCHBASE_CONNECTION_STRING=couchbase://localhost
export COUCHBASE_USERNAME=Administrator
# Replace the asterisks with your local or Capella database password.
export COUCHBASE_PASSWORD=********
export COUCHBASE_BUCKET=strands_memory
export COUCHBASE_SCOPE=_default
export COUCHBASE_COLLECTION=_default
export COUCHBASE_VECTOR_BACKEND=hyperscale
export COUCHBASE_DISTANCE_METRIC=L2_SQUARED
# Only needed for Search-service vector indexes:
export COUCHBASE_SEARCH_INDEX=strands-memory-search-index
export COUCHBASE_NAMESPACE=dev
```

## Hyperscale Vector Index requirements

The connector writes documents with these default fields:

- `content`: text
- `embedding`: number array vector
- `metadata`: object
- `namespace`: string

Create a Hyperscale Vector Index with SQL++:

```sql
CREATE VECTOR INDEX `strands-memory-vector-index`
ON `strands_memory`.`_default`.`_default` (`embedding` VECTOR)
INCLUDE (`content`, `metadata`, `namespace`)
USING GSI
WITH {
  "dimension": 3,
  "similarity": "L2_SQUARED",
  "description": "IVF,SQ8"
};
```

Hyperscale Vector Indexes are trained on existing vectors, so the collection must already contain at least one document with an `embedding` of the configured dimension before you create the index; on an empty collection `CREATE VECTOR INDEX` fails with `ErrTraining: number of centroids required to train the index are not set`. With `"description": "IVF,SQ8"` Couchbase picks the centroid count from the data. If you pin it (`"IVF<n>,SQ8"`), the collection needs at least `n` documents.

The `similarity` value must match `COUCHBASE_DISTANCE_METRIC`. Use a dimension matching your embedding model. The Search-service vector backend is available only when `COUCHBASE_VECTOR_BACKEND=search`.

Hyperscale Vector queries use SQL++ `APPROX_VECTOR_DISTANCE`. For small local indexes, configure enough centroids-to-probe (`num_candidates` in Python, `centroidsToProbe` in TypeScript, default 8) to cover the trained centroids.

## Startup validation (TypeScript)

Strands `MemoryManager` catches store errors during recall and only logs them, so a missing index or a wrong setting would otherwise leave the agent running with no memory. The TypeScript store implements `initialize()`, which `MemoryManager` awaits during agent setup. It:

- connects, and throws a clear error on authentication or network failures;
- for `hyperscale`, checks `system:indexes` for a GSI index with a `VECTOR` key on `vectorField` in the configured collection, whose `similarity` matches `distanceMetric` and, when `dimensions` is set, whose `dimension` matches;
- for `search`, checks that `searchIndexName` exists, maps `vectorField` as a vector field (with matching `dims` when `dimensions` is set), and maps `namespaceField` with the `keyword` analyzer.

Call `await store.initialize()` yourself when you use the store without `MemoryManager`. If the credentials can't read `system:indexes` or Search index definitions, pass `validateOnInitialize: false`. `initialize()` then only connects.

The store also throws in its constructor when it would open the connection itself and no username or password is configured.

## Search Vector Index requirements

With `COUCHBASE_VECTOR_BACKEND=search`, the namespace prefilter is an exact term query. Map the `namespace` field as a text field with the `keyword` analyzer. With the `standard` analyzer, `tenant-a` is indexed as `tenant` and `a`, so exact matching fails and namespaces can't be isolated. The TypeScript `initialize()` rejects such an index.

## Related documentation

- `vector-backends.md` explains when to use Hyperscale, Composite, or Search-service vector indexes.
- `memorymanager-usage.md` explains Strands `MemoryManager` recall, injection, extraction, and write semantics.
- `security-and-multitenancy.md` explains safe namespace and credential handling.

## Running live tests

Python:

```bash
cd python
export COUCHBASE_INTEGRATION_TESTS=1
pytest tests/test_integration_live.py
```

TypeScript:

```bash
cd typescript
export COUCHBASE_INTEGRATION_TESTS=1
npm test -- test/integration-live.test.ts
```

If live tests fail with no hits after a successful write, first verify the Hyperscale Vector Index exists, its `similarity` matches `COUCHBASE_DISTANCE_METRIC`, its dimension matches your embeddings, and `num_candidates` / `centroidsToProbe` probes enough centroids for the test data.
