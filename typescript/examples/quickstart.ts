// Two sessions, one memory. Session 1 tells the agent a few facts; session 2 is a brand-new agent with no
// conversation history that answers from what Couchbase remembered.
//
// Run: npm run example:setup && npm run example:quickstart   (reads .env; needs OPENAI_API_KEY)
//
// OpenAI is used for both the chat model and the embeddings, so one API key is enough. To switch:
// - Chat model: pass any Strands model, e.g. `new BedrockModel()` from '@strands-agents/sdk/models/bedrock'.
//   Without `model`, Strands uses Amazon Bedrock and your AWS credentials.
// - Embeddings: see "Embedding providers" in the README for Bedrock Titan and a local model. Set
//   EMBEDDING_DIMENSIONS to the new model's size and run the setup script again on an empty collection.
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import OpenAI from 'openai'
import { CouchbaseMemoryStore } from '@couchbase-examples/strands-couchbase-memory'

const openai = new OpenAI() // reads OPENAI_API_KEY

// Connection settings come from the COUCHBASE_* environment variables (see .env.example).
const store = new CouchbaseMemoryStore({
  name: 'couchbase',
  // One namespace per user. Bind it in your code, never from model output.
  namespace: 'user-alex',
  dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
  embeddingProvider: async (text) => {
    const response = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
    return response.data[0]!.embedding
  },
  // Distil each conversation into short facts with the agent's model and store them.
  extraction: true,
})

async function session(prompt: string): Promise<void> {
  // A fresh agent and MemoryManager each time: nothing carries over except what is in Couchbase.
  const memoryManager = new MemoryManager({ stores: [store] })
  const agent = new Agent({ model: new OpenAIModel({ modelId: 'gpt-5.4-mini' }), memoryManager, printer: false })
  console.log(`\nUser:  ${prompt}`)
  const result = await agent.invoke(prompt)
  console.log(`Agent: ${String(result).trim()}`)
  // Extraction runs in the background. Wait for it before the next session reads, and before close().
  await memoryManager.flush()
}

try {
  console.log('--- Session 1 ---')
  await session("Hi! I'm Alex. I'm vegetarian, I live in Lisbon, and I'm training for a half marathon in May.")

  console.log('\n--- Session 2 (new agent, no shared history) ---')
  await session('Can you suggest a dinner for me tonight and remind me what I am training for?')

  console.log('\n--- Stored memories ---')
  for (const entry of await store.search('Alex', { maxSearchResults: 10 })) {
    console.log(`- ${entry.content}`)
  }
} finally {
  await store.close()
}
