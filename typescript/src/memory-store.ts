import { createHash } from 'node:crypto'
import * as couchbase from 'couchbase'
import type {
  ExtractionConfig,
  JSONValue,
  MemoryEntry,
  MemoryStore,
  MemoryStoreConfig,
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
const DEFAULT_CENTROIDS_TO_PROBE = 8
const SETUP_DOCS_URL =
  'https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/blob/main/docs/couchbase-setup.md'

export type CouchbaseVectorBackend = 'hyperscale' | 'search'

/** Distance metrics accepted by SQL++ `APPROX_VECTOR_DISTANCE`. Must match the vector index `similarity`. */
export type DistanceMetric = 'COSINE' | 'DOT' | 'L2' | 'EUCLIDEAN' | 'L2_SQUARED' | 'EUCLIDEAN_SQUARED'

const DISTANCE_METRICS: readonly DistanceMetric[] = [
  'COSINE',
  'DOT',
  'L2',
  'EUCLIDEAN',
  'L2_SQUARED',
  'EUCLIDEAN_SQUARED',
]

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

/** @internal */
export interface SearchHit {
  id: string
  score?: number | undefined
  content: string
  metadata: Record<string, JSONValue>
  namespace?: string | undefined
}

/** @internal What `initialize()` checks against the vector index. */
export interface IndexValidation {
  vectorBackend: CouchbaseVectorBackend
  searchIndexName: string
  vectorField: string
  namespaceField: string
  distanceMetric: DistanceMetric
  dimensions?: number | undefined
}

/**
 * @internal Storage seam used by `CouchbaseMemoryStore` and swapped for fakes in tests. Not part of the
 * public API: it may change in any release.
 */
export interface CouchbaseBackend {
  /** Connects and, when `validation` is given, checks that a matching vector index exists. */
  initialize(validation?: IndexValidation): Promise<void>
  upsert(key: string, document: MemoryDocument): Promise<void>
  exists(key: string): Promise<boolean>
  /** Stores the document unless the key exists. Resolves to false if it already existed. */
  insertIfAbsent(key: string, document: MemoryDocument): Promise<boolean>
  vectorSearch(input: {
    searchIndexName: string
    vectorBackend: CouchbaseVectorBackend
    distanceMetric: DistanceMetric
    vectorField: string
    queryVector: number[]
    limit: number
    centroidsToProbe?: number | undefined
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
  /** Must match the Hyperscale index `similarity`. Only used by the `hyperscale` backend. */
  distanceMetric?: DistanceMetric
  contentField?: string
  vectorField?: string
  metadataField?: string
  namespaceField?: string
  namespace?: string
  dimensions?: number
  embeddingProvider: EmbeddingProvider | ((text: string) => Promise<number[]> | number[])
  /** @internal Test seam; not part of the public API. */
  backend?: CouchbaseBackend
  cluster?: couchbase.Cluster | undefined
  collection?: couchbase.Collection | undefined
  /** Hyperscale only: centroids to probe (`nprobes` in `APPROX_VECTOR_DISTANCE`). Default 8. */
  centroidsToProbe?: number
  /** Search only: nearest-neighbour candidates for `VectorQuery`. Default `3 * limit`. */
  numCandidates?: number
  /**
   * Check the vector index in `initialize()`. Default true. Set to false when the credentials can't read
   * `system:indexes` (Hyperscale) or the Search index definition; `initialize()` still connects.
   */
  validateOnInitialize?: boolean
}

/** @internal Default `CouchbaseBackend` over the Couchbase Node.js SDK. Not part of the public API. */
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

  async initialize(validation?: IndexValidation): Promise<void> {
    await this.getCollection()
    if (validation === undefined) return
    if (validation.vectorBackend === 'search') await this.validateSearchIndex(validation)
    else await this.validateHyperscaleIndex(validation)
  }

  async upsert(key: string, document: MemoryDocument): Promise<void> {
    const collection = await this.getCollection()
    await collection.upsert(key, document)
  }

  async exists(key: string): Promise<boolean> {
    const collection = await this.getCollection()
    const result = await collection.exists(key)
    return result.exists
  }

  async insertIfAbsent(key: string, document: MemoryDocument): Promise<boolean> {
    const collection = await this.getCollection()
    try {
      await collection.insert(key, document)
    } catch (error) {
      if (error instanceof couchbase.DocumentExistsError) return false
      throw error
    }
    return true
  }

  async vectorSearch(input: {
    searchIndexName: string
    vectorBackend: CouchbaseVectorBackend
    distanceMetric: DistanceMetric
    vectorField: string
    queryVector: number[]
    limit: number
    centroidsToProbe?: number | undefined
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
    distanceMetric: DistanceMetric
    centroidsToProbe?: number | undefined
  }): Promise<SearchHit[]> {
    const scope = await this.getScope()
    const collection = quoteIdentifier(this.config.collectionName)
    const contentExpr = quotePath(input.contentField)
    const metadataExpr = quotePath(input.metadataField)
    const namespaceExpr = quotePath(input.namespaceField)
    const vectorExpr = quotePath(input.vectorField)
    const distanceMetricLiteral = quoteStringLiteral(validateDistanceMetric(input.distanceMetric))
    const centroidsToProbe = Math.trunc(input.centroidsToProbe ?? DEFAULT_CENTROIDS_TO_PROBE)
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
    // A term query matches the namespace exactly. A match query would analyze it, so with the standard
    // analyzer `tenant-a` would also match `tenant-b`. The namespace field must use the keyword analyzer.
    const prefilter = couchbase.SearchQuery.term(input.namespace).field(input.namespaceField)
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

  private async validateHyperscaleIndex(validation: IndexValidation): Promise<void> {
    const cluster = await this.getCluster()
    const { bucketName, scopeName, collectionName } = this.config
    const keyspace = `${bucketName}.${scopeName}.${collectionName}`
    // Indexes on _default._default are listed with keyspace_id = bucket and no bucket_id.
    const result = await cluster.query(
      `SELECT i.name, i.index_key, i.\`with\` AS index_options
       FROM system:indexes AS i
       WHERE i.\`using\` = 'gsi'
         AND ((i.bucket_id = $bucket AND i.scope_id = $scope AND i.keyspace_id = $collection)
           OR (i.bucket_id IS MISSING AND i.keyspace_id = $bucket
               AND $scope = '_default' AND $collection = '_default'))`,
      { parameters: { bucket: bucketName, scope: scopeName, collection: collectionName } }
    )
    const vectorKey = `${quotePath(validation.vectorField)} VECTOR`
    const candidates = result.rows.filter(
      (row: any) =>
        Array.isArray(row.index_key) &&
        row.index_key.some((key: unknown) => typeof key === 'string' && key.toUpperCase() === vectorKey.toUpperCase())
    )
    if (candidates.length === 0) {
      throw new Error(
        `No vector index on \`${validation.vectorField}\` found for ${keyspace} in system:indexes. ` +
          `Create a Hyperscale Vector Index (${SETUP_DOCS_URL}), or set validateOnInitialize: false ` +
          'if these credentials cannot read system:indexes.'
      )
    }
    const metric = canonicalMetric(validation.distanceMetric)
    const problems: string[] = []
    for (const row of candidates as any[]) {
      const options = isRecord(row.index_options) ? row.index_options : {}
      const similarity = typeof options.similarity === 'string' ? options.similarity.toUpperCase() : undefined
      const dimension = typeof options.dimension === 'number' ? options.dimension : undefined
      const rowProblems: string[] = []
      if (similarity !== undefined && canonicalMetric(similarity) !== metric) {
        rowProblems.push(`similarity ${similarity} does not match distanceMetric ${validation.distanceMetric}`)
      }
      if (validation.dimensions !== undefined && dimension !== undefined && dimension !== validation.dimensions) {
        rowProblems.push(`dimension ${dimension} does not match dimensions ${validation.dimensions}`)
      }
      if (rowProblems.length === 0) return
      problems.push(`${String(row.name)}: ${rowProblems.join('; ')}`)
    }
    throw new Error(
      `No vector index on \`${validation.vectorField}\` for ${keyspace} matches the store config ` +
        `(${problems.join(' | ')}). See ${SETUP_DOCS_URL}.`
    )
  }

  private async validateSearchIndex(validation: IndexValidation): Promise<void> {
    const scope = await this.getScope()
    let index: couchbase.SearchIndex
    try {
      index = await scope.searchIndexes().getIndex(validation.searchIndexName)
    } catch (error) {
      if (error instanceof couchbase.IndexNotFoundError) {
        throw new Error(
          `Search index '${validation.searchIndexName}' not found in ` +
            `${this.config.bucketName}.${this.config.scopeName}. Create it (${SETUP_DOCS_URL}), or set ` +
            'validateOnInitialize: false if these credentials cannot read Search index definitions.',
          { cause: error }
        )
      }
      throw error
    }
    const mapping = isRecord(index.params?.mapping) ? index.params.mapping : {}
    const typeMappings = searchTypeMappings(mapping, `${this.config.scopeName}.${this.config.collectionName}`)
    const name = validation.searchIndexName

    const vectorFields = typeMappings.flatMap(({ typeMapping }) =>
      findSearchFields(typeMapping, validation.vectorField).filter(
        (field) => field.type === 'vector' || field.type === 'vector_base64'
      )
    )
    if (vectorFields.length === 0) {
      throw new Error(
        `Search index '${name}' has no vector field mapped at '${validation.vectorField}' for ` +
          `${this.config.scopeName}.${this.config.collectionName}. See ${SETUP_DOCS_URL}.`
      )
    }
    if (validation.dimensions !== undefined && !vectorFields.some((field) => field.dims === validation.dimensions)) {
      const dims = vectorFields.map((field) => String(field.dims)).join(', ')
      throw new Error(
        `Search index '${name}' vector field '${validation.vectorField}' has dims ${dims}; ` +
          `expected ${validation.dimensions}. See ${SETUP_DOCS_URL}.`
      )
    }

    // The namespace prefilter is an exact term query, so the field must not be split into words.
    const keywordMapped = typeMappings.some(({ typeMapping }) =>
      findSearchFields(typeMapping, validation.namespaceField)
        .filter((field) => field.type === undefined || field.type === 'text')
        .some((field) => (field.analyzer ?? typeMapping.default_analyzer ?? mapping.default_analyzer) === 'keyword')
    )
    if (!keywordMapped) {
      throw new Error(
        `Search index '${name}' must map '${validation.namespaceField}' as a text field with the keyword ` +
          `analyzer so namespaces match exactly. See ${SETUP_DOCS_URL}.`
      )
    }
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
    this.connectPromise ??= couchbase
      .connect(this.config.connectionString, {
        username: this.config.username,
        password: this.config.password,
      })
      .catch((error: unknown) => {
        this.connectPromise = undefined
        throw connectionError(this.config.connectionString, this.config.username, error)
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

/**
 * Couchbase Hyperscale Vector Search implementation of the Strands MemoryStore interface.
 *
 * The store deliberately does not implement `addMessages`. Strands treats any store with `addMessages` as
 * doing server-side extraction and skips its `ModelExtractor`, which would save every raw turn. Leaving it
 * out makes `extraction: true` distill facts with the agent's model and store them via `add`.
 */
export class CouchbaseMemoryStore implements MemoryStore {
  readonly name: string
  readonly description?: string
  readonly maxSearchResults: number
  readonly writable: boolean
  readonly extraction?: boolean | ExtractionConfig

  private readonly searchIndexName: string
  private readonly vectorBackend: CouchbaseVectorBackend
  private readonly distanceMetric: DistanceMetric
  private readonly contentField: string
  private readonly vectorField: string
  private readonly metadataField: string
  private readonly namespaceField: string
  private readonly namespace: string
  private readonly dimensions: number | undefined
  private readonly embeddingProvider: EmbeddingProvider | ((text: string) => Promise<number[]> | number[])
  private readonly backend: CouchbaseBackend
  private readonly centroidsToProbe: number | undefined
  private readonly numCandidates: number | undefined
  private readonly validateOnInitialize: boolean

  constructor(config: CouchbaseMemoryStoreConfig) {
    this.name = config.name ?? DEFAULT_NAME
    this.description = config.description ?? DEFAULT_DESCRIPTION
    this.maxSearchResults = config.maxSearchResults ?? DEFAULT_MAX_RESULTS
    this.writable = config.writable ?? true
    if (config.extraction !== undefined) this.extraction = config.extraction
    const vectorBackend = (config.vectorBackend || process.env.COUCHBASE_VECTOR_BACKEND || DEFAULT_VECTOR_BACKEND)
      .trim()
      .toLowerCase()
    if (vectorBackend !== 'hyperscale' && vectorBackend !== 'search') {
      throw new Error(`vectorBackend must be 'hyperscale' or 'search'; got '${vectorBackend}'`)
    }
    this.vectorBackend = vectorBackend
    this.distanceMetric = validateDistanceMetric(
      config.distanceMetric || process.env.COUCHBASE_DISTANCE_METRIC || DEFAULT_DISTANCE_METRIC
    )
    this.searchIndexName = config.searchIndexName ?? process.env.COUCHBASE_SEARCH_INDEX ?? DEFAULT_SEARCH_INDEX
    this.contentField = config.contentField ?? DEFAULT_CONTENT_FIELD
    this.vectorField = config.vectorField ?? DEFAULT_VECTOR_FIELD
    this.metadataField = config.metadataField ?? DEFAULT_METADATA_FIELD
    this.namespaceField = config.namespaceField ?? DEFAULT_NAMESPACE_FIELD
    this.namespace = config.namespace ?? process.env.COUCHBASE_NAMESPACE ?? DEFAULT_NAMESPACE
    this.dimensions = config.dimensions
    this.embeddingProvider = config.embeddingProvider
    this.centroidsToProbe = validatePositiveInteger('centroidsToProbe', config.centroidsToProbe)
    this.numCandidates = validatePositiveInteger('numCandidates', config.numCandidates)
    this.validateOnInitialize = config.validateOnInitialize ?? true
    this.backend = config.backend ?? this.createSdkBackend(config)
  }

  /**
   * Connects to Couchbase and checks the vector index. Strands `MemoryManager` awaits this during agent
   * setup, so a missing index, a config mismatch or bad credentials fail there instead of every search
   * failing later and being swallowed. Call it yourself when using the store without `MemoryManager`.
   */
  async initialize(): Promise<void> {
    if (!this.validateOnInitialize) return this.backend.initialize()
    await this.backend.initialize({
      vectorBackend: this.vectorBackend,
      searchIndexName: this.searchIndexName,
      vectorField: this.vectorField,
      namespaceField: this.namespaceField,
      distanceMetric: this.distanceMetric,
      dimensions: this.dimensions,
    })
  }

  private createSdkBackend(config: CouchbaseMemoryStoreConfig): CouchbaseSdkBackend {
    const username = config.username ?? process.env.COUCHBASE_USERNAME
    const password = config.password ?? process.env.COUCHBASE_PASSWORD
    // With a caller-provided cluster the credentials were already used to connect it.
    if (config.cluster === undefined && (!username || !password)) {
      throw new Error(
        'Couchbase credentials are required: pass username and password, or set COUCHBASE_USERNAME and ' +
          'COUCHBASE_PASSWORD, or pass a connected cluster.'
      )
    }
    return new CouchbaseSdkBackend({
      connectionString: config.connectionString ?? process.env.COUCHBASE_CONNECTION_STRING ?? DEFAULT_CONNECTION_STRING,
      username: username ?? '',
      password: password ?? '',
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
      centroidsToProbe: this.centroidsToProbe,
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
    const explicitId = typeof metadataId === 'string'
    const key = explicitId ? metadataId : this.contentKey(content)
    // Skip the embedding call for a repeated fact; insertIfAbsent below stays the race-safe guard.
    if (!explicitId && (await this.backend.exists(key))) return key
    const embedding = await this.embed(content)
    const now = new Date().toISOString()
    const document: MemoryDocument = {
      content,
      embedding,
      metadata: cleanMetadata,
      namespace: this.namespace,
      created_at: now,
      updated_at: now,
    }
    // Without an explicit id, identical trimmed content maps to one key and a repeat keeps the original.
    if (explicitId) await this.backend.upsert(key, document)
    else await this.backend.insertIfAbsent(key, document)
    return key
  }

  /**
   * Closes the Couchbase connection if the store opened it. With background extraction, call
   * `memoryManager.flush()` first: extraction writes still running when the connection closes fail with
   * `cluster_closed (1006)`, and Strands only logs `memory extraction failed`.
   */
  async close(): Promise<void> {
    await this.backend.close()
  }

  private contentKey(content: string): string {
    // String.prototype.trim() differs slightly from Python's str.strip(): JS also trims a BOM (\ufeff)
    // and Python also trims \x1c-\x1f. Extracted facts won't realistically contain these, so keys match
    // across both SDKs in practice.
    const digest = createHash('sha256').update(content.trim(), 'utf8').digest('hex')
    return `memory::${this.namespace}::${digest}`
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

function validateDistanceMetric(distanceMetric: string): DistanceMetric {
  const metric = distanceMetric.trim().toUpperCase()
  if (!(DISTANCE_METRICS as readonly string[]).includes(metric)) {
    throw new Error(`distanceMetric must be one of ${DISTANCE_METRICS.join(', ')}; got '${distanceMetric}'`)
  }
  return metric as DistanceMetric
}

/** EUCLIDEAN and L2 are aliases, as are EUCLIDEAN_SQUARED and L2_SQUARED. */
function canonicalMetric(metric: string): string {
  const upper = metric.toUpperCase()
  if (upper === 'EUCLIDEAN') return 'L2'
  if (upper === 'EUCLIDEAN_SQUARED') return 'L2_SQUARED'
  return upper
}

function validatePositiveInteger(name: string, value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`${name} must be a positive integer; got ${value}`)
  }
  return value
}

function connectionError(connectionString: string, username: string, error: unknown): Error {
  const target = `Couchbase at ${connectionString} as '${username}'`
  if (error instanceof couchbase.AuthenticationFailureError) {
    return new Error(`Authentication failed connecting to ${target}. Check the username and password.`, {
      cause: error,
    })
  }
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(`Could not connect to ${target}: ${reason}. Check the connection string and network access.`, {
    cause: error,
  })
}

interface SearchFieldMapping {
  name?: string
  type?: string
  analyzer?: string
  dims?: number
}

/** Type mappings that apply to the store's collection (`scope.collection` or `scope.collection.<type>`). */
function searchTypeMappings(
  mapping: Record<string, any>,
  scopeCollection: string
): { typeMapping: Record<string, any> }[] {
  const types = isRecord(mapping.types) ? mapping.types : {}
  const matches = Object.entries(types)
    .filter(
      ([name, typeMapping]) =>
        (name === scopeCollection || name.startsWith(`${scopeCollection}.`)) && isRecord(typeMapping)
    )
    .map(([, typeMapping]) => ({ typeMapping: typeMapping as Record<string, any> }))
  if (isRecord(mapping.default_mapping) && mapping.default_mapping.enabled !== false) {
    matches.push({ typeMapping: mapping.default_mapping as Record<string, any> })
  }
  return matches.filter(({ typeMapping }) => typeMapping.enabled !== false)
}

/** Field mappings at a dotted path in a Search type mapping. */
function findSearchFields(typeMapping: Record<string, any>, path: string): SearchFieldMapping[] {
  const segments = path.split('.')
  let node: any = typeMapping
  for (const segment of segments) {
    node = isRecord(node?.properties) ? node.properties[segment] : undefined
    if (!isRecord(node)) return []
  }
  const leaf = segments[segments.length - 1]
  const fields: unknown[] = Array.isArray(node.fields) ? node.fields : []
  return fields.filter(
    (field): field is SearchFieldMapping =>
      isRecord(field) && field.index !== false && (field.name === undefined || field.name === leaf)
  ) as SearchFieldMapping[]
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
