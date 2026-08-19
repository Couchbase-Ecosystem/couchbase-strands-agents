import { describe, expect, it, vi } from 'vitest'

const fakeCollection = {
  upsert: vi.fn(async () => undefined),
}
const fakeCluster = {
  bucket: vi.fn(() => ({
    defaultScope: vi.fn(() => ({ search: vi.fn() })),
    scope: vi.fn(() => ({ collection: vi.fn(() => fakeCollection), search: vi.fn() })),
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
  SearchQuery: { match: vi.fn() },
  VectorQuery: { create: vi.fn() },
  VectorSearch: { fromVectorQuery: vi.fn() },
  SearchRequest: { create: vi.fn() },
}))

describe('CouchbaseSdkBackend connection lifecycle', () => {
  it('connects lazily with couchbase.connect before the first operation', async () => {
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

    expect(connect).toHaveBeenCalledWith('couchbase://example.com', {
      username: 'Administrator',
      password: 'password',
    })
    expect(fakeCollection.upsert).toHaveBeenCalledWith(
      'memory-1',
      expect.objectContaining({ content: 'hello', namespace: 'default' })
    )

    await backend.close()
    expect(fakeCluster.close).toHaveBeenCalled()
  })
})
