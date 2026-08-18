import { CouchbaseMemoryStore } from '../src/index.js'

const embeddingProvider = {
  async embed(text: string): Promise<number[]> {
    const vector = [0, 0, 0]
    vector[text.length % 3] = 1
    return vector
  },
}

const store = new CouchbaseMemoryStore({
  name: 'couchbase-demo',
  connectionString: process.env.COUCHBASE_CONNECTION_STRING ?? 'couchbase://localhost',
  username: process.env.COUCHBASE_USERNAME ?? 'Administrator',
  password: process.env.COUCHBASE_PASSWORD ?? 'password',
  bucketName: process.env.COUCHBASE_BUCKET ?? 'strands_memory',
  scopeName: process.env.COUCHBASE_SCOPE ?? '_default',
  collectionName: process.env.COUCHBASE_COLLECTION ?? '_default',
  searchIndexName: process.env.COUCHBASE_SEARCH_INDEX ?? 'strands-memory-index',
  namespace: process.env.COUCHBASE_NAMESPACE ?? 'demo',
  embeddingProvider,
  dimensions: 3,
  writable: true,
})

try {
  const key = await store.add('Alex prefers dark-mode dashboards and async standups.', { category: 'preference' })
  console.log(`stored key: ${key}`)
  console.log('Search indexes update asynchronously; wait for indexing before expecting a hit.')
  const entries = await store.search('How does Alex like to work?', { maxSearchResults: 3 })
  for (const entry of entries) {
    console.log(`hit: ${entry.content} metadata=${JSON.stringify(entry.metadata)}`)
  }
} finally {
  await store.close()
}
