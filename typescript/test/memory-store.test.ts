import { MemoryManager, ModelExtractor } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'
import { CouchbaseMemoryStore, type CouchbaseBackend, type MemoryDocument, type SearchHit } from '../src/index.js'

class FakeBackend implements CouchbaseBackend {
  documents = new Map<string, MemoryDocument>()
  searchCalls: any[] = []

  async upsert(key: string, document: MemoryDocument): Promise<void> {
    this.documents.set(key, document)
  }

  async insertIfAbsent(key: string, document: MemoryDocument): Promise<boolean> {
    if (this.documents.has(key)) return false
    this.documents.set(key, document)
    return true
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

  it('deduplicates identical content and keeps the original document', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend })

    const first = await store.add('The user lives in Denver.', { source: 'session-1' })
    const original = { ...backend.documents.get(first) }
    const second = await store.add('  The user lives in Denver.\n', { source: 'session-2' })

    expect(second).toBe(first)
    expect(first.startsWith('memory::default::')).toBe(true)
    expect(backend.documents.size).toBe(1)
    expect(backend.documents.get(first)).toEqual(original)
    expect(backend.documents.get(first)?.metadata).toEqual({ source: 'session-1' })
  })

  it('does not merge different content', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend })

    const first = await store.add('The user lives in Denver.')
    const second = await store.add('the user lives in denver.')

    expect(second).not.toBe(first)
    expect(backend.documents.size).toBe(2)
  })

  it('overwrites when an explicit id is given', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend })

    await store.add('The user lives in Denver.', { id: 'memory-1' })
    const key = await store.add('The user lives in Boulder.', { memory_id: 'memory-1' })

    expect(key).toBe('memory-1')
    expect(backend.documents.size).toBe(1)
    expect(backend.documents.get(key)?.content).toBe('The user lives in Boulder.')
  })

  it('stores the same content once per namespace', async () => {
    const backend = new FakeBackend()
    const storeA = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend, namespace: 'tenant_a' })
    const storeB = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend, namespace: 'tenant_b' })

    const keyA = await storeA.add('The user lives in Denver.')
    const keyB = await storeB.add('The user lives in Denver.')

    expect(keyA.startsWith('memory::tenant_a::')).toBe(true)
    expect(keyB.startsWith('memory::tenant_b::')).toBe(true)
    expect(backend.documents.size).toBe(2)
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

  it('resolves extraction: true to a ModelExtractor', () => {
    const store = new CouchbaseMemoryStore({
      name: 'cb',
      embeddingProvider,
      backend: new FakeBackend(),
      extraction: true,
    })
    const manager = new MemoryManager({ stores: [store] })

    // Strands only distills facts client-side for stores without `addMessages`;
    // otherwise raw turns are handed to the store as-is.
    const [binding] = (manager as any)._extractionStores
    expect(binding.config.extractor).toBeInstanceOf(ModelExtractor)
  })
})
