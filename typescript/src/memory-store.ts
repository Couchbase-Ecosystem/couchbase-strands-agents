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
const DEFAULT_DESCRIPTION = 'Long-term semantic memory stored in Couchbase Hyperscale Vector Search.'
const DEFAULT_CONNECTION_STRING = 'couchbase://localhost'
const DEFAULT_BUCKET = 'strands_memory'
const DEFAULT_SCOPE = '_default'
const DEFAULT_COLLECTION = '_default'
const DEFAULT_SEARCH_INDEX = 'strands-memory-search-index'
const DEFAULT_VECTOR_BACKEND = 'hyperscale'
const DEFAULT_DISTANCE_METRIC = 'L2_SQUARED'
const DEFAULT_CONTENT_FIELD = 'content'
const DEFAULT_VECTOR_FIELD = 'embedding'
const DEFAULT_METADATA_FIELD = 'metadata'
const DEFAULT_NAMESPACE_FIELD = 'namespace'
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_MAX_RESULTS = 5

export type CouchbaseVectorBackend = 'hyperscale' | 'search'

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
    vectorBackend: CouchbaseVectorBackend
    distanceMetric: string
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
  vectorBackend?: CouchbaseVectorBackend
  distanceMetric?: string
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
  private readonly config: {
    connectionString: string
    username: string
    password: string
    bucketName: string
    scopeName: string
    collectionName: string
    cluster?: couchbase.Cluster | undefined
    collection?: couchbase.Collection | undefined
  }
  private cluster: couchbase.Cluster | undefined
  private scope: couchbase.Scope | undefined
  private collection: couchbase.Collection | undefined
  private connectPromise: Promise<couchbase.Cluster> | undefined
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
    this.config = config
    this.ownsCluster = config.cluster === undefined
    if (config.cluster !== undefined) {
      this.cluster = config.cluster
      this.resolveBucketHandles(config.cluster)
    }
    if (config.collection !== undefined) {
      this.collection = config.collection
    }
  }

  async upsert(key: string, document: MemoryDocument): Promise<void> {
    const collection = await this.getCollection()
    await collection.upsert(key, document)
  }

  async vectorSearch(input: {
    searchIndexName: string
    vectorBackend: CouchbaseVectorBackend
    distanceMetric: string
    vectorField: string
    queryVector: number[]
    limit: number
    numCandidates?: number | undefined
    namespace: string
    namespaceField: string
    contentField: string
    metadataField: string
  }): Promise<SearchHit[]> {
    if (input.vectorBackend === 'search') return this.searchServiceVectorSearch(input)
    return this.hyperscaleVectorSearch(input)
  }

  async close(): Promise<void> {
    const cluster = this.cluster ?? (this.connectPromise ? await this.connectPromise : undefined)
    if (this.ownsCluster && cluster !== undefined) {
      await cluster.close()
    }
  }

  private async hyperscaleVectorSearch(input: {
    vectorField: string
    queryVector: number[]
    limit: number
    namespace: string
    namespaceField: string
    contentField: string
    metadataField: string
    distanceMetric: string
    numCandidates?: number | undefined
  }): Promise<SearchHit[]> {
    const scope = await this.getScope()
    const collection = quoteIdentifier(this.config.collectionName)
    const contentExpr = quotePath(input.contentField)
    const metadataExpr = quotePath(input.metadataField)
    const namespaceExpr = quotePath(input.namespaceField)
    const vectorExpr = quotePath(input.vectorField)
    const distanceMetricLiteral = quoteStringLiteral(validateDistanceMetric(input.distanceMetric))
    const centroidsToProbe = Math.trunc(input.numCandidates ?? 8)
    const statement = `
      SELECT META().id AS id,
             ${contentExpr} AS content,
             ${metadataExpr} AS metadata,
             ${namespaceExpr} AS namespace_value,
             APPROX_VECTOR_DISTANCE(
               ${vectorExpr},
               $query_vector,
               ${distanceMetricLiteral},
               ${centroidsToProbe}
             ) AS distance
      FROM ${collection}
      WHERE ${namespaceExpr} = $namespace
      ORDER BY distance
      LIMIT ${Math.trunc(input.limit)}
    `
    const result = await scope.query(statement, {
      parameters: {
        query_vector: input.queryVector,
        namespace: input.namespace,
      },
      scanConsistency: couchbase.QueryScanConsistency.RequestPlus,
    })
    return result.rows.map((row: any) => {
      const rawMetadata = row.metadata as JSONValue | undefined
      const metadata = isRecord(rawMetadata) ? rawMetadata : rawMetadata === undefined ? {} : { value: rawMetadata }
      return {
        id: String(row.id ?? ''),
        score: typeof row.distance === 'number' ? row.distance : undefined,
        content: String(row.content ?? ''),
        metadata,
        namespace: typeof row.namespace_value === 'string' ? row.namespace_value : undefined,
      }
    })
  }

  private async searchServiceVectorSearch(input: {
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
    const scope = await this.getScope()
    const prefilter = couchbase.SearchQuery.match(input.namespace).field(input.namespaceField)
    const vectorQuery = couchbase.VectorQuery.create(input.vectorField, input.queryVector)
      .numCandidates(input.numCandidates ?? Math.max(input.limit * 3, input.limit))
      .prefilter(prefilter)
    const request = couchbase.SearchRequest.create(couchbase.VectorSearch.fromVectorQuery(vectorQuery))
    const result = await scope.search(input.searchIndexName, request, {
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

  private async getScope(): Promise<couchbase.Scope> {
    if (this.scope !== undefined) return this.scope
    const cluster = await this.getCluster()
    this.resolveBucketHandles(cluster)
    if (this.scope === undefined) throw new Error('Failed to resolve Couchbase scope')
    return this.scope
  }

  private async getCollection(): Promise<couchbase.Collection> {
    if (this.collection !== undefined) return this.collection
    await this.getScope()
    if (this.collection === undefined) throw new Error('Failed to resolve Couchbase collection')
    return this.collection
  }

  private async getCluster(): Promise<couchbase.Cluster> {
    if (this.cluster !== undefined) return this.cluster
    this.connectPromise ??= couchbase.connect(this.config.connectionString, {
      username: this.config.username,
      password: this.config.password,
    })
    this.cluster = await this.connectPromise
    return this.cluster
  }

  private resolveBucketHandles(cluster: couchbase.Cluster): void {
    const bucket = cluster.bucket(this.config.bucketName)
    this.scope = this.config.scopeName === DEFAULT_SCOPE ? bucket.defaultScope() : bucket.scope(this.config.scopeName)
    this.collection =
      this.config.collection ??
      (this.config.collectionName === DEFAULT_COLLECTION
        ? bucket.defaultCollection()
        : this.scope.collection(this.config.collectionName))
  }
}

export class CouchbaseMemoryStore implements MemoryStore {
  readonly name: string
  readonly description?: string
  readonly maxSearchResults: number
  readonly writable: boolean
  readonly extraction?: boolean | ExtractionConfig

  private readonly searchIndexName: string
  private readonly vectorBackend: CouchbaseVectorBackend
  private readonly distanceMetric: string
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
    this.vectorBackend =
      config.vectorBackend ??
      (process.env.COUCHBASE_VECTOR_BACKEND as CouchbaseVectorBackend | undefined) ??
      DEFAULT_VECTOR_BACKEND
    if (this.vectorBackend !== 'hyperscale' && this.vectorBackend !== 'search') {
      throw new Error("vectorBackend must be 'hyperscale' or 'search'")
    }
    this.distanceMetric = (
      config.distanceMetric ??
      process.env.COUCHBASE_DISTANCE_METRIC ??
      DEFAULT_DISTANCE_METRIC
    ).toUpperCase()
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
      vectorBackend: this.vectorBackend,
      distanceMetric: this.distanceMetric,
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

function validateDistanceMetric(distanceMetric: string): string {
  const metric = distanceMetric.toUpperCase()
  const allowed = new Set(['COSINE', 'DOT', 'L2', 'EUCLIDEAN', 'L2_SQUARED', 'EUCLIDEAN_SQUARED'])
  if (!allowed.has(metric)) throw new Error(`distanceMetric must be one of ${[...allowed].join(', ')}`)
  return metric
}

function quoteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function quoteIdentifier(identifier: string): string {
  if (!identifier || identifier.includes('\0')) throw new Error('SQL++ identifiers must be non-empty strings')
  return `\`${identifier.replaceAll('`', '``')}\``
}

function quotePath(path: string): string {
  return path.split('.').map(quoteIdentifier).join('.')
}

function isRecord(value: unknown): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
