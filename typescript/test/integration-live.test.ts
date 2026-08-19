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

async function waitForSearchHit(search: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let found = false
  while (Date.now() < deadline) {
    found = await search()
    if (found) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  expect(found, 'Couchbase Search did not return the inserted memory before the timeout').toBe(true)
}

describe.skipIf(!hasLiveEnv)('live Couchbase integration', () => {
  it('adds and searches through Couchbase Hyperscale Vector Search', async () => {
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
      searchIndexName: process.env.COUCHBASE_SEARCH_INDEX ?? 'strands-memory-search-index',
      namespace: process.env.COUCHBASE_NAMESPACE ?? 'vitest',
    })
    try {
      const key = await store.add('live integration memory prefers dark mode', { test: 'live' })
      expect(key).toBeTruthy()
      await waitForSearchHit(async () => {
        const results = await store.search('dark mode', { maxSearchResults: 3 })
        return results.some((entry) => entry.content.includes('dark mode'))
      })
    } finally {
      await store.close()
    }
  })
})
