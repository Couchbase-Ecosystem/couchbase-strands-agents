import * as couchbase from 'couchbase'
import type {
  AddMessagesContext,
  ExtractionConfig,
  JSONValue,
  MemoryEntry,
  MemoryStore,
  MemoryStoreConfig,
  MessageData,
  SearchOptions,
} from '@strands-agents/sdk'

const DEFAULT_NAME = 'couchbase'
const DEFAULT_DESCRIPTION = 'Long-term semantic memory stored in Couchbase Vector Search.'
const DEFAULT_CONNECTION_STRING = 'couchbase://localhost'
const DEFAULT_BUCKET = 'strands_memory'
const DEFAULT_SCOPE = '_default'
const DEFAULT_COLLECTION = '_default'
const DEFAULT_SEARCH_INDEX = 'strands-memory-index'
const DEFAULT_CONTENT_FIELD = 'content'
const DEFAULT_VECTOR_FIELD = 'embedding'
const DEFAULT_METADATA_FIELD = 'metadata'
const DEFAULT_NAMESPACE_FIELD = 'namespace'
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_MAX_RESULTS = 5

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]> | number[]
}

export interface MemoryDocument {
  content: string
  embedding: number[]
  metadata: Record<string, JSONValue>
  namespace: string
  created_at: string
  updated_at: string
}

export interface SearchHit {
  id: string
  score?: number | undefined
  content: string
  metadata: Record<string, JSONValue>
  namespace?: string | undefined
}

export interface CouchbaseBackend {
  upsert(key: string, document: MemoryDocument): Promise<void>
  vectorSearch(input: {
    searchIndexName: string
    vectorField: string
    queryVector: number[]
    limit: number
    numCandidates?: number | undefined
    namespace: string
    namespaceField: string
    contentField: string
    metadataField: string
  }): Promise<SearchHit[]>
  close(): Promise<void>
}

export interface CouchbaseMemoryStoreConfig extends MemoryStoreConfig {
  connectionString?: string
  username?: string
  password?: string
  bucketName?: string
  scopeName?: string
  collectionName?: string
  searchIndexName?: string
  contentField?: string
  vectorField?: string
  metadataField?: string
  namespaceField?: string
  namespace?: string
  dimensions?: number
  embeddingProvider: EmbeddingProvider | ((text: string) => Promise<number[]> | number[])
  backend?: CouchbaseBackend
  cluster?: couchbase.Cluster | undefined
  collection?: couchbase.Collection | undefined
  numCandidates?: number
}

export class CouchbaseSdkBackend implements CouchbaseBackend {
  private readonly cluster: couchbase.Cluster
  private readonly scope: couchbase.Scope
  private readonly collection: couchbase.Collection
  private readonly ownsCluster: boolean

  constructor(config: {
    connectionString: string
    username: string
    password: string
    bucketName: string
    scopeName: string
    collectionName: string
    cluster?: couchbase.Cluster | undefined
    collection?: couchbase.Collection | undefined
  }) {
    this.ownsCluster = config.cluster === undefined
    this.cluster =
      config.cluster ??
      new couchbase.Cluster(config.connectionString, {
        username: config.username,
        password: config.password,
      })
    const bucket = this.cluster.bucket(config.bucketName)
    this.scope = config.scopeName === DEFAULT_SCOPE ? bucket.defaultScope() : bucket.scope(config.scopeName)
    this.collection =
      config.collection ??
      (config.collectionName === DEFAULT_COLLECTION
        ? bucket.defaultCollection()
        : this.scope.collection(config.collectionName))
  }

  async upsert(key: string, document: MemoryDocument): Promise<void> {
    await this.collection.upsert(key, document)
  }

  async vectorSearch(input: {
    searchIndexName: string
    vectorField: string
    queryVector: number[]
    limit: number
    numCandidates?: number | undefined
    namespace: string
    namespaceField: string
    contentField: string
    metadataField: string
  }): Promise<SearchHit[]> {
    const prefilter = couchbase.SearchQuery.match(input.namespace).field(input.namespaceField)
    const vectorQuery = couchbase.VectorQuery.create(input.vectorField, input.queryVector)
      .numCandidates(input.numCandidates ?? Math.max(input.limit * 3, input.limit))
      .prefilter(prefilter)
    const request = couchbase.SearchRequest.create(couchbase.VectorSearch.fromVectorQuery(vectorQuery))
    const result = await this.scope.search(input.searchIndexName, request, {
      limit: input.limit,
      fields: [input.contentField, input.metadataField, input.namespaceField],
    })
    return result.rows.map((row: any) => {
      const fields = (row.fields ?? {}) as Record<string, JSONValue>
      const rawMetadata = fields[input.metadataField]
      const metadata = isRecord(rawMetadata) ? rawMetadata : rawMetadata === undefined ? {} : { value: rawMetadata }
      const namespace = fields[input.namespaceField]
      return {
        id: String(row.id ?? ''),
        score: typeof row.score === 'number' ? row.score : undefined,
        content: String(fields[input.contentField] ?? ''),
        metadata,
        namespace: typeof namespace === 'string' ? namespace : undefined,
      }
    })
  }

  async close(): Promise<void> {
    if (this.ownsCluster) {
      await this.cluster.close()
    }
  }
}

export class CouchbaseMemoryStore implements MemoryStore {
  readonly name: string
  readonly description?: string
  readonly maxSearchResults: number
  readonly writable: boolean
  readonly extraction?: boolean | ExtractionConfig

  private readonly searchIndexName: string
  private readonly contentField: string
  private readonly vectorField: string
  private readonly metadataField: string
  private readonly namespaceField: string
  private readonly namespace: string
  private readonly dimensions: number | undefined
  private readonly embeddingProvider: EmbeddingProvider | ((text: string) => Promise<number[]> | number[])
  private readonly backend: CouchbaseBackend
  private readonly numCandidates: number | undefined

  constructor(config: CouchbaseMemoryStoreConfig) {
    this.name = config.name ?? DEFAULT_NAME
    this.description = config.description ?? DEFAULT_DESCRIPTION
    this.maxSearchResults = config.maxSearchResults ?? DEFAULT_MAX_RESULTS
    this.writable = config.writable ?? true
    if (config.extraction !== undefined) this.extraction = config.extraction
    this.searchIndexName = config.searchIndexName ?? process.env.COUCHBASE_SEARCH_INDEX ?? DEFAULT_SEARCH_INDEX
    this.contentField = config.contentField ?? DEFAULT_CONTENT_FIELD
    this.vectorField = config.vectorField ?? DEFAULT_VECTOR_FIELD
    this.metadataField = config.metadataField ?? DEFAULT_METADATA_FIELD
    this.namespaceField = config.namespaceField ?? DEFAULT_NAMESPACE_FIELD
    this.namespace = config.namespace ?? process.env.COUCHBASE_NAMESPACE ?? DEFAULT_NAMESPACE
    this.dimensions = config.dimensions
    this.embeddingProvider = config.embeddingProvider
    this.numCandidates = config.numCandidates
    this.backend =
      config.backend ??
      new CouchbaseSdkBackend({
        connectionString:
          config.connectionString ?? process.env.COUCHBASE_CONNECTION_STRING ?? DEFAULT_CONNECTION_STRING,
        username: config.username ?? process.env.COUCHBASE_USERNAME ?? '',
        password: config.password ?? process.env.COUCHBASE_PASSWORD ?? '',
        bucketName: config.bucketName ?? process.env.COUCHBASE_BUCKET ?? DEFAULT_BUCKET,
        scopeName: config.scopeName ?? process.env.COUCHBASE_SCOPE ?? DEFAULT_SCOPE,
        collectionName: config.collectionName ?? process.env.COUCHBASE_COLLECTION ?? DEFAULT_COLLECTION,
        cluster: config.cluster,
        collection: config.collection,
      })
  }

  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    if (query.trim().length === 0) return []
    const limit = options?.maxSearchResults ?? this.maxSearchResults ?? DEFAULT_MAX_RESULTS
    const queryVector = await this.embed(query)
    const hits = await this.backend.vectorSearch({
      searchIndexName: this.searchIndexName,
      vectorField: this.vectorField,
      queryVector,
      limit,
      numCandidates: this.numCandidates,
      namespace: this.namespace,
      namespaceField: this.namespaceField,
      contentField: this.contentField,
      metadataField: this.metadataField,
    })
    return hits.map((hit) => ({
      content: hit.content,
      metadata: {
        ...hit.metadata,
        id: hit.metadata.id ?? hit.id,
        score: hit.metadata.score ?? hit.score ?? null,
        namespace: hit.metadata.namespace ?? hit.namespace ?? this.namespace,
      },
    }))
  }

  async add(content: string, metadata?: Record<string, JSONValue>): Promise<string> {
    if (!this.writable) throw new Error(`Memory store ${this.name} is not writable`)
    if (content.trim().length === 0) throw new Error('content must not be empty')
    const cleanMetadata: Record<string, JSONValue> = { ...(metadata ?? {}) }
    const metadataId = cleanMetadata.id ?? cleanMetadata.memory_id
    delete cleanMetadata.id
    delete cleanMetadata.memory_id
    const key = typeof metadataId === 'string' ? metadataId : `memory::${this.namespace}::${crypto.randomUUID()}`
    const embedding = await this.embed(content)
    const now = new Date().toISOString()
    await this.backend.upsert(key, {
      content,
      embedding,
      metadata: cleanMetadata,
      namespace: this.namespace,
      created_at: now,
      updated_at: now,
    })
    return key
  }

  async addMessages(messages: MessageData[], context?: AddMessagesContext): Promise<string[]> {
    const keys: string[] = []
    for (const [index, message] of messages.entries()) {
      const content = messageToText(message)
      if (!content) continue
      const metadata: Record<string, JSONValue> = {
        role: message.role ?? 'unknown',
        source: 'strands.addMessages',
      }
      const sequenceNumber = context?.sequenceNumbers?.[index]
      if (sequenceNumber !== undefined) metadata.sequence_number = sequenceNumber
      keys.push(await this.add(content, metadata))
    }
    return keys
  }

  async close(): Promise<void> {
    await this.backend.close()
  }

  private async embed(text: string): Promise<number[]> {
    const result =
      typeof this.embeddingProvider === 'function' ? this.embeddingProvider(text) : this.embeddingProvider.embed(text)
    const vector = (await result).map((value) => Number(value))
    if (vector.length === 0) throw new Error('embedding provider returned an empty vector')
    if (this.dimensions !== undefined && vector.length !== this.dimensions) {
      throw new Error(`embedding provider returned ${vector.length} dimensions; expected ${this.dimensions}`)
    }
    return vector
  }
}

function messageToText(message: MessageData): string {
  return (message.content ?? [])
    .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function isRecord(value: unknown): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
