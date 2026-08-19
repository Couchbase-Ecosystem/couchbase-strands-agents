# Couchbase setup for Strands memory

This guide covers development setup for the Couchbase Vector Search MemoryStore examples.

## Capella

Use Capella when the Strands application is not running on the same machine as Couchbase or when hosted infrastructure must reach the database.

1. Create or choose a Capella cluster with the Search service enabled.
2. Allow the application IP address in the Capella networking settings.
3. Create a database credential with access to the target bucket/scope/collection and Search index.
4. Create a bucket such as `strands_memory`.
5. Create a scope and collection, or use `_default._default`.
6. Create a Search index with a vector field matching your embedding dimensions.
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
export COUCHBASE_SEARCH_INDEX=strands-memory-index
export COUCHBASE_NAMESPACE=dev
```

## Search index requirements

The connector writes documents with these default fields:

- `content`: text
- `embedding`: number array vector
- `metadata`: object
- `namespace`: string

Create an index that:

- maps `embedding` as a vector field with the same dimensions as your embedding provider;
- stores/includes `content`, `metadata`, and `namespace` so search results can be mapped back to Strands `MemoryEntry` values;
- allows a namespace prefilter on `namespace`.

Search indexing is asynchronous. After inserting documents, wait for the Search index to ingest them before expecting results.

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

If live tests fail with no hits after a successful write, first verify the Search index exists, is not paused, has indexed the expected documents, and maps the vector dimensions correctly.
