# Tutorial: Strands memory backed by Couchbase Vector Search

This tutorial runs the Python and TypeScript packages against the same Couchbase memory collection.

## Prerequisites

- Python 3.10+ and Node.js 20+.
- Couchbase Capella or local Couchbase Server with Search enabled.
- A Search index named `strands-memory-index` mapping a 3-dimensional vector field named `embedding` for this tutorial's demo embedding provider.

For production, replace the demo provider with a real embedding provider and update the Search index dimensions.

## 1. Configure Couchbase

```bash
export COUCHBASE_CONNECTION_STRING=couchbase://localhost
export COUCHBASE_USERNAME=Administrator
# Replace the asterisks with your local or Capella database password.
export COUCHBASE_PASSWORD=********
export COUCHBASE_BUCKET=strands_memory
export COUCHBASE_SCOPE=_default
export COUCHBASE_COLLECTION=_default
export COUCHBASE_SEARCH_INDEX=strands-memory-index
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
Search indexes update asynchronously; wait for indexing before expecting a hit.
hit: Alex prefers dark-mode dashboards and async standups. metadata={...}
```

The hit can be absent on the first run until the Search index catches up.

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

Set `COUCHBASE_INTEGRATION_TESTS=1` to run the live Couchbase tests after the Search index is created.

## Common errors

- `embedding provider returned N dimensions; expected M`: update either your embedding provider or Search index mapping.
- No search hits: wait for Search indexing; verify `COUCHBASE_SEARCH_INDEX`; verify namespace filtering.
- Authentication errors: verify username/password and Capella allowed IPs.
