// One-time Couchbase setup for the quickstart. Safe to run again.
//
// Hyperscale Vector Indexes are trained on vectors already in the collection, so creating one on an empty
// collection fails with ErrTraining. This script seeds placeholder vectors into a `_seed` namespace (the
// store never returns them, because every search filters on its own namespace), creates the index with
// the dimension and similarity from your config, waits until it is online, and checks that
// CouchbaseMemoryStore accepts it.
//
// Run: npm run example:setup   (reads .env; the bucket must already exist)
import * as couchbase from 'couchbase'
import { CouchbaseMemoryStore, type DistanceMetric } from '@couchbase-examples/strands-couchbase-memory'

const INDEX_NAME = 'strands-memory-vector-index'
const SEED_NAMESPACE = '_seed'
const SEED_COUNT = 256

const env = process.env
const connectionString = env.COUCHBASE_CONNECTION_STRING ?? 'couchbase://localhost'
const username = env.COUCHBASE_USERNAME
const password = env.COUCHBASE_PASSWORD
const bucketName = env.COUCHBASE_BUCKET ?? 'strands_memory'
const scopeName = env.COUCHBASE_SCOPE ?? '_default'
const collectionName = env.COUCHBASE_COLLECTION ?? '_default'
const distanceMetric = (env.COUCHBASE_DISTANCE_METRIC ?? 'L2_SQUARED') as DistanceMetric
const dimensions = Number(env.EMBEDDING_DIMENSIONS ?? 1536)

if (!username || !password)
  throw new Error('Set COUCHBASE_USERNAME and COUCHBASE_PASSWORD (copy .env.example to .env).')
if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error('EMBEDDING_DIMENSIONS must be a positive integer.')

const keyspace = `\`${bucketName}\`.\`${scopeName}\`.\`${collectionName}\``
const cluster = await couchbase.connect(connectionString, { username, password })
try {
  const collection = cluster.bucket(bucketName).scope(scopeName).collection(collectionName)

  console.log(`Seeding ${SEED_COUNT} training vectors (${dimensions} dimensions) into namespace '${SEED_NAMESPACE}'...`)
  const random = seededRandom(42)
  const seeds = Array.from({ length: SEED_COUNT }, (_, i) => {
    const vector = Array.from({ length: dimensions }, () => random() * 2 - 1)
    const norm = Math.hypot(...vector)
    return collection.upsert(`memory::${SEED_NAMESPACE}::${i}`, {
      content: `seed vector ${i}`,
      embedding: vector.map((value) => value / norm),
      metadata: { seed: true },
      namespace: SEED_NAMESPACE,
    })
  })
  await Promise.all(seeds).catch((error: unknown) => {
    throw new Error(`Could not write to ${keyspace}. Does the bucket '${bucketName}' exist?`, { cause: error })
  })

  const existing = await indexState()
  if (existing === undefined) {
    console.log(`Creating Hyperscale Vector Index ${INDEX_NAME} (dimension ${dimensions}, ${distanceMetric})...`)
    await cluster.query(`
      CREATE VECTOR INDEX \`${INDEX_NAME}\` ON ${keyspace} (\`embedding\` VECTOR)
      INCLUDE (\`content\`, \`metadata\`, \`namespace\`)
      USING GSI
      WITH {"dimension": ${dimensions}, "similarity": "${distanceMetric}", "description": "IVF,SQ8"}`)
  } else {
    const { dimension, similarity } = existing.index_options ?? {}
    if (dimension !== dimensions || similarity?.toUpperCase() !== distanceMetric.toUpperCase()) {
      throw new Error(
        `Index ${INDEX_NAME} already exists with dimension ${dimension} and similarity ${similarity}, but the config ` +
          `asks for ${dimensions} and ${distanceMetric}. Drop it (DROP INDEX \`${INDEX_NAME}\` ON ${keyspace}) ` +
          'and run this script again.'
      )
    }
    console.log(`Index ${INDEX_NAME} already exists.`)
  }

  for (let attempt = 0; (await indexState())?.state !== 'online'; attempt++) {
    if (attempt === 150) throw new Error(`Index ${INDEX_NAME} did not come online within 5 minutes.`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  // The same check MemoryManager runs when an agent starts: is there a vector index the store can use?
  const store = new CouchbaseMemoryStore({
    name: 'setup-check',
    cluster,
    bucketName,
    scopeName,
    collectionName,
    distanceMetric,
    dimensions,
    embeddingProvider: () => [],
  })
  await store.initialize()
  console.log(`Index ${INDEX_NAME} is online. Couchbase is ready.`)
} finally {
  await cluster.close()
}

async function indexState(): Promise<
  { state: string; index_options?: { dimension?: number; similarity?: string } } | undefined
> {
  // Indexes on _default._default are listed with keyspace_id = bucket and no bucket_id.
  const result = await cluster.query(
    `SELECT i.state, i.\`with\` AS index_options FROM system:indexes AS i
     WHERE i.name = $name
       AND ((i.bucket_id = $bucket AND i.scope_id = $scope AND i.keyspace_id = $collection)
         OR (i.bucket_id IS MISSING AND i.keyspace_id = $bucket AND $scope = '_default' AND $collection = '_default'))`,
    { parameters: { name: INDEX_NAME, bucket: bucketName, scope: scopeName, collection: collectionName } }
  )
  return result.rows[0]
}

/** Deterministic, so running the script again rewrites the same seed documents. */
function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}
