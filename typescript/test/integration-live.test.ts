import { randomUUID } from 'node:crypto'
import {
  Agent,
  MemoryManager,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk'
import * as couchbase from 'couchbase'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CouchbaseMemoryStore, type CouchbaseMemoryStoreConfig } from '../src/index.js'

const hasLiveEnv = process.env.COUCHBASE_INTEGRATION_TESTS === '1'

const bucketName = process.env.COUCHBASE_BUCKET ?? 'strands_memory'
const scopeName = process.env.COUCHBASE_SCOPE ?? '_default'
const collectionName = process.env.COUCHBASE_COLLECTION ?? '_default'

// One axis per topic, so ranking is predictable: a query about a topic must rank that topic's memory first.
const TOPICS: RegExp[] = [/dashboard|dark.mode|theme/i, /live|denver|city|home/i, /coffee|drink|oat/i]

function topicEmbedding(text: string): number[] {
  const vector = TOPICS.map((topic) => (topic.test(text) ? 1 : 0))
  return vector.some((value) => value > 0) ? vector : [0.1, 0.1, 0.1]
}

const FACTS = ['User prefers dark-mode dashboards.', 'User lives in Denver.', 'User drinks oat-milk coffee.']

/** Answers chat turns with a fixed reply, and extraction prompts with {@link FACTS} as a JSON array. */
class StubModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'stub-model' }
  extractionCalls = 0

  updateConfig(modelConfig: BaseModelConfig): void {
    this.config = { ...this.config, ...modelConfig }
  }

  getConfig(): BaseModelConfig {
    return this.config
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const prompt = messages
      .flatMap((message) => message.content)
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n')
    const isExtraction =
      prompt.startsWith('Extract facts from') || String(options?.systemPrompt ?? '').includes('extract')
    if (isExtraction) this.extractionCalls += 1
    const text = isExtraction ? JSON.stringify(FACTS.map((content) => ({ content }))) : 'Noted.'
    yield new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' })
    yield new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' })
    yield new ModelContentBlockDeltaEvent({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } })
    yield new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })
    yield new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
  }
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    value = await read()
  }
  return value
}

describe.skipIf(!hasLiveEnv)('live Couchbase integration', { timeout: 60_000 }, () => {
  let cluster: couchbase.Cluster
  const namespaces: string[] = []

  function newStore(overrides: Partial<CouchbaseMemoryStoreConfig> = {}): CouchbaseMemoryStore {
    const namespace = `vitest-${randomUUID()}`
    namespaces.push(namespace)
    return new CouchbaseMemoryStore({
      name: 'cb-live',
      embeddingProvider: topicEmbedding,
      dimensions: 3,
      cluster,
      bucketName,
      scopeName,
      collectionName,
      namespace,
      ...overrides,
    })
  }

  async function documentsIn(
    namespace: string
  ): Promise<Array<{ content: string; metadata: Record<string, unknown> }>> {
    const result = await cluster
      .bucket(bucketName)
      .scope(scopeName)
      .query(`SELECT content, metadata FROM \`${collectionName}\` WHERE \`namespace\` = $namespace`, {
        parameters: { namespace },
        scanConsistency: couchbase.QueryScanConsistency.RequestPlus,
      })
    return result.rows
  }

  beforeAll(async () => {
    cluster = await couchbase.connect(process.env.COUCHBASE_CONNECTION_STRING ?? 'couchbase://localhost', {
      username: process.env.COUCHBASE_USERNAME ?? 'Administrator',
      password: process.env.COUCHBASE_PASSWORD ?? 'password',
    })
  })

  afterAll(async () => {
    if (cluster === undefined) return
    try {
      for (const namespace of namespaces) {
        await cluster
          .bucket(bucketName)
          .scope(scopeName)
          .query(`DELETE FROM \`${collectionName}\` WHERE \`namespace\` = $namespace`, {
            parameters: { namespace },
            scanConsistency: couchbase.QueryScanConsistency.RequestPlus,
          })
      }
    } finally {
      await cluster.close()
    }
  })

  it('ranks the closest memory first through Hyperscale Vector Search', async () => {
    const store = newStore()
    for (const fact of FACTS) await store.add(fact, { test: 'live' })

    const read = () => store.search('Where does the user live?', { maxSearchResults: 5 })
    const results = await waitFor(read, (hits) => hits.length === FACTS.length)

    expect(results.map((entry) => entry.content).sort()).toEqual([...FACTS].sort())
    expect(results[0]?.content).toBe('User lives in Denver.')
    expect(results.every((entry) => entry.metadata?.namespace === namespaces.at(-1))).toBe(true)

    const coffee = await store.search('What does the user drink?', { maxSearchResults: 5 })
    expect(coffee[0]?.content).toBe('User drinks oat-milk coffee.')
  })

  it('stores extracted facts, not raw turns, through MemoryManager with extraction: true', async () => {
    const model = new StubModel()
    const store = newStore({ writable: true, extraction: true })
    const memoryManager = new MemoryManager({ stores: [store] })
    const agent = new Agent({ model, memoryManager, printer: false })

    await agent.invoke('I prefer dark-mode dashboards, I live in Denver and I drink oat-milk coffee.')
    await memoryManager.flush()

    expect(model.extractionCalls).toBeGreaterThan(0)
    const namespace = namespaces.at(-1)!
    const documents = await waitFor(
      () => documentsIn(namespace),
      (docs) => docs.length >= FACTS.length
    )
    // Regression for #6: raw user/assistant turns must never be stored as memories.
    expect(documents.map((doc) => doc.content).sort()).toEqual([...FACTS].sort())
    expect(documents.some((doc) => doc.metadata?.source === 'strands.addMessages')).toBe(false)

    const results = await store.search('How does the user like dashboards?')
    expect(results[0]?.content).toBe('User prefers dark-mode dashboards.')
  })
})
