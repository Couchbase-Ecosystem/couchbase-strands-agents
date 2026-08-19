# TypeScript Couchbase MemoryStore package

`@couchbase-examples/strands-couchbase-memory` implements the Strands Agents `MemoryStore` interface with Couchbase Vector Search.

## Install for development

```bash
npm install
npm run build
```

## Minimal usage

```ts
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { CouchbaseMemoryStore } from '@couchbase-examples/strands-couchbase-memory'

const store = new CouchbaseMemoryStore({
  name: 'couchbase',
  connectionString: 'couchbase://localhost',
  username: 'Administrator',
  password: 'password',
  bucketName: 'strands_memory',
  distanceMetric: 'L2_SQUARED',
  dimensions: 3,
  embeddingProvider: { async embed() { return [0, 1, 0] } },
  writable: true,
  extraction: true,
})

const agent = new Agent({ memoryManager: new MemoryManager({ stores: [store] }) })
```

## Checks

```bash
npm run format:check
npm run lint
npm run type-check
npm test
npm run build
npm pack --dry-run
```

Live integration tests are skipped unless `COUCHBASE_INTEGRATION_TESTS=1` and the Couchbase env vars in `.env.example` point at a cluster with a compatible Hyperscale Vector Index.
