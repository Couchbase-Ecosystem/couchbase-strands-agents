import { describe, expect, it } from 'vitest'
import { CouchbaseMemoryStore, type CouchbaseBackend, type MemoryDocument, type SearchHit } from '../src/index.js'

class FakeBackend implements CouchbaseBackend {
  documents = new Map<string, MemoryDocument>()
  searchCalls: any[] = []

  async upsert(key: string, document: MemoryDocument): Promise<void> {
    this.documents.set(key, document)
  }

  async vectorSearch(input: any): Promise<SearchHit[]> {
    this.searchCalls.push(input)
    return [
      {
        id: 'memory::default::1',
        score: 0.92,
        content: 'User prefers dark-mode dashboards.',
        metadata: { category: 'preference' },
        namespace: input.namespace,
      },
    ]
  }

  async close(): Promise<void> {
    return undefined
  }
}

const embeddingProvider = {
  async embed(text: string): Promise<number[]> {
    if (text.includes('bad')) return [1]
    return [text.length % 3, 1, 0.5]
  },
}

describe('CouchbaseMemoryStore', () => {
  it('stores content with embedding and metadata', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({
      name: 'cb',
      embeddingProvider,
      backend,
      dimensions: 3,
      namespace: 'tenant_a',
      writable: true,
    })

    const key = await store.add('User prefers dark-mode dashboards.', { category: 'preference', id: 'memory-1' })

    expect(key).toBe('memory-1')
    expect(backend.documents.get(key)).toMatchObject({
      content: 'User prefers dark-mode dashboards.',
      namespace: 'tenant_a',
      metadata: { category: 'preference' },
    })
    expect(backend.documents.get(key)?.embedding).toHaveLength(3)
  })

  it('maps search hits to Strands memory entries', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({
      name: 'cb',
      embeddingProvider,
      backend,
      dimensions: 3,
      namespace: 'tenant_b',
      maxSearchResults: 7,
    })

    const entries = await store.search('dashboard preferences', { maxSearchResults: 2 })

    expect(entries).toEqual([
      {
        content: 'User prefers dark-mode dashboards.',
        metadata: {
          category: 'preference',
          id: 'memory::default::1',
          score: 0.92,
          namespace: 'tenant_b',
        },
      },
    ])
    expect(backend.searchCalls[0].limit).toBe(2)
    expect(backend.searchCalls[0].namespace).toBe('tenant_b')
    expect(backend.searchCalls[0].vectorBackend).toBe('hyperscale')
    expect(backend.searchCalls[0].distanceMetric).toBe('L2_SQUARED')
  })

  it('fails fast on dimension mismatch', async () => {
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend: new FakeBackend(), dimensions: 3 })
    await expect(store.add('bad vector')).rejects.toThrow('expected 3')
  })

  it('rejects add when not writable', async () => {
    const store = new CouchbaseMemoryStore({
      name: 'cb',
      embeddingProvider,
      backend: new FakeBackend(),
      writable: false,
    })
    await expect(store.add('hello')).rejects.toThrow('not writable')
  })

  it('stores message role metadata', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend })
    const keys = await store.addMessages([
      { role: 'user', content: [{ text: 'Remember my timezone is UTC.' }] },
      { role: 'assistant', content: [{ text: 'Noted.' }] },
    ])

    expect(keys).toHaveLength(2)
    const docs = [...backend.documents.values()]
    expect(docs[0]?.metadata.role).toBe('user')
    expect(docs[1]?.metadata.role).toBe('assistant')
  })
})
