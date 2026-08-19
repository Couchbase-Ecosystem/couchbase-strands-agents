import { describe, expect, it, vi } from 'vitest'

const fakeCollection = {
  upsert: vi.fn(async () => undefined),
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
  search: vi.fn(),
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

vi.mock('couchbase', () => ({
  connect,
  Cluster: clusterConstructor,
  QueryScanConsistency: { RequestPlus: 'request_plus' },
  SearchQuery: { match: vi.fn() },
  VectorQuery: { create: vi.fn() },
  VectorSearch: { fromVectorQuery: vi.fn() },
  SearchRequest: { create: vi.fn() },
}))

describe('CouchbaseSdkBackend', () => {
  it('connects lazily and queries Hyperscale Vector Indexes through SQL++ by default', async () => {
    const { CouchbaseSdkBackend } = await import('../src/index.js')
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
})
