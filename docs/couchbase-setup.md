# Couchbase setup for Strands memory

This guide gets a Couchbase cluster ready for the memory store: a cluster, a bucket, and a Hyperscale Vector Index.

## Requirements

- **Couchbase Server 8.0 or later**, or a Capella cluster on 8.0 or later. Hyperscale Vector Indexes were added in 8.0; on 7.x, `CREATE VECTOR INDEX` fails.
- The **Data**, **Query** and **Index** services. Add **Search** only if you use `COUCHBASE_VECTOR_BACKEND=search`.
- A bucket, `strands_memory` by default. The `_default` scope and collection are fine.

Use a local Docker container for development and tests. Use Capella when the application runs somewhere else, for example on a hosted service that can't reach your laptop.

## Local Couchbase Server with Docker

1. Start Couchbase Server 8:

   ```bash
   docker run -d --name couchbase-strands \
     -p 8091-8097:8091-8097 -p 11210:11210 \
     couchbase:enterprise-8.0.3
   ```

2. Open http://localhost:8091 (it takes about 20 seconds to start) and click **Setup New Cluster**.
3. Enter a cluster name, the admin username `Administrator` and a password, then click **Next: Accept Terms**.
4. Accept the terms and click **Configure Disk, Memory, Services**.
5. Make sure **Data**, **Query** and **Index** are checked. On a small machine, lower the Data quota to about 1024 MiB. Click **Save & Finish**.
6. Open **Buckets**, click **ADD BUCKET**, enter the name `strands_memory`, and click **Add Bucket**.

The same steps from the command line, once the container is running:

```bash
until curl -sf http://localhost:8091/ui/index.html -o /dev/null; do sleep 2; done
docker exec couchbase-strands couchbase-cli cluster-init -c localhost \
  --cluster-username Administrator --cluster-password password \
  --services data,query,index --cluster-ramsize 1024 --cluster-index-ramsize 512 --index-storage-setting default
docker exec couchbase-strands couchbase-cli bucket-create -c localhost -u Administrator -p password \
  --bucket strands_memory --bucket-type couchbase --bucket-ramsize 256 --bucket-replica 0 --wait
```

Use `couchbase://localhost` as the connection string.

## Capella free tier

1. Sign up or sign in at https://cloud.couchbase.com.
2. Click **Create Cluster**, select the project (for example **My First Project**), and under **Cluster Option** select **Free**. Pick a cloud provider and region, and click **Create Cluster**. Deployment takes a few minutes.
3. When the cluster is healthy, check on its overview page that it runs Couchbase Server 8.0 or later.
4. Create the bucket: in the cluster, either open **Data Tools** and click **Create** to make a bucket (keep the `_default` scope and collection), or open the **Buckets** tab and click **Create Bucket**. Name it `strands_memory`.
5. Open the cluster's **Connect** page and follow its steps:
   - Create cluster access credentials with read and write access to `strands_memory`. These are your `COUCHBASE_USERNAME` and `COUCHBASE_PASSWORD`; they are not your Capella login.
   - Add your machine's public IP address to the allowed IP addresses. Without it, connections time out.
   - Copy the public connection string. It starts with `couchbases://`, because Capella requires TLS.
6. Put the connection string and credentials in `.env`.

## Create the vector index

A Hyperscale Vector Index is trained on vectors that are already in the collection, so it can't be created on an empty one. Creating it too early fails with `ErrTraining: number of centroids required to train the index are not set`.

Each package has a setup script that handles this. It seeds placeholder vectors into a `_seed` namespace, creates the index with `EMBEDDING_DIMENSIONS` and `COUCHBASE_DISTANCE_METRIC` from your config, waits until the index is online, and checks it with `initialize()`. Running it again is safe. If the index already exists with a different dimension or metric, it stops and tells you how to drop it.

Python (Python doesn't read `.env` by itself, so export it first):

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install strands-couchbase
cp .env.example .env
set -a; source .env; set +a
python examples/setup.py
```

Edit `.env` (the connection, credentials, `EMBEDDING_DIMENSIONS` and `COUCHBASE_DISTANCE_METRIC`) before the `source` line.

TypeScript:

```bash
cd typescript
cp .env.example .env
npm install
npm run example:setup
```

Edit `.env` before `npm run example:setup`.

To do it by hand, write at least one document with an `embedding` of the right size, then create the index as shown below.

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
  "dimension": 1536,
  "similarity": "L2_SQUARED",
  "description": "IVF,SQ8"
};
```

Set `dimension` to your embedding size: 1536 for OpenAI `text-embedding-3-small` (both quickstarts), 3 for the toy embeddings in the live tests. Set `similarity` to the store's distance metric. The Python `.env.example` uses `COSINE`, and the TypeScript one and both stores' defaults use `L2_SQUARED`; for normalized embeddings such as OpenAI's they rank results the same way.

Hyperscale Vector Indexes are trained on existing vectors, so the collection must already contain at least one document with an `embedding` of the configured dimension before you create the index; on an empty collection `CREATE VECTOR INDEX` fails with `ErrTraining: number of centroids required to train the index are not set`. With `"description": "IVF,SQ8"` Couchbase picks the centroid count from the data. If you pin it (`"IVF<n>,SQ8"`), the collection needs at least `n` documents.

The `similarity` value must match `COUCHBASE_DISTANCE_METRIC`. Use a dimension matching your embedding model. The Search-service vector backend is available only when `COUCHBASE_VECTOR_BACKEND=search`.

Hyperscale Vector queries use SQL++ `APPROX_VECTOR_DISTANCE`. For small local indexes, configure enough centroids-to-probe (`centroids_to_probe` in Python, `centroidsToProbe` in TypeScript, default 8) to cover the trained centroids.

## Startup validation

Strands `MemoryManager` catches store errors during recall and only logs them, so a missing index or a wrong setting would otherwise leave the agent running with no memory. Both packages implement `initialize()`, which `MemoryManager` awaits during agent setup. It:

- connects, and throws a clear error on authentication or network failures;
- for `hyperscale`, checks `system:indexes` for a GSI index with a `VECTOR` key on the vector field (`vector_field` / `vectorField`) in the configured collection, whose `similarity` matches the distance metric and, when `dimensions` is set, whose `dimension` matches;
- for `search`, checks that the Search index (`search_index_name` / `searchIndexName`) exists, maps the vector field as a vector field (with matching `dims` when `dimensions` is set), and maps the namespace field with the `keyword` analyzer.

Call `await store.initialize()` yourself when you use the store without `MemoryManager`. If the credentials can't read `system:indexes` or Search index definitions, pass `validate_on_initialize=False` (Python) or `validateOnInitialize: false` (TypeScript). `initialize()` then only connects. Python raises `RuntimeError` for these failures.

Without this check, a distance metric that doesn't match the index `similarity` fails silently: the Query service can't use the vector index and falls back to a sequential scan (`#sequentialscan` in `EXPLAIN`), so every search reads the whole collection.

The store also throws (Python: raises `ValueError`) in its constructor when it would open the connection itself and no username or password is configured. The constructor never connects; the first `initialize()`, `add()`, `search()` or `close()` does.

## Search Vector Index requirements

With `COUCHBASE_VECTOR_BACKEND=search`, the namespace prefilter is an exact term query. Map the `namespace` field as a text field with the `keyword` analyzer. With the `standard` analyzer, `tenant-a` is indexed as `tenant` and `a`, so exact matching fails and namespaces can't be isolated. `initialize()` in both packages rejects such an index.

## Related documentation

- `vector-backends.md` explains when to use Hyperscale, Composite, or Search-service vector indexes.
- `memorymanager-usage.md` explains Strands `MemoryManager` recall, injection, extraction, and write semantics.
- `security-and-multitenancy.md` explains safe namespace and credential handling.

## Running live tests

Python:

```bash
cd python
pip install hatch
export COUCHBASE_INTEGRATION_TESTS=1
hatch run test -m integration
```

TypeScript:

```bash
cd typescript
export COUCHBASE_INTEGRATION_TESTS=1
npm run test:live
```

If live tests fail with no hits after a successful write, first verify the Hyperscale Vector Index exists, its `similarity` matches `COUCHBASE_DISTANCE_METRIC`, its dimension matches your embeddings, and `centroids_to_probe` / `centroidsToProbe` probes enough centroids for the test data.
