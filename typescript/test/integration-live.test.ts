import { describe, expect, it } from 'vitest'
import { CouchbaseMemoryStore } from '../src/index.js'

const hasLiveEnv = process.env.COUCHBASE_INTEGRATION_TESTS === '1'

const embeddingProvider = {
  async embed(text: string): Promise<number[]> {
    const vector = [0, 0, 0]
    vector[text.length % 3] = 1
    return vector
  },
}

describe.skipIf(!hasLiveEnv)('live Couchbase integration', () => {
  it('adds and searches through Couchbase Vector Search', async () => {
    const store = new CouchbaseMemoryStore({
      name: 'cb-live',
      embeddingProvider,
      dimensions: 3,
      connectionString: process.env.COUCHBASE_CONNECTION_STRING ?? 'couchbase://localhost',
      username: process.env.COUCHBASE_USERNAME ?? 'Administrator',
      password: process.env.COUCHBASE_PASSWORD ?? 'password',
      bucketName: process.env.COUCHBASE_BUCKET ?? 'strands_memory',
      scopeName: process.env.COUCHBASE_SCOPE ?? '_default',
      collectionName: process.env.COUCHBASE_COLLECTION ?? '_default',
      searchIndexName: process.env.COUCHBASE_SEARCH_INDEX ?? 'strands-memory-index',
      namespace: process.env.COUCHBASE_NAMESPACE ?? 'vitest',
    })
    try {
      const key = await store.add('live integration memory prefers dark mode', { test: 'live' })
      expect(key).toBeTruthy()
      const results = await store.search('dark mode', { maxSearchResults: 3 })
      expect(results.some((entry) => entry.content.includes('dark mode'))).toBe(true)
    } finally {
      await store.close()
    }
  })
})
