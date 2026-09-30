import { describe, expect, it } from 'vitest'
import { CouchbaseMemoryStore, type CouchbaseMemoryStoreConfig } from '../src/index.js'

const hasLiveEnv = process.env.COUCHBASE_INTEGRATION_TESTS === '1'

// Expects the 3-dimension L2_SQUARED Hyperscale Vector Index used by integration-live.test.ts.
function liveStore(overrides: Partial<CouchbaseMemoryStoreConfig> = {}): CouchbaseMemoryStore {
  return new CouchbaseMemoryStore({
    name: 'cb-live-init',
    embeddingProvider: () => [1, 0, 0],
    dimensions: 3,
    connectionString: process.env.COUCHBASE_CONNECTION_STRING ?? 'couchbase://localhost',
    username: process.env.COUCHBASE_USERNAME ?? 'Administrator',
    password: process.env.COUCHBASE_PASSWORD ?? 'password',
    bucketName: process.env.COUCHBASE_BUCKET ?? 'strands_memory',
    scopeName: process.env.COUCHBASE_SCOPE ?? '_default',
    collectionName: process.env.COUCHBASE_COLLECTION ?? '_default',
    ...overrides,
  })
}

async function initializeAndClose(store: CouchbaseMemoryStore): Promise<void> {
  try {
    await store.initialize()
  } finally {
    await store.close()
  }
}

describe.skipIf(!hasLiveEnv)('live Couchbase initialize', () => {
  it('accepts the configured Hyperscale Vector Index', async () => {
    await expect(initializeAndClose(liveStore())).resolves.toBeUndefined()
  })

  it('rejects a dimension mismatch', async () => {
    await expect(initializeAndClose(liveStore({ dimensions: 4 }))).rejects.toThrow('does not match dimensions 4')
  })

  it('rejects a distance metric mismatch', async () => {
    await expect(initializeAndClose(liveStore({ distanceMetric: 'COSINE' }))).rejects.toThrow(
      'does not match distanceMetric COSINE'
    )
  })

  it('rejects a vector field without an index', async () => {
    await expect(initializeAndClose(liveStore({ vectorField: 'no_such_vector' }))).rejects.toThrow(
      'No vector index on `no_such_vector`'
    )
  })

  it('rejects bad credentials', async () => {
    await expect(initializeAndClose(liveStore({ password: 'definitely-wrong-password' }))).rejects.toThrow(
      'Authentication failed'
    )
  })
})
