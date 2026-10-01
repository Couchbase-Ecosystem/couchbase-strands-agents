// Connectivity check: writes one memory and searches for it, using the store directly with no agent and
// no model. The vectors are toys made from a hash of the text, so the search proves the round trip works,
// not that recall is meaningful. For a real agent with real embeddings, see quickstart.ts.
//
// Run: npm run example:setup && npm run example:smoke   (reads .env)
import { createHash } from 'node:crypto'
import { CouchbaseMemoryStore } from '@couchbase-examples/strands-couchbase-memory'

// Must match the vector index, so the same setup works for this check and for the quickstart.
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536)

function toyEmbedding(text: string): number[] {
  const digest = createHash('sha256').update(text).digest()
  return Array.from({ length: dimensions }, (_, i) => (digest[i % digest.length]! + i) / 255)
}

// Connection settings and the namespace come from the COUCHBASE_* environment variables.
const store = new CouchbaseMemoryStore({ name: 'couchbase', dimensions, embeddingProvider: toyEmbedding })

try {
  // MemoryManager calls this during agent setup; standalone use calls it directly.
  await store.initialize()
  const content = 'Alex prefers dark-mode dashboards and async standups.'
  const key = await store.add(content, { category: 'preference' })
  console.log(`stored key: ${key}`)
  for (const entry of await store.search(content, { maxSearchResults: 3 })) {
    console.log(`hit: ${entry.content} metadata=${JSON.stringify(entry.metadata)}`)
  }
} finally {
  await store.close()
}
