# Couchbase memory for Strands Agents (TypeScript)

`@couchbase-ecosystem/strands-couchbase` gives [Strands Agents](https://strandsagents.com) long-term memory that outlives a conversation. It implements the Strands `MemoryStore` interface: the agent's `MemoryManager` writes short facts about the user into Couchbase, and before each model call it looks up the ones relevant to the current message with vector search and adds them to the prompt. Restart the process, start a new agent, and it still knows that Alex is vegetarian.

## Requirements

- **Couchbase Server 8.0 or later**, or **Couchbase Capella** on 8.0 or later, with the Data, Query and Index services. Memories are searched with a Hyperscale Vector Index, which needs 8.0.
- **Node.js 22 or later.**
- **`@strands-agents/sdk` `>=1.13.0 <2.0.0`**, installed alongside this package as a peer dependency.
- **An embedding model.** The store doesn't create embeddings itself. You pass a function that turns text into a vector: OpenAI, Amazon Bedrock and a local model are shown [below](#embedding-providers).
- **A chat model for the agent.** If you don't pass `model`, Strands uses Amazon Bedrock with your AWS credentials. The quickstart uses OpenAI so that one API key covers both models.

## Install

```bash
npm install @couchbase-ecosystem/strands-couchbase @strands-agents/sdk
npm install openai@6   # the model provider you use; Strands supports openai 6.x
```

The package is **ESM-only**: use `import`. On Node.js 22.12 and later, `require()` also works through Node's built-in `require(esm)`; on earlier 22.x releases, CommonJS code must use `await import('@couchbase-ecosystem/strands-couchbase')`.

## Quickstart

This takes about 10 minutes and needs Docker, Node.js 22, git and an OpenAI API key. At the end, a brand-new agent answers from facts a previous agent stored.

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
cd couchbase-strands-agents/typescript
npm install
cp .env.example .env   # then set OPENAI_API_KEY in .env
npm run example:setup
```

```text
Seeding 256 training vectors (1536 dimensions) into namespace '_seed'...
Creating Hyperscale Vector Index strands-memory-vector-index (dimension 1536, L2_SQUARED)...
Index strands-memory-vector-index is online. Couchbase is ready.
```

A Hyperscale Vector Index learns its structure from vectors that are already in the collection, so it can't be created on an empty one. [`examples/setup.ts`](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/typescript/examples/setup.ts) writes placeholder vectors into a `_seed` namespace first, then creates the index with the dimension and distance metric from `.env` and waits until it is online. The store never returns the seed documents, because every search filters on the store's own namespace. You can run the script again safely.

### 3. Run the two-session example

```bash
npm run example:quickstart
```

Session 1 tells an agent some facts and waits for them to be stored. Session 2 is a new agent and `MemoryManager` with no shared history; it can only know about Alex through Couchbase. Your agent's wording will differ:

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

`npm run example:smoke` is a quicker connectivity check: it writes and searches one memory through the store directly, with toy vectors and no model.

### Use it in your own project

After `npm install` (see [Install](#install)), this is the whole quickstart. It reads the Couchbase connection from the `COUCHBASE_*` environment variables listed in the [configuration reference](#configuration-reference). Run `examples/setup.ts` once against your cluster to create the index.

<!-- embed: examples/quickstart.ts -->

```ts
// Two sessions, one memory. Session 1 tells the agent a few facts; session 2 is a brand-new agent with no
// conversation history that answers from what Couchbase remembered.
//
// Run: npm run example:setup && npm run example:quickstart   (reads .env; needs OPENAI_API_KEY)
//
// OpenAI is used for both the chat model and the embeddings, so one API key is enough. To switch:
// - Chat model: pass any Strands model, e.g. `new BedrockModel()` from '@strands-agents/sdk/models/bedrock'.
//   Without `model`, Strands uses Amazon Bedrock and your AWS credentials.
// - Embeddings: see "Embedding providers" in the README for Bedrock Titan and a local model. Set
//   EMBEDDING_DIMENSIONS to the new model's size and run the setup script again on an empty collection.
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import OpenAI from 'openai'
import { CouchbaseMemoryStore } from '@couchbase-ecosystem/strands-couchbase'

const openai = new OpenAI() // reads OPENAI_API_KEY

// Connection settings come from the COUCHBASE_* environment variables (see .env.example).
const store = new CouchbaseMemoryStore({
  name: 'couchbase',
  // One namespace per user. Bind it in your code, never from model output.
  namespace: 'user-alex',
  dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
  embeddingProvider: async (text) => {
    const response = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
    return response.data[0]!.embedding
  },
  // Distil each conversation into short facts with the agent's model and store them.
  extraction: true,
})

async function session(prompt: string): Promise<void> {
  // A fresh agent and MemoryManager each time: nothing carries over except what is in Couchbase.
  const memoryManager = new MemoryManager({ stores: [store] })
  const agent = new Agent({ model: new OpenAIModel({ modelId: 'gpt-5.4-mini' }), memoryManager, printer: false })
  console.log(`\nUser:  ${prompt}`)
  const result = await agent.invoke(prompt)
  console.log(`Agent: ${String(result).trim()}`)
  // Extraction runs in the background. Wait for it before the next session reads, and before close().
  await memoryManager.flush()
}

try {
  console.log('--- Session 1 ---')
  await session("Hi! I'm Alex. I'm vegetarian, I live in Lisbon, and I'm training for a half marathon in May.")

  console.log('\n--- Session 2 (new agent, no shared history) ---')
  await session('Can you suggest a dinner for me tonight and remind me what I am training for?')

  console.log('\n--- Stored memories ---')
  for (const entry of await store.search('Alex', { maxSearchResults: 10 })) {
    console.log(`- ${entry.content}`)
  }
} finally {
  await store.close()
}
```

If you'd rather create the index yourself, write at least one document with an `embedding` of the right size first, then run:

```sql
CREATE VECTOR INDEX `strands-memory-vector-index`
ON `strands_memory`.`_default`.`_default` (`embedding` VECTOR)
INCLUDE (`content`, `metadata`, `namespace`)
USING GSI
WITH {"dimension": 1536, "similarity": "L2_SQUARED", "description": "IVF,SQ8"};
```

## How it works

Attaching the store to a `MemoryManager` turns on three Strands behaviors:

- **Recall.** The agent gets a `search_memory` tool it can call when it wants to look something up.
- **Injection.** Before each model call, `MemoryManager` searches the store with the latest user message and adds the closest memories to the model input in a `<memory>` block. The conversation history itself isn't changed. This is on by default.
- **Extraction.** With `extraction: true`, Strands' `ModelExtractor` asks the agent's model to distil the conversation into short standalone facts ("Alex is vegetarian.") and stores each one with `store.add()`. Raw conversation turns are not stored. Extraction runs in the background, every 5 turns by default; pass an `ExtractionConfig` instead of `true` to change the trigger, extractor or message filter.

Each memory is one JSON document in your collection: `content`, `embedding`, `metadata`, `namespace`, `created_at` and `updated_at`. Searches use SQL++ `APPROX_VECTOR_DISTANCE` against the Hyperscale Vector Index, filtered to the store's namespace.

Two rules keep this working:

- **Always `await memoryManager.flush()` before `store.close()`.** It saves whatever extraction hasn't saved yet and waits for the writes. Without it, a short session may never be stored (the default trigger is 5 turns), and writes still running when the connection closes fail with `cluster_closed (1006)`.
- **Check for `store search failed` warnings.** If a search fails while the agent is running (the embedding API is down, say), Strands logs a warning and the agent carries on without memory rather than failing. `MemoryManager` awaits `store.initialize()` when the agent starts, so missing indexes, wrong dimensions or metrics, and bad credentials fail there with a clear error. Call `await store.initialize()` yourself when you use the store without `MemoryManager`.

## Embedding providers

An embedding provider is any object with an `embed(text)` method, or a plain function, that returns a `number[]`. Its length must equal the store's `dimensions` and the index `dimension`, so set `EMBEDDING_DIMENSIONS` before `npm run example:setup`. All three examples return unit-length vectors, so the default `L2_SQUARED` metric ranks results the same way cosine similarity would; keep `COUCHBASE_DISTANCE_METRIC=L2_SQUARED`.

**OpenAI** `text-embedding-3-small`: 1536 dimensions (`EMBEDDING_DIMENSIONS=1536`). Install `openai@6`; reads `OPENAI_API_KEY`.

```ts
import OpenAI from 'openai'
import type { EmbeddingProvider } from '@couchbase-ecosystem/strands-couchbase'

const openai = new OpenAI()

export const dimensions = 1536
export const embeddingProvider: EmbeddingProvider = {
  async embed(text) {
    const response = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
    return response.data[0]!.embedding
  },
}
```

**Amazon Bedrock** Titan Text Embeddings V2: 1024 dimensions (`EMBEDDING_DIMENSIONS=1024`; the model also supports 512 and 256). Install `@aws-sdk/client-bedrock-runtime`; uses your AWS credentials and region, and the model must be enabled in your account.

```ts
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import type { EmbeddingProvider } from '@couchbase-ecosystem/strands-couchbase'

const bedrock = new BedrockRuntimeClient()

export const dimensions = 1024
export const embeddingProvider: EmbeddingProvider = {
  async embed(text) {
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: 'amazon.titan-embed-text-v2:0',
        contentType: 'application/json',
        body: JSON.stringify({ inputText: text, dimensions, normalize: true }),
      })
    )
    return JSON.parse(new TextDecoder().decode(response.body)).embedding
  },
}
```

**Local model** `all-MiniLM-L6-v2` with [Transformers.js](https://huggingface.co/docs/transformers.js): 384 dimensions (`EMBEDDING_DIMENSIONS=384`). Install `@huggingface/transformers`. It downloads the model on first use and runs on the CPU, with no API key.

```ts
import { pipeline } from '@huggingface/transformers'
import type { EmbeddingProvider } from '@couchbase-ecosystem/strands-couchbase'

const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')

export const dimensions = 384
export const embeddingProvider: EmbeddingProvider = {
  async embed(text) {
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data as Float32Array)
  },
}
```

To switch models on an existing setup, start from an empty collection (or a new one): vectors from different models can't be compared, and the index has a fixed dimension. Drop the old index, set `EMBEDDING_DIMENSIONS` and run `npm run example:setup` again.

## Configuration reference

Pass options to `new CouchbaseMemoryStore({...})`. Where an environment variable is listed, it is used when the option is omitted.

| Option | Env var | Default | Description |
| --- | --- | --- | --- |
| `name` | | required | Store name. Strands uses it in logs and to route `search_memory` and `add_memory` calls. |
| `description` | | `Long-term semantic memory stored in Couchbase Hyperscale Vector Search.` | Listed to the model in the `search_memory` and `add_memory` tool descriptions. |
| `embeddingProvider` | | required | `{ embed(text) }` object or function returning `number[]` (or a promise of one). |
| `dimensions` | | none | Expected vector length. Checked on every embedding and against the index in `initialize()`. Set it. |
| `connectionString` | `COUCHBASE_CONNECTION_STRING` | `couchbase://localhost` | Use `couchbases://` for TLS, which Capella requires. |
| `username` | `COUCHBASE_USERNAME` | none | Required unless you pass `cluster`. |
| `password` | `COUCHBASE_PASSWORD` | none | Required unless you pass `cluster`. |
| `bucketName` | `COUCHBASE_BUCKET` | `strands_memory` | Must already exist. |
| `scopeName` | `COUCHBASE_SCOPE` | `_default` | |
| `collectionName` | `COUCHBASE_COLLECTION` | `_default` | |
| `namespace` | `COUCHBASE_NAMESPACE` | `default` | Every write is tagged with it and every search is filtered to it. See [Multi-tenancy](#multi-tenancy). |
| `vectorBackend` | `COUCHBASE_VECTOR_BACKEND` | `hyperscale` | `hyperscale` (SQL++ and a Hyperscale Vector Index) or `search` (a Search-service vector index). |
| `distanceMetric` | `COUCHBASE_DISTANCE_METRIC` | `L2_SQUARED` | `COSINE`, `DOT`, `L2`, `EUCLIDEAN`, `L2_SQUARED` or `EUCLIDEAN_SQUARED`. Must match the index `similarity`. Hyperscale only. |
| `searchIndexName` | `COUCHBASE_SEARCH_INDEX` | `strands-memory-search-index` | Search-service index name. `search` backend only. |
| `centroidsToProbe` | | `8` | Index centroids to search (`nprobes`). Higher finds more at some cost in speed. Hyperscale only. |
| `numCandidates` | | `3 × limit` | Nearest-neighbour candidates per query. `search` backend only. |
| `maxSearchResults` | | `5` | Memories returned per search. |
| `writable` | | `true` | `false` makes the store read-only: `add()` throws, and `MemoryManager` rejects `extraction` on it. |
| `extraction` | | off | `true` stores facts distilled by `ModelExtractor`; or pass a Strands `ExtractionConfig`. |
| `validateOnInitialize` | | `true` | Check the vector index in `initialize()`. Set `false` when the credentials can't read `system:indexes` or Search index definitions; `initialize()` then only connects. |
| `cluster` | | none | An already connected `couchbase.Cluster` to share. The store won't close it. |
| `collection` | | none | An already resolved `couchbase.Collection` to write to. |
| `contentField`, `vectorField`, `metadataField`, `namespaceField` | | `content`, `embedding`, `metadata`, `namespace` | Document field names. Dotted paths are allowed. Change the index to match. |

The examples also read `EMBEDDING_DIMENSIONS` (default `1536`) and `OPENAI_API_KEY`. The store itself doesn't.

## Multi-tenancy

Give each user or tenant their own store with their own `namespace`, and set it from your authenticated session in your code. Never take it from the prompt, a tool argument or anything else the model produces: a search only sees its store's namespace, so whoever controls the namespace controls which memories are read and written. Share one connection between the stores.

```ts
import * as couchbase from 'couchbase'
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { CouchbaseMemoryStore, type EmbeddingProvider } from '@couchbase-ecosystem/strands-couchbase'

// One connection for the whole app. Stores never close a cluster they were given.
const cluster = await couchbase.connect(process.env.COUCHBASE_CONNECTION_STRING!, {
  username: process.env.COUCHBASE_USERNAME!,
  password: process.env.COUCHBASE_PASSWORD!,
})

// `userId` comes from your auth layer, not from the model.
export function agentForUser(userId: string, embeddingProvider: EmbeddingProvider) {
  const store = new CouchbaseMemoryStore({
    name: 'couchbase',
    cluster,
    namespace: `user:${userId}`,
    dimensions: 1536,
    embeddingProvider,
    extraction: true,
  })
  const memoryManager = new MemoryManager({ stores: [store] })
  // Call `await memoryManager.flush()` when the user's session ends.
  return { agent: new Agent({ memoryManager }), memoryManager }
}
```

`couchbase` is installed with this package. For more on credentials and prompt injection, see [Security and multi-tenancy](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/security-and-multitenancy.md).

## Troubleshooting

- **`ErrTraining: number of centroids required to train the index are not set`** when creating the index: the collection has no vectors to train on yet. Run `npm run example:setup`, which seeds vectors first. If you pin the centroid count (`"IVF<n>,SQ8"`), the collection needs at least `n` documents.
- **``No vector index on `embedding` found for ...``** from `initialize()` or at agent start: the index doesn't exist in this bucket, scope and collection. Run `npm run example:setup`, or check `COUCHBASE_BUCKET`, `COUCHBASE_SCOPE` and `COUCHBASE_COLLECTION`.
- **`store=<couchbase>, reason=<...> | store search failed`** in the log: a search failed while the agent was running, and the agent answered without memory. The `reason` says why; the embedding provider failing (quota, network, key) is the usual cause.
- **Dimension mismatch**, either `embedding provider returned 384 dimensions; expected 1536` or `... dimension 1536 does not match dimensions 384` from `initialize()`: `dimensions`, `EMBEDDING_DIMENSIONS`, the embedding model and the index must all agree. See the end of [Embedding providers](#embedding-providers) to switch models.
- **`memory extraction failed` with `cluster_closed (1006)`** at shutdown: the connection closed while extraction was still writing. `await memoryManager.flush()` before `await store.close()`.
- **`Could not connect to Couchbase at couchbases://...`** with Capella: add your public IP under the cluster's allowed IP addresses, use the `couchbases://` connection string from the cluster's **Connect** page (Capella requires TLS), and use cluster access credentials, not your Capella login.
- **`Authentication failed connecting to Couchbase`**: check `COUCHBASE_USERNAME` and `COUCHBASE_PASSWORD`.
- **No results right after a write, on a small dataset**: raise `centroidsToProbe` so the search covers more of the index.

## Limitations

- **Deduplication is exact-match only.** Writing the same text twice in the same namespace stores it once, because the document key is a hash of the trimmed text. Facts that say the same thing in different words ("Alex is training for a half marathon in May." and "Training for a half marathon in May.") are stored separately.
- **ESM-only.** There is no CommonJS build; see [Install](#install).
- **The Search backend needs a keyword-analyzed namespace.** With `vectorBackend: 'search'`, the namespace filter is an exact term match, so the Search index must map `namespace` as a text field with the `keyword` analyzer. `initialize()` rejects an index that doesn't.

## More documentation

- [MemoryManager usage](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/memorymanager-usage.md): recall, injection, extraction and write semantics in detail.
- [Vector backends](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/vector-backends.md): Hyperscale, Composite and Search-service vector indexes.
- [Changelog](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/typescript/CHANGELOG.md)

## Development

```bash
npm install
npm run format:check
npm run lint
npm run type-check   # also compiles every TypeScript block in this README
npm test
npm run build
npm run smoke:package   # installs the packed tarball in a clean project and uses it
```

Run `npm run readme:sync` after editing a file under `examples/` that this README embeds.

Live integration tests are skipped unless `COUCHBASE_INTEGRATION_TESTS=1` and the Couchbase env vars in `.env.example` point at a cluster with a compatible 3-dimension Hyperscale Vector Index. Each run writes to a fresh `vitest-<uuid>` namespace and deletes it afterwards. To run them against a throwaway local Couchbase Server 8:

```bash
docker run -d --name couchbase-strands -p 8091-8097:8091-8097 -p 11210:11210 couchbase:enterprise-8.0.3
../scripts/setup-live-couchbase.sh   # cluster init, bucket, seed documents, vector index
COUCHBASE_INTEGRATION_TESTS=1 npm run test:live
COUCHBASE_INTEGRATION_TESTS=1 EMBEDDING_DIMENSIONS=3 npm run smoke:package   # also runs examples/smoke-test.ts from the tarball
```

The same steps run in the `Live - TypeScript` workflow on pull requests, nightly and on demand.
