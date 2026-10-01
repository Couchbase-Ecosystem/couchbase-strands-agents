# Tutorial: Strands memory backed by Couchbase Hyperscale Vector Search

This tutorial runs the Python example and the TypeScript quickstart against Couchbase.

## Prerequisites

- Python 3.10+ and Node.js 22+.
- Couchbase Server 8.0+ or Capella with Data, Query and Index, and a `strands_memory` bucket. See [`couchbase-setup.md`](couchbase-setup.md).
- For the TypeScript quickstart, an OpenAI API key.

The Python example uses a 3-dimension demo embedding, and the TypeScript quickstart uses OpenAI's 1536-dimension `text-embedding-3-small`. A vector index has one fixed dimension, so run them against different collections (or buckets), or set `EMBEDDING_DIMENSIONS=3` and use `npm run example:smoke` on the TypeScript side.

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

Use Capella instead of localhost when your app runs outside your laptop or must be reachable from hosted infrastructure. The TypeScript scripts read the same variables from `typescript/.env`; exported values take precedence.

## 2. Python example

```bash
cd python
python -m pip install -e '.[dev]'
python examples/basic_memory.py
```

Expected output:

```text
stored key: memory::tutorial::<sha256>
Hyperscale Vector queries use SQL++ `APPROX_VECTOR_DISTANCE`; ensure your vector index metric matches `COUCHBASE_DISTANCE_METRIC`.
hit: Alex prefers dark-mode dashboards and async standups. metadata={...}
```

For small local test datasets, increase `num_candidates` (Python) / `centroidsToProbe` (TypeScript) if approximate search misses a recently added vector.

## 3. TypeScript example

The TypeScript side has two scripts: `examples/setup.ts` prepares Couchbase, and `examples/quickstart.ts` runs two agent sessions that share memory.

```bash
cd typescript
npm install
cp .env.example .env   # set OPENAI_API_KEY; the COUCHBASE_* defaults match a local Docker cluster
npm run example:setup
```

The setup script seeds placeholder vectors (the index needs them for training), creates the Hyperscale Vector Index with `EMBEDDING_DIMENSIONS` (1536), and waits until it is online:

```text
Seeding 256 training vectors (1536 dimensions) into namespace '_seed'...
Creating Hyperscale Vector Index strands-memory-vector-index (dimension 1536, L2_SQUARED)...
Index strands-memory-vector-index is online. Couchbase is ready.
```

Then run the two sessions:

```bash
npm run example:quickstart
```

In session 1 the user tells the agent a few facts. `extraction: true` has the model distil them into short memories, and `memoryManager.flush()` waits until they are written. Session 2 is a new agent and `MemoryManager` with no shared history, so it can only answer from Couchbase. The wording will differ from run to run:

```text
--- Session 1 ---

User:  Hi! I'm Alex. I'm vegetarian, I live in Lisbon, and I'm training for a half marathon in May.
Agent: Hi Alex! It's nice to meet you. Thanks for sharing that information. I'll be sure to remember your dietary preference, your location, and your half marathon training. Let me know if there's anything else you'd like to add!

--- Session 2 (new agent, no shared history) ---

User:  Can you suggest a dinner for me tonight and remind me what I am training for?
Agent: You are training for a half marathon in May!

For dinner, how about a hearty lentil shepherd's pie with a sweet potato topping? It's a nutritious and filling vegetarian meal that would be great for refueling after a training session.

--- Stored memories ---
- Alex is vegetarian.
- Alex lives in Lisbon.
- Alex is training for a half marathon in May.
- Is interested in dinner suggestions.
- Training for a half marathon in May.
```

`npm run example:smoke` checks connectivity only: it writes and searches one memory with toy vectors and no model.

See [`typescript/README.md`](../typescript/README.md) for other embedding providers, the configuration reference and troubleshooting.

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
