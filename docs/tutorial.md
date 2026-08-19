# Tutorial: Strands memory backed by Couchbase Hyperscale Vector Search

This tutorial runs the Python and TypeScript packages against the same Couchbase memory collection.

## Prerequisites

- Python 3.10+ and Node.js 20+.
- Couchbase Capella or local Couchbase Server with Query and Index enabled.
- A Hyperscale Vector Index mapping a 3-dimensional vector field named `embedding` for this tutorial's demo embedding provider.

For production, replace the demo provider with a real embedding provider and update the Hyperscale Vector Index dimensions.

## 1. Configure Couchbase

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
export COUCHBASE_NAMESPACE=tutorial
```

Use Capella instead of localhost when your app runs outside your laptop or must be reachable from hosted infrastructure.

## 2. Python example

```bash
cd python
python -m pip install -e '.[dev]'
python examples/basic_memory.py
```

Expected output:

```text
stored key: memory::tutorial::<uuid>
Hyperscale Vector queries use SQL++ `APPROX_VECTOR_DISTANCE`; ensure your vector index metric matches `COUCHBASE_DISTANCE_METRIC`.
hit: Alex prefers dark-mode dashboards and async standups. metadata={...}
```

For small local test datasets, increase `num_candidates` / `numCandidates` if approximate search misses a recently added vector.

## 3. TypeScript example

```bash
cd typescript
npm install
npm run example:basic
```

Expected output is equivalent to the Python example.

## 4. Validate

```bash
cd python && pytest
cd ../typescript && npm test
```

Set `COUCHBASE_INTEGRATION_TESTS=1` to run the live Couchbase tests after the Hyperscale Vector Index is created.

## Common errors

- `embedding provider returned N dimensions; expected M`: update either your embedding provider or Hyperscale Vector Index mapping.
- No search hits: verify the Hyperscale Vector Index, `COUCHBASE_DISTANCE_METRIC`, namespace filtering, and centroid probe count.
- Authentication errors: verify username/password and Capella allowed IPs.
