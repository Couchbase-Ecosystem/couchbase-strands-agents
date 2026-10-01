# Tutorial: Strands memory backed by Couchbase Hyperscale Vector Search

This tutorial runs the Python and TypeScript quickstarts against the same Couchbase collection.

## Prerequisites

- Python 3.11+ and Node.js 22+.
- Couchbase Server 8.0+ or Capella with Data, Query and Index, and a `strands_memory` bucket. See [`couchbase-setup.md`](couchbase-setup.md).
- An OpenAI API key. Both quickstarts use it for the chat model and for `text-embedding-3-small` embeddings.

Both quickstarts use 1536-dimension embeddings, so they share one collection and one Hyperscale Vector Index. They also use the same document format and the same `user-alex` namespace, so the TypeScript agent in step 3 remembers what the Python agent stored in step 2.

## 1. Configure Couchbase

```bash
export COUCHBASE_CONNECTION_STRING=couchbase://localhost
export COUCHBASE_USERNAME=Administrator
export COUCHBASE_BUCKET=strands_memory
export COUCHBASE_SCOPE=_default
export COUCHBASE_COLLECTION=_default
export COUCHBASE_VECTOR_BACKEND=hyperscale
export COUCHBASE_DISTANCE_METRIC=L2_SQUARED
export EMBEDDING_DIMENSIONS=1536
```

Then set the two secrets without putting them in your shell history. Run each line on its own: `read` waits for you to paste or type the value and press Enter, and shows nothing. First the database password (`password` for the local Docker cluster from [`couchbase-setup.md`](couchbase-setup.md)):

```bash
read -rs COUCHBASE_PASSWORD && export COUCHBASE_PASSWORD
```

Then your OpenAI API key:

```bash
read -rs OPENAI_API_KEY && export OPENAI_API_KEY
```

Use Capella instead of localhost when your app runs outside your laptop or must be reachable from hosted infrastructure.

Both packages read these variables. The TypeScript scripts also read `typescript/.env`, but exported values take precedence. Python doesn't read `.env` files at all; in this tutorial, don't source `python/.env`, because its `COUCHBASE_DISTANCE_METRIC=COSINE` would replace the `L2_SQUARED` exported above and the two packages would disagree about the index.

## 2. Python example

The Python side has two scripts: `examples/setup.py` prepares Couchbase, and `examples/quickstart.py` runs two agent sessions that share memory.

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install strands-couchbase 'strands-agents[openai]'
python examples/setup.py
```

The setup script seeds placeholder vectors (the index needs them for training), creates the Hyperscale Vector Index with `EMBEDDING_DIMENSIONS` and `COUCHBASE_DISTANCE_METRIC`, waits until it is online, and checks it with `store.initialize()`:

```text
Seeding 256 training vectors (1536 dimensions) into namespace '_seed'...
Creating Hyperscale Vector Index strands-memory-vector-index (dimension 1536, L2_SQUARED)...
Index strands-memory-vector-index is online. Couchbase is ready.
```

Then run the two sessions:

```bash
python examples/quickstart.py
```

In session 1 the user tells the agent a few facts. `extraction=True` has the model distil them into short memories, and `memory_manager.flush()` waits until they are written. Session 2 is a new `Agent` and `MemoryManager` with no shared history, so it can only answer from Couchbase. The output looks like the TypeScript output below; see [`python/README.md`](../python/README.md#3-run-the-two-session-example) for a full run.

Leave the virtual environment active, or run `deactivate`, and go back to the repository root:

```bash
cd ..
```

## 3. TypeScript example

The TypeScript side has two scripts: `examples/setup.ts` prepares Couchbase, and `examples/quickstart.ts` runs two agent sessions that share memory.

```bash
cd typescript
npm install
cp .env.example .env
npm run example:setup
```

The variables exported in step 1 take precedence over `.env`, so the script finds the index the Python setup script created and checks it instead of creating another:

```text
Seeding 256 training vectors (1536 dimensions) into namespace '_seed'...
Index strands-memory-vector-index already exists.
Index strands-memory-vector-index is online. Couchbase is ready.
```

On its own, without step 2, it creates the index the same way the Python script does.

Then run the two sessions:

```bash
npm run example:quickstart
```

In session 1 the user tells the agent a few facts. `extraction: true` has the model distil them into short memories, and `memoryManager.flush()` waits until they are written. Session 2 is a new agent and `MemoryManager` with no shared history, so it can only answer from Couchbase, including from the facts the Python agent stored in step 2. The wording will differ from run to run:

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

The unit tests of both packages need no Couchbase:

```bash
cd python
pip install hatch
hatch run test
cd ../typescript
npm test
```

`python examples/smoke_test.py` (from `python/`) and `npm run example:smoke` (from `typescript/`) are quicker connectivity checks: each writes and searches one memory through the store directly, with toy vectors and no model or API key. Both read `EMBEDDING_DIMENSIONS`, so with the variables from step 1 they run against the index above.

The live tests run with `COUCHBASE_INTEGRATION_TESTS=1` against the 3-dimension index from `scripts/setup-live-couchbase.sh`, so give them their own Couchbase container. Each package README describes how.

## Common errors

- `embedding provider returned N dimensions; expected M`: update either your embedding provider or Hyperscale Vector Index mapping.
- `No vector index on ... does not match`: the index `similarity` or `dimension` differs from `COUCHBASE_DISTANCE_METRIC` or `EMBEDDING_DIMENSIONS`. Both packages check this in `initialize()`, which `MemoryManager` awaits when the agent starts.
- No search hits: verify the Hyperscale Vector Index, `COUCHBASE_DISTANCE_METRIC`, namespace filtering, and centroid probe count (`centroids_to_probe` in Python, `centroidsToProbe` in TypeScript).
- Authentication errors: verify username/password and Capella allowed IPs.
