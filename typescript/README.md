# TypeScript Couchbase MemoryStore package

`@couchbase-examples/strands-couchbase-memory` implements the Strands Agents `MemoryStore` interface with Couchbase Hyperscale Vector Search.

## Requirements

- Node.js 22 or later.
- `@strands-agents/sdk` `>=1.13.0 <2.0.0` (peer dependency). CI tests the lowest and the latest versions in that range.
- The package is **ESM-only**: it ships no CommonJS build. Use `import`. On Node.js 22.12 and later, `require()` also works through Node's built-in `require(esm)` support; on earlier 22.x releases, CommonJS code must use `await import('@couchbase-examples/strands-couchbase-memory')`.

```bash
npm install @couchbase-examples/strands-couchbase-memory @strands-agents/sdk
```

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
npm run smoke:package   # installs the packed tarball in a clean project and uses it
```

Live integration tests are skipped unless `COUCHBASE_INTEGRATION_TESTS=1` and the Couchbase env vars in `.env.example` point at a cluster with a compatible 3-dimension Hyperscale Vector Index. Each run writes to a fresh `vitest-<uuid>` namespace and deletes it afterwards. To run them against a throwaway local Couchbase Server 8:

```bash
docker run -d --name couchbase-strands -p 8091-8097:8091-8097 -p 11210:11210 couchbase:enterprise-8.0.3
../scripts/setup-live-couchbase.sh   # cluster init, bucket, seed documents, vector index
COUCHBASE_INTEGRATION_TESTS=1 npm run test:live
COUCHBASE_INTEGRATION_TESTS=1 npm run smoke:package   # also runs the quickstart from the tarball
```

The same steps run in the `Live - TypeScript` workflow on pull requests, nightly and on demand.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
