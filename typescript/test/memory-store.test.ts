import { MemoryManager, ModelExtractor } from '@strands-agents/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CouchbaseMemoryStore, type MemoryDocument } from '../src/index.js'
import type { CouchbaseBackend, IndexValidation, SearchHit } from '../src/memory-store.js'

class FakeBackend implements CouchbaseBackend {
  documents = new Map<string, MemoryDocument>()
  searchCalls: any[] = []
  initializeCalls: (IndexValidation | undefined)[] = []

  async initialize(validation?: IndexValidation): Promise<void> {
    this.initializeCalls.push(validation)
  }

  async upsert(key: string, document: MemoryDocument): Promise<void> {
    this.documents.set(key, document)
  }

  async exists(key: string): Promise<boolean> {
    return this.documents.has(key)
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

class FakeEmbeddingProvider {
  calls: string[] = []

  async embed(text: string): Promise<number[]> {
    this.calls.push(text)
    if (text.includes('bad')) return [1]
    return [text.length % 3, 1, 0.5]
  }
}

const embeddingProvider = new FakeEmbeddingProvider()

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

  it('derives a pinned key from the content', async () => {
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend: new FakeBackend() })

    const key = await store.add('The user lives in Denver.')

    // Must match the Python test. A format change here breaks dedupe against existing documents.
    expect(key).toBe('memory::default::e41780f3836366c4355c59adda79e297c41ea63d3c04bbc62a609ffd2bc5ac0a')
  })

  it('skips the embedding call for duplicate content', async () => {
    const embedder = new FakeEmbeddingProvider()
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider: embedder, backend: new FakeBackend() })

    await store.add('The user lives in Denver.')
    await store.add('The user lives in Denver.')

    expect(embedder.calls).toEqual(['The user lives in Denver.'])
  })

  it('keeps the original when an insert races past the exists check', async () => {
    class RacingBackend extends FakeBackend {
      override async exists(): Promise<boolean> {
        return false
      }
    }
    const backend = new RacingBackend()
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend })

    const first = await store.add('The user lives in Denver.', { source: 'session-1' })
    const second = await store.add('The user lives in Denver.', { source: 'session-2' })

    expect(second).toBe(first)
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

  it('initialize validates the index with the store config', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({
      name: 'cb',
      embeddingProvider,
      backend,
      dimensions: 3,
      vectorField: 'vec',
      distanceMetric: 'COSINE',
    })

    await store.initialize()

    expect(backend.initializeCalls).toEqual([
      {
        vectorBackend: 'hyperscale',
        searchIndexName: 'strands-memory-search-index',
        vectorField: 'vec',
        namespaceField: 'namespace',
        distanceMetric: 'COSINE',
        dimensions: 3,
      },
    ])
  })

  it('initialize only connects when validateOnInitialize is false', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend, validateOnInitialize: false })

    await store.initialize()

    expect(backend.initializeCalls).toEqual([undefined])
  })

  it('MemoryManager surfaces initialize failures instead of swallowing them', async () => {
    class BrokenBackend extends FakeBackend {
      override async initialize(): Promise<void> {
        throw new Error('No vector index on `embedding`')
      }
    }
    const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend: new BrokenBackend() })
    const manager = new MemoryManager({ stores: [store] })

    await expect((manager as any)._initStores()).rejects.toThrow('No vector index')
  })

  it('passes centroidsToProbe and numCandidates separately', async () => {
    const backend = new FakeBackend()
    const store = new CouchbaseMemoryStore({
      name: 'cb',
      embeddingProvider,
      backend,
      centroidsToProbe: 16,
      numCandidates: 40,
    })

    await store.search('dashboards')

    expect(backend.searchCalls[0]).toMatchObject({ centroidsToProbe: 16, numCandidates: 40 })
  })

  it.each([0, -1, 1.5])('rejects centroidsToProbe %s', (value) => {
    expect(
      () =>
        new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend: new FakeBackend(), centroidsToProbe: value })
    ).toThrow('centroidsToProbe must be a positive integer')
  })

  it('rejects an unknown distanceMetric in the constructor', () => {
    expect(
      () =>
        new CouchbaseMemoryStore({
          name: 'cb',
          embeddingProvider,
          backend: new FakeBackend(),
          distanceMetric: 'HAMMING' as any,
        })
    ).toThrow("distanceMetric must be one of COSINE, DOT, L2, EUCLIDEAN, L2_SQUARED, EUCLIDEAN_SQUARED; got 'HAMMING'")
  })

  describe('environment variables', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it.each([
      ['HYPERSCALE', 'hyperscale'],
      [' Search ', 'search'],
    ])('normalizes COUCHBASE_VECTOR_BACKEND=%j', async (value, expected) => {
      vi.stubEnv('COUCHBASE_VECTOR_BACKEND', value)
      const backend = new FakeBackend()
      const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend })

      await store.search('dashboards')

      expect(backend.searchCalls[0].vectorBackend).toBe(expected)
    })

    it('rejects an unknown COUCHBASE_VECTOR_BACKEND', () => {
      vi.stubEnv('COUCHBASE_VECTOR_BACKEND', 'fts')
      expect(() => new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend: new FakeBackend() })).toThrow(
        "vectorBackend must be 'hyperscale' or 'search'; got 'fts'"
      )
    })

    it('normalizes COUCHBASE_DISTANCE_METRIC', async () => {
      vi.stubEnv('COUCHBASE_DISTANCE_METRIC', 'cosine')
      const backend = new FakeBackend()
      const store = new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend })

      await store.search('dashboards')

      expect(backend.searchCalls[0].distanceMetric).toBe('COSINE')
    })

    it('rejects an unknown COUCHBASE_DISTANCE_METRIC in the constructor', () => {
      vi.stubEnv('COUCHBASE_DISTANCE_METRIC', 'manhattan')
      expect(() => new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, backend: new FakeBackend() })).toThrow(
        'distanceMetric must be one of'
      )
    })

    it('requires credentials when the store owns the connection', () => {
      vi.stubEnv('COUCHBASE_USERNAME', '')
      vi.stubEnv('COUCHBASE_PASSWORD', '')
      expect(() => new CouchbaseMemoryStore({ name: 'cb', embeddingProvider })).toThrow(
        'Couchbase credentials are required'
      )
      expect(() => new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, username: 'app' })).toThrow(
        'Couchbase credentials are required'
      )
    })

    it('reads credentials from the environment', () => {
      vi.stubEnv('COUCHBASE_USERNAME', 'app')
      vi.stubEnv('COUCHBASE_PASSWORD', 'secret')
      expect(() => new CouchbaseMemoryStore({ name: 'cb', embeddingProvider })).not.toThrow()
    })

    it('does not require credentials with a caller-provided cluster', () => {
      vi.stubEnv('COUCHBASE_USERNAME', '')
      vi.stubEnv('COUCHBASE_PASSWORD', '')
      const cluster = {
        bucket: () => ({ defaultScope: () => ({}), defaultCollection: () => ({}) }),
      } as any
      expect(() => new CouchbaseMemoryStore({ name: 'cb', embeddingProvider, cluster })).not.toThrow()
    })
  })
})
