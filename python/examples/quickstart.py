"""Two sessions, one memory. Session 1 tells the agent a few facts; session 2 is a brand-new agent with no
conversation history that answers from what Couchbase remembered.

Run (Python doesn't read .env by itself; needs OPENAI_API_KEY and `pip install 'strands-agents[openai]'`):

    set -a; source .env; set +a
    python examples/setup.py && python examples/quickstart.py

OpenAI is used for both the chat model and the embeddings, so one API key is enough. To switch:
- Chat model: pass any Strands model, e.g. `BedrockModel()` from `strands.models.bedrock`.
  Without `model`, Strands uses Amazon Bedrock and your AWS credentials.
- Embeddings: see "Embedding providers" in the README for Bedrock Titan and a local model. Set
  EMBEDDING_DIMENSIONS to the new model's size and run the setup script again on an empty collection.
"""

from __future__ import annotations

import asyncio
import os

from openai import AsyncOpenAI
from strands import Agent
from strands.memory import MemoryManager
from strands.models.openai import OpenAIModel

from strands_couchbase import CouchbaseMemoryStore

openai = AsyncOpenAI()  # reads OPENAI_API_KEY


class OpenAIEmbeddings:
    async def embed(self, text: str) -> list[float]:
        response = await openai.embeddings.create(model="text-embedding-3-small", input=text)
        return response.data[0].embedding


# Connection settings and the distance metric come from the COUCHBASE_* environment variables
# (see .env.example).
store = CouchbaseMemoryStore(
    name="couchbase",
    # One namespace per user. Bind it in your code, never from model output.
    namespace="user-alex",
    dimensions=int(os.getenv("EMBEDDING_DIMENSIONS", "1536")),
    embedding_provider=OpenAIEmbeddings(),
    # Distil each conversation into short facts with the agent's model and store them.
    extraction=True,
)


async def session(prompt: str) -> None:
    # A fresh agent and MemoryManager each time: nothing carries over except what is in Couchbase.
    memory_manager = MemoryManager(stores=[store])
    agent = Agent(
        model=OpenAIModel(model_id="gpt-5.4-mini"),
        memory_manager=memory_manager,
        callback_handler=None,
    )
    print(f"\nUser:  {prompt}")
    result = await agent.invoke_async(prompt)
    print(f"Agent: {str(result).strip()}")
    # Extraction runs in the background. Wait for it before the next session reads, and before close().
    await memory_manager.flush()


async def main() -> None:
    try:
        print("--- Session 1 ---")
        await session("Hi! I'm Alex. I'm vegetarian, I live in Lisbon, and I'm training for a half marathon in May.")

        print("\n--- Session 2 (new agent, no shared history) ---")
        await session("Can you suggest a dinner for me tonight and remind me what I am training for?")

        print("\n--- Stored memories ---")
        for entry in await store.search("Alex", {"max_search_results": 10}):
            print(f"- {entry.content}")
    finally:
        await store.close()


if __name__ == "__main__":
    asyncio.run(main())
