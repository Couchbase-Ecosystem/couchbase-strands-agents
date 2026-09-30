import { describe, expect, it, vi } from 'vitest'

class DocumentExistsError extends Error {}
const insertedKeys = new Set<string>()
const fakeCollection = {
  upsert: vi.fn(async () => undefined),
  insert: vi.fn(async (key: string) => {
    if (insertedKeys.has(key)) throw new DocumentExistsError('document exists')
    insertedKeys.add(key)
  }),
  exists: vi.fn(async (key: string) => ({ exists: insertedKeys.has(key) })),
}
const fakeScope = {
  query: vi.fn(async () => ({
    rows: [
      {
        id: 'memory-1',
        content: 'User prefers dark-mode dashboards.',
        metadata: { category: 'preference' },
        namespace_value: 'default',
        distance: 0.12,
      },
    ],
  })),
  search: vi.fn(async () => ({
    rows: [{ id: 'memory-2', score: 0.8, fields: { content: 'hi', metadata: {}, namespace: 'tenant-a' } }],
  })),
}
const fakeCluster = {
  bucket: vi.fn(() => ({
    defaultScope: vi.fn(() => fakeScope),
    scope: vi.fn(() => fakeScope),
    defaultCollection: vi.fn(() => fakeCollection),
  })),
  close: vi.fn(async () => undefined),
}
const connect = vi.fn(async () => fakeCluster)
const clusterConstructor = vi.fn(() => {
  throw new Error('CouchbaseSdkBackend should use couchbase.connect(), not new Cluster()')
})

const vectorQuery = {
  numCandidates: vi.fn(() => vectorQuery),
  prefilter: vi.fn(() => vectorQuery),
}

vi.mock('couchbase', () => ({
  connect,
  DocumentExistsError,
  Cluster: clusterConstructor,
  QueryScanConsistency: { RequestPlus: 'request_plus' },
  SearchQuery: { match: vi.fn(() => ({ field: vi.fn() })), term: vi.fn(() => ({ field: vi.fn() })) },
  VectorQuery: { create: vi.fn(() => vectorQuery) },
  VectorSearch: { fromVectorQuery: vi.fn() },
  SearchRequest: { create: vi.fn() },
}))

describe('CouchbaseSdkBackend', () => {
  it('connects lazily and queries Hyperscale Vector Indexes through SQL++ by default', async () => {
    const { CouchbaseSdkBackend } = await import('../src/memory-store.js')
    const backend = new CouchbaseSdkBackend({
      connectionString: 'couchbase://example.com',
      username: 'Administrator',
      password: 'password',
      bucketName: 'strands_memory',
      scopeName: '_default',
      collectionName: '_default',
    })

    expect(connect).not.toHaveBeenCalled()
    expect(clusterConstructor).not.toHaveBeenCalled()

    await backend.upsert('memory-1', {
      content: 'hello',
      embedding: [1, 0, 0],
      metadata: {},
      namespace: 'default',
      created_at: '2026-08-19T00:00:00Z',
      updated_at: '2026-08-19T00:00:00Z',
    })

    const hits = await backend.vectorSearch({
      searchIndexName: 'search-index',
      vectorBackend: 'hyperscale',
      distanceMetric: 'EUCLIDEAN',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 3,
      namespace: 'default',
      namespaceField: 'namespace',
      contentField: 'content',
      metadataField: 'metadata',
    })

    expect(connect).toHaveBeenCalledWith('couchbase://example.com', {
      username: 'Administrator',
      password: 'password',
    })
    expect(fakeCollection.upsert).toHaveBeenCalledWith('memory-1', expect.objectContaining({ content: 'hello' }))
    expect(fakeScope.query).toHaveBeenCalledWith(
      expect.stringContaining('APPROX_VECTOR_DISTANCE'),
      expect.objectContaining({
        parameters: { query_vector: [1, 0, 0], namespace: 'default' },
        scanConsistency: 'request_plus',
      })
    )
    const queryCalls = fakeScope.query.mock.calls as unknown as [string, unknown][]
    const queryStatement = queryCalls[0]?.[0] ?? ''
    expect(queryStatement).toContain("'EUCLIDEAN'")
    expect(queryStatement).toContain('LIMIT 3')
    expect(hits[0]).toMatchObject({ id: 'memory-1', score: 0.12, content: 'User prefers dark-mode dashboards.' })

    await backend.close()
    expect(fakeCluster.close).toHaveBeenCalled()
  })

  it('passes centroidsToProbe, not numCandidates, to APPROX_VECTOR_DISTANCE', async () => {
    const backend = await newBackend()
    fakeScope.query.mockClear()

    await backend.vectorSearch({ ...searchInput, vectorBackend: 'hyperscale', centroidsToProbe: 16, numCandidates: 99 })

    const [statement] = (fakeScope.query.mock.calls as unknown as [string][])[0] ?? ['']
    expect(statement).toMatch(/'L2_SQUARED',\s+16\s+\)/)
    expect(statement).not.toContain('99')
  })

  it('prefilters Search queries with an exact term query on hyphenated namespaces', async () => {
    const couchbase = await import('couchbase')
    const backend = await newBackend()

    const hits = await backend.vectorSearch({ ...searchInput, vectorBackend: 'search', numCandidates: 12 })

    // A match query would analyze `tenant-a` into `tenant` + `a` and also match `tenant-b`.
    expect(couchbase.SearchQuery.term).toHaveBeenCalledWith('tenant-a')
    expect(couchbase.SearchQuery.match).not.toHaveBeenCalled()
    const prefilter = (couchbase.SearchQuery.term as any).mock.results[0].value
    expect(prefilter.field).toHaveBeenCalledWith('namespace')
    expect(vectorQuery.numCandidates).toHaveBeenCalledWith(12)
    expect(hits[0]).toMatchObject({ id: 'memory-2', namespace: 'tenant-a' })
  })

  it('inserts only when the key is absent', async () => {
    const backend = await newBackend()

    await expect(backend.insertIfAbsent('memory::default::abc', document)).resolves.toBe(true)
    await expect(backend.insertIfAbsent('memory::default::abc', document)).resolves.toBe(false)
    expect(fakeCollection.insert).toHaveBeenCalledTimes(2)
    expect(fakeCollection.upsert).not.toHaveBeenCalledWith('memory::default::abc', expect.anything())
  })

  it('re-throws insert errors other than DocumentExistsError', async () => {
    const backend = await newBackend()
    fakeCollection.insert.mockRejectedValueOnce(new Error('write timed out'))

    await expect(backend.insertIfAbsent('memory::default::other', document)).rejects.toThrow('write timed out')
  })

  it('reports whether a key exists', async () => {
    const backend = await newBackend()

    await expect(backend.exists('memory::default::missing')).resolves.toBe(false)
    await backend.insertIfAbsent('memory::default::present', document)
    await expect(backend.exists('memory::default::present')).resolves.toBe(true)
  })
})

const searchInput = {
  searchIndexName: 'search-index',
  distanceMetric: 'L2_SQUARED' as const,
  vectorField: 'embedding',
  queryVector: [1, 0, 0],
  limit: 3,
  namespace: 'tenant-a',
  namespaceField: 'namespace',
  contentField: 'content',
  metadataField: 'metadata',
}

const document = {
  content: 'hello',
  embedding: [1, 0, 0],
  metadata: {},
  namespace: 'default',
  created_at: '2026-08-19T00:00:00Z',
  updated_at: '2026-08-19T00:00:00Z',
}

async function newBackend() {
  const { CouchbaseSdkBackend } = await import('../src/memory-store.js')
  return new CouchbaseSdkBackend({
    connectionString: 'couchbase://example.com',
    username: 'Administrator',
    password: 'password',
    bucketName: 'strands_memory',
    scopeName: '_default',
    collectionName: '_default',
  })
}
