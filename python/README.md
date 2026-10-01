# Couchbase memory for Strands Agents (Python)

`strands-couchbase` gives [Strands Agents](https://strandsagents.com) long-term memory that outlives a conversation. It implements the Strands `MemoryStore` protocol: the agent's `MemoryManager` writes short facts about the user into Couchbase, and before each model call it looks up the ones relevant to the current message with vector search and adds them to the prompt. Restart the process, start a new agent, and it still knows that Alex is vegetarian.

## Requirements

- **Couchbase Server 8.0 or later**, or **Couchbase Capella** on 8.0 or later, with the Data, Query and Index services. Memories are searched with a Hyperscale Vector Index, which needs 8.0.
- **Python 3.11 or later.**
- **`strands-agents` `>=1.45.0,<2.0.0`** and the **`couchbase`** SDK 4.x. Both are installed with this package.
- **An embedding model.** The store doesn't create embeddings itself. You pass an object or function that turns text into a vector: OpenAI, Amazon Bedrock and a local model are shown [below](#embedding-providers).
- **A chat model for the agent.** If you don't pass `model`, Strands uses Amazon Bedrock with your AWS credentials. The quickstart uses OpenAI so that one API key covers both models.

## Install

```bash
pip install strands-couchbase
pip install 'strands-agents[openai]'
```

The second line adds the OpenAI model provider (and the `openai` package) that the quickstart uses. Install whichever Strands model provider you use instead. Keep the quotes: zsh treats unquoted square brackets as a glob.

## Quickstart

This takes about 10 minutes and needs Docker, Python 3.11, git and an OpenAI API key. At the end, a brand-new agent answers from facts a previous agent stored.

### 1. Start Couchbase and create a bucket

```bash
docker run -d --name couchbase-strands -p 8091-8097:8091-8097 -p 11210:11210 couchbase:enterprise-8.0.3
until curl -sf http://localhost:8091/ui/index.html -o /dev/null; do sleep 2; done

docker exec couchbase-strands couchbase-cli cluster-init -c localhost \
  --cluster-username Administrator --cluster-password password \
  --services data,query,index --cluster-ramsize 1024 --cluster-index-ramsize 512 --index-storage-setting default

docker exec couchbase-strands couchbase-cli bucket-create -c localhost -u Administrator -p password \
  --bucket strands_memory --bucket-type couchbase --bucket-ramsize 256 --bucket-replica 0 --wait
```

Each command prints `SUCCESS`. To click through the web console instead, or to use Capella, see [Couchbase setup](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/couchbase-setup.md).

### 2. Get the examples and run the setup script

```bash
git clone https://github.com/Couchbase-Ecosystem/couchbase-strands-agents.git
cd couchbase-strands-agents/python
python3 -m venv .venv
source .venv/bin/activate
pip install strands-couchbase 'strands-agents[openai]'
cp .env.example .env
```

Open `.env` and set `OPENAI_API_KEY`. The `COUCHBASE_*` defaults match the container from step 1. Python doesn't read `.env` by itself, so export it into your shell, then run the setup script:

```bash
set -a; source .env; set +a
python examples/setup.py
```

```text
Seeding 256 training vectors (1536 dimensions) into namespace '_seed'...
Creating Hyperscale Vector Index strands-memory-vector-index (dimension 1536, COSINE)...
Index strands-memory-vector-index is online. Couchbase is ready.
```

A Hyperscale Vector Index learns its structure from vectors that are already in the collection, so it can't be created on an empty one. [`examples/setup.py`](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/python/examples/setup.py) writes placeholder vectors into a `_seed` namespace first, then creates the index with `EMBEDDING_DIMENSIONS` and `COUCHBASE_DISTANCE_METRIC` from your environment, waits until it is online, and calls `store.initialize()` to check that the store accepts it. The store never returns the seed documents, because every search filters on the store's own namespace. You can run the script again safely. If the index already exists with a different dimension or metric, the script stops and tells you how to drop it.

Run `set -a; source .env; set +a` again in every new terminal, and after each edit to `.env`.

### 3. Run the two-session example

```bash
python examples/quickstart.py
```

Session 1 tells an agent some facts and waits for them to be stored. Session 2 is a new `Agent` and `MemoryManager` with no shared history; it can only know about Alex through Couchbase. Your agent's wording will differ:

```text
--- Session 1 ---

User:  Hi! I'm Alex. I'm vegetarian, I live in Lisbon, and I'm training for a half marathon in May.
Agent: Hi Alex! Nice to meet you — vegetarian half-marathon training in Lisbon sounds great.

I’ll keep in mind:
- you’re vegetarian
- you live in Lisbon
- you’re training for a half marathon in May

If you want, I can help with things like:
- a half-marathon training plan
- vegetarian meal ideas for runners
- Lisbon-specific running routes or race prep
- recovery, fueling, and hydration tips

--- Session 2 (new agent, no shared history) ---

User:  Can you suggest a dinner for me tonight and remind me what I am training for?
Agent: Absolutely — tonight I’d suggest a **vegetarian, runner-friendly dinner** like:

**Roasted chickpea and vegetable grain bowl**
- **Base:** brown rice, quinoa, or couscous
- **Protein:** roasted chickpeas or lentils
- **Veg:** roasted peppers, zucchini, carrots, and spinach
- **Extras:** feta or avocado if you like
- **Sauce:** tahini-lemon dressing or olive oil + herbs

It’s a good mix of **carbs, protein, and micronutrients**, which works well for training recovery.

And you’re training for a **half marathon in May**.

--- Stored memories ---
- The user lives in Lisbon.
- The user is vegetarian.
- The user is training for a half marathon in May.
- The user prefers vegetarian, runner-friendly dinner ideas.
```

### Use it in your own project

After `pip install` (see [Install](#install)), this is the whole quickstart. It reads the Couchbase connection and distance metric from the `COUCHBASE_*` environment variables listed in the [configuration reference](#configuration-reference). Run `examples/setup.py` once against your cluster to create the index.

```python
"""Two sessions, one memory. Session 1 tells the agent a few facts; session 2 is a brand-new agent with no
conversation history that answers from what Couchbase remembered.

Run (Python doesn't read .env by itself; needs OPENAI_API_KEY and `pip install 'strands-agents[openai]'`):

    set -a; source .env; set +a
    python examples/setup.py && python examples/quickstart.py

OpenAI is used for both the chat model and the embeddings, so one API key is enough. To switch:
- Chat model: pass any Strands model, e.g. `BedrockModel()` from `strands.models.bedrock`.
  Without `model`, Strands uses Amazon Bedrock and your AWS credentials.
- Embeddings: see "Embedding providers" in the README for Bedrock Titan and a local model. Set
  EMBEDDING_DIMENSIONS to the new model's size and run the setup script again on an empty collection.
"""

from __future__ import annotations

import asyncio
import os

from openai import AsyncOpenAI
from strands import Agent
from strands.memory import MemoryManager
from strands.models.openai import OpenAIModel

from strands_couchbase import CouchbaseMemoryStore

openai = AsyncOpenAI()  # reads OPENAI_API_KEY


class OpenAIEmbeddings:
    async def embed(self, text: str) -> list[float]:
        response = await openai.embeddings.create(model="text-embedding-3-small", input=text)
        return response.data[0].embedding


# Connection settings and the distance metric come from the COUCHBASE_* environment variables
# (see .env.example).
store = CouchbaseMemoryStore(
    name="couchbase",
    # One namespace per user. Bind it in your code, never from model output.
    namespace="user-alex",
    dimensions=int(os.getenv("EMBEDDING_DIMENSIONS", "1536")),
    embedding_provider=OpenAIEmbeddings(),
    # Distil each conversation into short facts with the agent's model and store them.
    extraction=True,
)


async def session(prompt: str) -> None:
    # A fresh agent and MemoryManager each time: nothing carries over except what is in Couchbase.
    memory_manager = MemoryManager(stores=[store])
    agent = Agent(
        model=OpenAIModel(model_id="gpt-5.4-mini"),
        memory_manager=memory_manager,
        callback_handler=None,
    )
    print(f"\nUser:  {prompt}")
    result = await agent.invoke_async(prompt)
    print(f"Agent: {str(result).strip()}")
    # Extraction runs in the background. Wait for it before the next session reads, and before close().
    await memory_manager.flush()


async def main() -> None:
    try:
        print("--- Session 1 ---")
        await session("Hi! I'm Alex. I'm vegetarian, I live in Lisbon, and I'm training for a half marathon in May.")

        print("\n--- Session 2 (new agent, no shared history) ---")
        await session("Can you suggest a dinner for me tonight and remind me what I am training for?")

        print("\n--- Stored memories ---")
        for entry in await store.search("Alex", {"max_search_results": 10}):
            print(f"- {entry.content}")
    finally:
        await store.close()


if __name__ == "__main__":
    asyncio.run(main())
```

If you'd rather create the index yourself, write at least one document with an `embedding` of the right size first, then run (with `similarity` set to your `COUCHBASE_DISTANCE_METRIC`):

```sql
CREATE VECTOR INDEX `strands-memory-vector-index`
ON `strands_memory`.`_default`.`_default` (`embedding` VECTOR)
INCLUDE (`content`, `metadata`, `namespace`)
USING GSI
WITH {"dimension": 1536, "similarity": "COSINE", "description": "IVF,SQ8"};
```

## How it works

Attaching the store to a `MemoryManager` turns on three Strands behaviors:

- **Recall.** The agent gets a `search_memory` tool it can call when it wants to look something up.
- **Injection.** Before each model call, `MemoryManager` searches the store with the latest user message and adds the closest memories to the model input in a `<memory>` block. The conversation history itself isn't changed. This is on by default.
- **Extraction.** With `extraction=True`, Strands' `ModelExtractor` asks the agent's model to distil the conversation into short standalone facts ("The user is vegetarian.") and stores each one with `store.add()`. Raw conversation turns are not stored. Extraction runs in the background, every 5 turns by default; pass an `ExtractionConfig` dict instead of `True` to change the trigger, extractor or message filter.

Each memory is one JSON document in your collection: `content`, `embedding`, `metadata`, `namespace`, `created_at` and `updated_at`. Searches use SQL++ `APPROX_VECTOR_DISTANCE` against the Hyperscale Vector Index, filtered to the store's namespace.

Two rules keep this working:

- **Always `await memory_manager.flush()` before `await store.close()`.** It saves whatever extraction hasn't saved yet and waits for the writes. Without it, a short session may never be stored (the default trigger is 5 turns), and writes still running when the connection closes fail.
- **Check for `store search failed` warnings.** If a search fails while the agent is running (the embedding API is down, say), Strands logs a warning and the agent carries on without memory rather than failing. `MemoryManager` awaits `store.initialize()` when the agent starts, so missing indexes, wrong dimensions or metrics, and bad credentials fail there with a clear `RuntimeError`. Call `await store.initialize()` yourself when you use the store without `MemoryManager`.

The constructor doesn't touch the network. The store connects on first use (`initialize()`, `add()`, `search()` or `close()`), once.

## Embedding providers

An embedding provider is any object with an `embed(text)` method, or a plain function, that returns a `list[float]`, directly or from a coroutine. Its length must equal the store's `dimensions` and the index `dimension`, so set `EMBEDDING_DIMENSIONS` before `python examples/setup.py`. All three examples return unit-length vectors, so `COSINE` (the `.env.example` value), `DOT` and `L2_SQUARED` all rank results the same way. Whichever you pick, the store's `distance_metric` and the index `similarity` must be the same; the setup script creates the index from `COUCHBASE_DISTANCE_METRIC` for you.

**OpenAI** `text-embedding-3-small`: 1536 dimensions (`EMBEDDING_DIMENSIONS=1536`). Install `openai`; reads `OPENAI_API_KEY`.

```python
from openai import AsyncOpenAI

openai = AsyncOpenAI()

dimensions = 1536


class OpenAIEmbeddings:
    async def embed(self, text: str) -> list[float]:
        response = await openai.embeddings.create(model="text-embedding-3-small", input=text)
        return response.data[0].embedding


embedding_provider = OpenAIEmbeddings()
```

**Amazon Bedrock** Titan Text Embeddings V2: 1024 dimensions (`EMBEDDING_DIMENSIONS=1024`; the model also supports 512 and 256). Install `boto3`; uses your AWS credentials and region, and the model must be enabled in your account. `boto3` is blocking, so the call runs in a thread to keep the agent's event loop free.

```python
import asyncio
import json

import boto3

bedrock = boto3.client("bedrock-runtime")

dimensions = 1024


class TitanEmbeddings:
    async def embed(self, text: str) -> list[float]:
        response = await asyncio.to_thread(
            bedrock.invoke_model,
            modelId="amazon.titan-embed-text-v2:0",
            contentType="application/json",
            body=json.dumps({"inputText": text, "dimensions": dimensions, "normalize": True}),
        )
        embedding: list[float] = json.loads(response["body"].read())["embedding"]
        return embedding


embedding_provider = TitanEmbeddings()
```

**Local model** `all-MiniLM-L6-v2` with [sentence-transformers](https://sbert.net): 384 dimensions (`EMBEDDING_DIMENSIONS=384`). Install `sentence-transformers`. It downloads the model on first use and runs on the CPU, with no API key.

```python
import asyncio

from sentence_transformers import SentenceTransformer

model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

dimensions = 384


class LocalEmbeddings:
    async def embed(self, text: str) -> list[float]:
        vector = await asyncio.to_thread(model.encode, text, normalize_embeddings=True)
        return [float(value) for value in vector]


embedding_provider = LocalEmbeddings()
```

To switch models on an existing setup, start from an empty collection (or a new one): vectors from different models can't be compared, and the index has a fixed dimension. Drop the old index, set `EMBEDDING_DIMENSIONS` and run `python examples/setup.py` again.

## Configuration reference

Pass options as keyword arguments to `CouchbaseMemoryStore(...)`. Where an environment variable is listed, it is used when the option is omitted. The type of the whole set is `CouchbaseMemoryStoreConfig`.

| Option | Env var | Default | Description |
| --- | --- | --- | --- |
| `name` | | `couchbase` | Store name. Strands uses it in logs and to route `search_memory` and `add_memory` calls. |
| `description` | | `Long-term semantic memory stored in Couchbase Hyperscale Vector Search.` | Listed to the model in the `search_memory` and `add_memory` tool descriptions. |
| `embedding_provider` | | required | Object with `embed(text)`, or a function, returning `list[float]` (or a coroutine of one). |
| `dimensions` | | none | Expected vector length. Checked on every embedding and against the index in `initialize()`. Set it. |
| `connection_string` | `COUCHBASE_CONNECTION_STRING` | `couchbase://localhost` | Use `couchbases://` for TLS, which Capella requires. |
| `username` | `COUCHBASE_USERNAME` | none | Required unless you pass `cluster`. |
| `password` | `COUCHBASE_PASSWORD` | none | Required unless you pass `cluster`. |
| `bucket_name` | `COUCHBASE_BUCKET` | `strands_memory` | Must already exist. |
| `scope_name` | `COUCHBASE_SCOPE` | `_default` | |
| `collection_name` | `COUCHBASE_COLLECTION` | `_default` | |
| `namespace` | `COUCHBASE_NAMESPACE` | `default` | Every write is tagged with it and every search is filtered to it. See [Multi-tenancy](#multi-tenancy). |
| `vector_backend` | `COUCHBASE_VECTOR_BACKEND` | `hyperscale` | `hyperscale` (SQL++ and a Hyperscale Vector Index) or `search` (a Search-service vector index). |
| `distance_metric` | `COUCHBASE_DISTANCE_METRIC` | `L2_SQUARED` | `COSINE`, `DOT`, `L2`, `EUCLIDEAN`, `L2_SQUARED` or `EUCLIDEAN_SQUARED` (the `DistanceMetric` type; case-insensitive). Must match the index `similarity`. Hyperscale only. `.env.example` sets `COSINE`. |
| `search_index_name` | `COUCHBASE_SEARCH_INDEX` | `strands-memory-search-index` | Search-service index name. `search` backend only. |
| `centroids_to_probe` | | `8` | Index centroids to search (`nprobes`). Higher finds more at some cost in speed. Hyperscale only. |
| `num_candidates` | | `3 * limit` | Nearest-neighbour candidates per query. `search` backend only. |
| `max_search_results` | | `5` | Memories returned per search. |
| `writable` | | `True` | `False` makes the store read-only: `add()` raises. |
| `extraction` | | off | `True` stores facts distilled by `ModelExtractor`; or pass a Strands `ExtractionConfig`. |
| `validate_on_initialize` | | `True` | Check the vector index in `initialize()`. Set `False` when the credentials can't read `system:indexes` or Search index definitions; `initialize()` then only connects. |
| `cluster` | | none | An already connected `couchbase.cluster.Cluster` to share. The store won't close it. |
| `collection` | | none | An already resolved `couchbase.collection.Collection` to write to. |
| `content_field`, `vector_field`, `metadata_field`, `namespace_field` | | `content`, `embedding`, `metadata`, `namespace` | Document field names. Dotted paths are allowed. Change the index to match. |

The constructor raises `ValueError` for an unknown `vector_backend` or `distance_metric`, a non-positive `centroids_to_probe` or `num_candidates`, a missing `embedding_provider`, and missing credentials when there's no `cluster`.

The examples also read `EMBEDDING_DIMENSIONS` (default `1536`) and `OPENAI_API_KEY`. The store itself doesn't.

## Multi-tenancy

Give each user or tenant their own store with their own `namespace`, and set it from your authenticated session in your code. Never take it from the prompt, a tool argument or anything else the model produces: a search only sees its store's namespace, so whoever controls the namespace controls which memories are read and written. Share one connection between the stores.

```python
import os
from datetime import timedelta

from couchbase.auth import PasswordAuthenticator
from couchbase.cluster import Cluster
from couchbase.options import ClusterOptions
from strands import Agent
from strands.memory import MemoryManager

from strands_couchbase import CouchbaseMemoryStore, EmbeddingProvider

# One connection for the whole app. Stores never close a cluster they were given.
cluster = Cluster(
    os.environ["COUCHBASE_CONNECTION_STRING"],
    ClusterOptions(PasswordAuthenticator(os.environ["COUCHBASE_USERNAME"], os.environ["COUCHBASE_PASSWORD"])),
)
cluster.wait_until_ready(timedelta(seconds=10))


# `user_id` comes from your auth layer, not from the model.
def agent_for_user(user_id: str, embedding_provider: EmbeddingProvider) -> tuple[Agent, MemoryManager]:
    store = CouchbaseMemoryStore(
        name="couchbase",
        cluster=cluster,
        namespace=f"user:{user_id}",
        dimensions=1536,
        embedding_provider=embedding_provider,
        extraction=True,
    )
    memory_manager = MemoryManager(stores=[store])
    # Call `await memory_manager.flush()` when the user's session ends.
    return Agent(memory_manager=memory_manager), memory_manager
```

`couchbase` is installed with this package. For more on credentials and prompt injection, see [Security and multi-tenancy](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/security-and-multitenancy.md).

## Troubleshooting

- **`ValueError: Couchbase credentials are required`** when you run an example: the variables from `.env` aren't in your environment. Run `set -a; source .env; set +a` in the same terminal first. The same goes for an OpenAI error saying `api_key` must be set.
- **`ErrTraining: number of centroids required to train the index are not set`** when creating the index: the collection has no vectors to train on yet. Run `python examples/setup.py`, which seeds vectors first. If you pin the centroid count (`"IVF<n>,SQ8"`), the collection needs at least `n` documents.
- **``RuntimeError: No vector index on `embedding` for ...``** from `initialize()` or at agent start: either there's no index in this bucket, scope and collection, or there is one but it doesn't match the config, and the message says what differs. Run `python examples/setup.py`, or check `COUCHBASE_BUCKET`, `COUCHBASE_SCOPE` and `COUCHBASE_COLLECTION`.
- **Distance metric mismatch**, ``... (strands-memory-vector-index: similarity COSINE does not match distance_metric L2_SQUARED)``: `COUCHBASE_DISTANCE_METRIC` (or `distance_metric`) must name the same metric as the index `similarity`. `EUCLIDEAN` and `L2` are the same metric, as are `EUCLIDEAN_SQUARED` and `L2_SQUARED`. If you turned the check off with `validate_on_initialize=False`, a mismatch doesn't raise: Couchbase can't use the vector index for the query and falls back to a sequential scan of the whole collection (`#sequentialscan` in `EXPLAIN`). Searches get slower as the collection grows. Fix the metric, or drop the index and run `python examples/setup.py` again.
- **Dimension mismatch**, either `embedding provider returned 384 dimensions; expected 1536` or `... dimension 1536 does not match dimensions 384` from `initialize()`: `dimensions`, `EMBEDDING_DIMENSIONS`, the embedding model and the index must all agree. See the end of [Embedding providers](#embedding-providers) to switch models.
- **`store=<couchbase>, reason=<...> | store search failed`** in the log: a search failed while the agent was running, and the agent answered without memory. The `reason` says why; the embedding provider failing (quota, network, key) is the usual cause.
- **`memory extraction failed`** at shutdown: the connection closed while extraction was still writing. `await memory_manager.flush()` before `await store.close()`.
- **`Could not connect to Couchbase at couchbases://...`** with Capella: add your public IP under the cluster's allowed IP addresses, use the `couchbases://` connection string from the cluster's **Connect** page (Capella requires TLS), and use cluster access credentials, not your Capella login.
- **`Authentication failed connecting to Couchbase`**: check `COUCHBASE_USERNAME` and `COUCHBASE_PASSWORD`.
- **No results right after a write, on a small dataset**: raise `centroids_to_probe` so the search covers more of the index.

## Limitations

- **Deduplication is exact-match only.** Writing the same text twice in the same namespace stores it once, because the document key is a hash of the trimmed text. Facts that say the same thing in different words ("The user is training for a half marathon in May." and "Training for a half marathon in May.") are stored separately.
- **The Search backend needs a keyword-analyzed namespace.** With `vector_backend="search"`, the namespace filter is an exact term match, so the Search index must map `namespace` as a text field with the `keyword` analyzer. `initialize()` rejects an index that doesn't.
- **The Couchbase Python SDK is blocking.** The store runs its calls in worker threads with `asyncio.to_thread`, so they don't block the event loop, but each one occupies a thread from the default executor while it runs.

## More documentation

- [MemoryManager usage](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/memorymanager-usage.md): recall, injection, extraction and write semantics in detail.
- [Vector backends](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/vector-backends.md): Hyperscale, Composite and Search-service vector indexes.
- [Changelog](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/python/CHANGELOG.md)

## Development

From `python/` in a clone of the repository:

```bash
pip install hatch
hatch run lint
hatch run typecheck
hatch run test
hatch run build
```

`hatch run format` formats the code, and `hatch run prepare` runs all of the above. Hatch creates its own environment with the development tools, and the package installed from `src/`.

Live integration tests are skipped unless `COUCHBASE_INTEGRATION_TESTS=1` and the Couchbase env vars point at a cluster with a compatible 3-dimension `L2_SQUARED` Hyperscale Vector Index. To run them against a throwaway local Couchbase Server 8:

```bash
docker run -d --name couchbase-strands -p 8091-8097:8091-8097 -p 11210:11210 couchbase:enterprise-8.0.3
../scripts/setup-live-couchbase.sh
export EMBEDDING_DIMENSIONS=3 COUCHBASE_DISTANCE_METRIC=L2_SQUARED
COUCHBASE_INTEGRATION_TESTS=1 hatch run test -m integration
../scripts/smoke-test-python-package.sh
```

`setup-live-couchbase.sh` initializes the cluster, creates the bucket, seeds documents and creates the index. The tests and the smoke test connect as `Administrator` / `password` unless `COUCHBASE_USERNAME` and `COUCHBASE_PASSWORD` say otherwise. If you exported `.env` in this shell, the two variables on the `export` line override its 1536-dimension `COSINE` settings. `smoke-test-python-package.sh` builds the wheel, installs it into a fresh virtual environment outside the repository and runs `examples/smoke_test.py` with it. The same steps run in the `Live - Python` workflow.
