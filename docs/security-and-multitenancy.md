# Security and multi-tenancy

This package is a native Strands `MemoryStore`, not an agent-facing direct database tool. Applications construct `CouchbaseMemoryStore` instances in trusted application code, then pass them to Strands `MemoryManager`.

## Security model

The model should not be allowed to choose Couchbase connection details. Keep these values in application configuration, environment variables, or a secrets manager:

- connection string
- username and password
- bucket, scope, and collection
- vector backend and index/search configuration
- namespace / tenant scope
- embedding provider credentials

The Strands agent sees memory through `MemoryManager` tools such as `search_memory` and optional `add_memory`. Those tools operate through the configured store; they do not expose Couchbase credentials or bucket routing as model-controllable parameters.

This is the same pattern used by Strands' own memory-store documentation: build stores in application code, attach them to `MemoryManager`, and let the manager handle recall, injection, and optional writes.

## Per-tenant store construction

For multi-tenant applications, construct one store per authenticated principal or tenant. Bind the namespace outside the model, and do not accept a namespace from a model response.

Python:

```python
from strands import Agent
from strands.memory import MemoryManager
from strands_couchbase_memory import CouchbaseMemoryStore


def build_agent_for_user(user_id: str, embedding_provider) -> Agent:
    store = CouchbaseMemoryStore(
        name="personal_memory",
        description="Durable user preferences and facts.",
        connection_string="couchbases://cb.example.com",
        username="app_user",
        password="read-from-secrets-manager",
        bucket_name="agent_memory",
        scope_name="app",
        collection_name="memories",
        namespace=f"user_{user_id}",
        embedding_provider=embedding_provider,
        dimensions=1536,
        writable=True,
        extraction=True,
    )
    return Agent(memory_manager=MemoryManager(stores=[store]))
```

TypeScript:

```ts
import { Agent, MemoryManager } from '@strands-agents/sdk'
import { CouchbaseMemoryStore } from '@couchbase-examples/strands-couchbase-memory'

export function buildAgentForUser(userId: string, embeddingProvider: { embed(text: string): Promise<number[]> }) {
  const store = new CouchbaseMemoryStore({
    name: 'personal_memory',
    description: 'Durable user preferences and facts.',
    connectionString: 'couchbases://cb.example.com',
    username: 'app_user',
    password: 'read-from-secrets-manager',
    bucketName: 'agent_memory',
    scopeName: 'app',
    collectionName: 'memories',
    namespace: `user_${userId}`,
    embeddingProvider,
    dimensions: 1536,
    writable: true,
    extraction: true,
  })
  return new Agent({ memoryManager: new MemoryManager({ stores: [store] }) })
}
```

## Namespace naming patterns

Useful namespace patterns include:

- `user_{user_id}` for personal memory
- `org_{org_id}` for organization-wide knowledge
- `org_{org_id}_user_{user_id}` for per-user memory within an organization
- `session_{session_id}` for temporary session-scoped recall
- `feature_{feature_name}` for product-area-specific memory

Use names that are stable, opaque, and derived from authenticated application state rather than model text.

## Multiple stores

Strands `MemoryManager` can own multiple stores. Use this when an agent should search personal, team, and global knowledge with different tenancy boundaries:

```python
agent = Agent(
    memory_manager=MemoryManager(
        stores=[personal_store, team_store, global_store]
    )
)
```

The manager annotates results with the store identity so the model and application can tell which store produced each entry.

## Credential and network guidance

- Use Couchbase Capella database credentials with the least privileges needed for the target bucket/scope/collection and query/index/search path.
- Configure Capella allowed IPs or private connectivity for the application runtime.
- Prefer `couchbases://` and TLS for remote deployments.
- Do not commit `.env` files or API keys. The repository's `.env.example` files intentionally use placeholders.
- Use distinct Couchbase users or collections when regulatory isolation requires more than namespace filtering.

## Prompt-injection considerations

Treat all retrieved memories and source documents as untrusted content. A stored memory should not be able to instruct the application to change Couchbase credentials, change namespace, or reveal secrets. Keep privileged routing and credential decisions in application code, outside the model-facing tool schema.
