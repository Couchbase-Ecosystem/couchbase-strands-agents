# Couchbase vector backend guide

This connector supports two Couchbase vector-search execution paths. The default is the Couchbase Query and Index service path with Hyperscale Vector Indexes.

## Backend selection

| Connector backend | Couchbase index/query path | Services | Best fit | Notes |
| --- | --- | --- | --- | --- |
| `hyperscale` (default) | Hyperscale Vector Index queried with SQL++ `APPROX_VECTOR_DISTANCE(...)` | Query + Index | Pure vector similarity search, content discovery, recommendations, and large vector datasets | Couchbase docs describe Hyperscale as the highest-performance vector index type and recommend testing it before other index types. |
| Composite Vector Index | SQL++ `APPROX_VECTOR_DISTANCE(...)` over a composite GSI vector index | Query + Index | Queries where scalar predicates should significantly reduce the candidate set before vector comparison | This connector's `hyperscale` backend also uses SQL++; a Composite Vector Index can be used when its key shape matches the generated query and your scalar filters/index fields. |
| `search` (legacy fallback) | Search Vector Index queried with SDK `VectorQuery` / `VectorSearch` / `scope.search(...)` | Search | Existing deployments that already use Search Vector Indexes, or hybrid full-text/geospatial use cases | Must be opted into with `COUCHBASE_VECTOR_BACKEND=search` or constructor config. |

Couchbase's "Choose the Right Vector Index" documentation lists the three vector index families as Hyperscale Vector Indexes, Composite Vector Indexes, and Search Vector Indexes. It describes Hyperscale as specifically designed for vector search, Composite as combining scalar filtering with a vector column, and Search Vector Indexes as the option for hybrid vector + full-text/geospatial search.

## Hyperscale default

The default backend issues SQL++ shaped like this:

```sql
SELECT META().id AS id,
       `content` AS content,
       `metadata` AS metadata,
       `namespace` AS namespace_value,
       APPROX_VECTOR_DISTANCE(
         `embedding`,
         $query_vector,
         'L2_SQUARED',
         8
       ) AS distance
FROM `_default`
WHERE `namespace` = $namespace
ORDER BY distance
LIMIT 5;
```

The connector quotes configured field names and binds the query vector and namespace as SQL++ parameters. The distance metric is validated against the metrics listed by Couchbase vector-function docs: `COSINE`, `DOT`, `L2`, `EUCLIDEAN`, `L2_SQUARED`, and `EUCLIDEAN_SQUARED`.

Create a matching Hyperscale Vector Index before running the connector:

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

Use the dimensions and similarity metric of your embedding model/index. The connector default `COUCHBASE_DISTANCE_METRIC=L2_SQUARED` must match the index `similarity` setting for the Query service to select the vector index.

## Tuning `num_candidates` / `numCandidates`

For the Hyperscale backend, `num_candidates` (Python) and `numCandidates` (TypeScript) are passed as the `nprobes` argument to `APPROX_VECTOR_DISTANCE`. Couchbase docs define this as the number of centroids to probe for matching vectors. If omitted by the function, Couchbase uses the index `scan_nprobes` setting when available; invalid values default to `1`.

The connector passes `8` by default because tiny local/dev indexes can otherwise miss a relevant vector when only one centroid is probed. Tune this value for your data, latency, and recall needs.

Python:

```python
store = CouchbaseMemoryStore(
    name="memories",
    embedding_provider=embeddings,
    num_candidates=16,
)
```

TypeScript:

```ts
const store = new CouchbaseMemoryStore({
  name: 'memories',
  embeddingProvider: embeddings,
  numCandidates: 16,
})
```

## Search-service fallback

Set the backend to `search` only when you want the legacy Search-service vector path:

```bash
export COUCHBASE_VECTOR_BACKEND=search
export COUCHBASE_SEARCH_INDEX=strands-memory-search-index
```

In this mode the connector uses Couchbase SDK Search APIs (`VectorQuery`, `VectorSearch`, and `scope.search(...)`). It expects a Search Vector Index that stores/includes the configured `content`, `metadata`, and `namespace` fields.

## Version and service notes

Couchbase Capella vector-index documentation lists Hyperscale and Composite Vector Indexes as first available in version 8.0, and Search Vector Indexes as first available in version 7.6. Enable the services required by the backend you choose:

- `hyperscale`: Data, Query, and Index services.
- `search`: Data and Search services.

For local Docker tests in this repository, the verified path is `couchbase:latest` with Data, Query, and Index services enabled plus a manually created Hyperscale Vector Index.

## References

- Couchbase: Vector Search Using Hyperscale Vector Indexes — `https://docs.couchbase.com/cloud/vector-index/hyperscale-vector-index.html`
- Couchbase: Choose the Right Vector Index — `https://docs.couchbase.com/cloud/vector-index/use-vector-indexes.html`
- Couchbase: Filtered Search Using Composite Vector Indexes — `https://docs.couchbase.com/cloud/vector-index/composite-vector-index.html`
- Couchbase: Vector Functions / `APPROX_VECTOR_DISTANCE` — `https://docs.couchbase.com/cloud/n1ql/n1ql-language-reference/vectorfun.html`
- Couchbase: Vector Search Using Search Vector Indexes — `https://docs.couchbase.com/server/current/vector-search/vector-search.html`
