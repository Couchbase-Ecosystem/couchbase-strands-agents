import { beforeEach, describe, expect, it, vi } from 'vitest'

class AuthenticationFailureError extends Error {}
class IndexNotFoundError extends Error {}

const getIndex = vi.fn()
const fakeScope = { searchIndexes: vi.fn(() => ({ getIndex })) }
const fakeCollection = {}
const fakeCluster = {
  bucket: vi.fn(() => ({
    defaultScope: vi.fn(() => fakeScope),
    scope: vi.fn(() => fakeScope),
    defaultCollection: vi.fn(() => fakeCollection),
    collection: vi.fn(() => fakeCollection),
  })),
  query: vi.fn(),
  close: vi.fn(async () => undefined),
}
Object.assign(fakeScope, { collection: vi.fn(() => fakeCollection) })
const connect = vi.fn(async () => fakeCluster)

vi.mock('couchbase', () => ({ connect, AuthenticationFailureError, IndexNotFoundError }))

const hyperscale = {
  vectorBackend: 'hyperscale' as const,
  searchIndexName: 'strands-memory-search-index',
  vectorField: 'embedding',
  namespaceField: 'namespace',
  distanceMetric: 'L2_SQUARED' as const,
  dimensions: 3,
}
const search = { ...hyperscale, vectorBackend: 'search' as const }

function indexRow(options: Record<string, unknown>, indexKey = ['`embedding` VECTOR']) {
  return { name: 'hv', index_key: indexKey, index_options: options }
}

function searchIndex(namespaceField: Record<string, unknown>, dims = 3) {
  return {
    params: {
      mapping: {
        default_analyzer: 'standard',
        default_mapping: { enabled: false },
        types: {
          '_default._default': {
            enabled: true,
            properties: {
              embedding: { fields: [{ name: 'embedding', type: 'vector', dims, similarity: 'l2_norm', index: true }] },
              namespace: { fields: [{ name: 'namespace', type: 'text', index: true, ...namespaceField }] },
            },
          },
        },
      },
    },
  }
}

async function newBackend(collectionName = '_default') {
  const { CouchbaseSdkBackend } = await import('../src/memory-store.js')
  return new CouchbaseSdkBackend({
    connectionString: 'couchbase://example.com',
    username: 'app',
    password: 'secret',
    bucketName: 'strands_memory',
    scopeName: '_default',
    collectionName,
  })
}

beforeEach(() => {
  connect.mockClear()
  fakeCluster.query.mockReset()
  getIndex.mockReset()
})

describe('CouchbaseSdkBackend.initialize', () => {
  it('reports authentication failures clearly and retries on the next call', async () => {
    const backend = await newBackend()
    connect.mockRejectedValueOnce(new AuthenticationFailureError('authentication failure'))

    await expect(backend.initialize()).rejects.toThrow(
      "Authentication failed connecting to Couchbase at couchbase://example.com as 'app'"
    )
    await expect(backend.initialize()).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('reports network failures with the connection string', async () => {
    const backend = await newBackend()
    connect.mockRejectedValueOnce(new Error('unambiguous timeout'))

    await expect(backend.initialize()).rejects.toThrow('Could not connect to Couchbase at couchbase://example.com')
  })

  it('only connects when no validation is requested', async () => {
    const backend = await newBackend()
    await backend.initialize()
    expect(fakeCluster.query).not.toHaveBeenCalled()
  })

  it('throws with a setup link when no vector index exists on the field', async () => {
    const backend = await newBackend()
    fakeCluster.query.mockResolvedValue({ rows: [indexRow({}, ['`namespace`'])] })

    await expect(backend.initialize(hyperscale)).rejects.toThrow(
      /No vector index on `embedding` found for strands_memory\._default\._default.*couchbase-setup\.md.*validateOnInitialize: false/
    )
  })

  it('looks up named collections by bucket, scope and collection', async () => {
    const backend = await newBackend('memories')
    fakeCluster.query.mockResolvedValue({ rows: [indexRow({ similarity: 'l2_squared', dimension: 3 })] })

    await backend.initialize(hyperscale)

    expect(fakeCluster.query).toHaveBeenCalledWith(expect.stringContaining('system:indexes'), {
      parameters: { bucket: 'strands_memory', scope: '_default', collection: 'memories' },
    })
  })

  it('accepts an index whose similarity and dimension match, including metric aliases', async () => {
    const backend = await newBackend()
    fakeCluster.query.mockResolvedValue({ rows: [indexRow({ similarity: 'euclidean_squared', dimension: 3 })] })

    await expect(backend.initialize(hyperscale)).resolves.toBeUndefined()
  })

  it('throws when the index similarity does not match distanceMetric', async () => {
    const backend = await newBackend()
    fakeCluster.query.mockResolvedValue({ rows: [indexRow({ similarity: 'cosine', dimension: 3 })] })

    await expect(backend.initialize(hyperscale)).rejects.toThrow(
      'similarity COSINE does not match distanceMetric L2_SQUARED'
    )
  })

  it('throws when the index dimension does not match dimensions', async () => {
    const backend = await newBackend()
    fakeCluster.query.mockResolvedValue({ rows: [indexRow({ similarity: 'l2_squared', dimension: 1536 })] })

    await expect(backend.initialize(hyperscale)).rejects.toThrow('dimension 1536 does not match dimensions 3')
  })

  it('skips the dimension check when dimensions is not set', async () => {
    const backend = await newBackend()
    fakeCluster.query.mockResolvedValue({ rows: [indexRow({ similarity: 'l2_squared', dimension: 1536 })] })

    await expect(backend.initialize({ ...hyperscale, dimensions: undefined })).resolves.toBeUndefined()
  })

  it('throws when the Search index does not exist', async () => {
    const backend = await newBackend()
    getIndex.mockRejectedValue(new IndexNotFoundError('index not found'))

    await expect(backend.initialize(search)).rejects.toThrow(
      "Search index 'strands-memory-search-index' not found in strands_memory._default"
    )
  })

  it('accepts a Search index with a keyword namespace field and matching dims', async () => {
    const backend = await newBackend()
    getIndex.mockResolvedValue(searchIndex({ analyzer: 'keyword' }))

    await expect(backend.initialize(search)).resolves.toBeUndefined()
  })

  it('rejects a Search index whose namespace field is not keyword-analyzed', async () => {
    const backend = await newBackend()
    getIndex.mockResolvedValue(searchIndex({}))

    await expect(backend.initialize(search)).rejects.toThrow("must map 'namespace' as a text field with the keyword")
  })

  it('rejects a Search index whose vector dims do not match', async () => {
    const backend = await newBackend()
    getIndex.mockResolvedValue(searchIndex({ analyzer: 'keyword' }, 1536))

    await expect(backend.initialize(search)).rejects.toThrow('has dims 1536; expected 3')
  })
})
