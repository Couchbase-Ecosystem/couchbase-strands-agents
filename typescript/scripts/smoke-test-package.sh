#!/usr/bin/env bash
# Pack the package, install the tarball into a clean project and use it the way a consumer would:
# ESM import, TypeScript type resolution, and MemoryManager wiring. With COUCHBASE_INTEGRATION_TESTS=1
# it also runs examples/basic-memory.ts (the quickstart) against the configured Couchbase cluster.
#
# Usage: scripts/smoke-test-package.sh [path/to/package.tgz]   (packs the current tree when omitted)
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="$(node -p "require('${PACKAGE_DIR}/package.json').name")"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

if [[ $# -gt 0 ]]; then
  TARBALL="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  (cd "$PACKAGE_DIR" && npm pack --silent --pack-destination "$WORK_DIR" >/dev/null)
  TARBALL="$(ls "$WORK_DIR"/*.tgz)"
fi
echo "[smoke] tarball: $TARBALL"

CONTENTS="$(tar -tzf "$TARBALL")"
for required in package/LICENSE package/CHANGELOG.md package/README.md package/dist/index.js package/dist/index.d.ts package/src/index.ts; do
  grep -qx "$required" <<<"$CONTENTS" || { echo "[smoke] missing from tarball: $required"; exit 1; }
done

APP_DIR="$WORK_DIR/app"
mkdir -p "$APP_DIR"
cd "$APP_DIR"
npm init -y >/dev/null
npm pkg set type=module
npm install --silent --no-audit --no-fund "$TARBALL" '@strands-agents/sdk@>=1.13.0 <2.0.0' typescript@5 @types/node@22

cat >consumer.ts <<EOF
import { MemoryManager, ModelExtractor } from '@strands-agents/sdk'
import { CouchbaseMemoryStore, type CouchbaseBackend } from '${PACKAGE_NAME}'

const backend: CouchbaseBackend = {
  async upsert() {},
  async vectorSearch(input) {
    return [{ id: 'memory-1', content: 'User prefers dark-mode dashboards.', metadata: {}, namespace: input.namespace }]
  },
  async close() {},
}

const store = new CouchbaseMemoryStore({
  name: 'couchbase',
  embeddingProvider: () => [0, 1, 0],
  dimensions: 3,
  backend,
  extraction: true,
})
const manager = new MemoryManager({ stores: [store] })
const [binding] = (manager as any)._extractionStores
if (!(binding.config.extractor instanceof ModelExtractor)) throw new Error('extraction: true did not resolve to ModelExtractor')

const key: string = await store.add('User prefers dark-mode dashboards.')
const [hit] = await store.search('dashboards')
if (!key || hit?.content !== 'User prefers dark-mode dashboards.') throw new Error('unexpected store behaviour')
console.log('[smoke] consumer import, types and MemoryManager wiring OK')
EOF

npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck consumer.ts
echo "[smoke] TypeScript types resolve from the tarball"
node --experimental-strip-types --no-warnings consumer.ts

# ESM-only: there is no CommonJS build. Node 22.12+ can still require() it through require(esm).
if [[ "$(node -p 'process.features.require_module === true')" == "true" ]]; then
  node -e "const { CouchbaseMemoryStore } = require('${PACKAGE_NAME}'); if (typeof CouchbaseMemoryStore !== 'function') process.exit(1)"
  echo "[smoke] require() loads the ESM build via Node's require(esm)"
fi

if [[ "${COUCHBASE_INTEGRATION_TESTS:-0}" == "1" ]]; then
  sed "s#'../src/index.js'#'${PACKAGE_NAME}'#" "$PACKAGE_DIR/examples/basic-memory.ts" >quickstart.ts
  node --experimental-strip-types --no-warnings quickstart.ts | tee quickstart.log
  grep -q '^hit: ' quickstart.log || { echo "[smoke] quickstart returned no hits"; exit 1; }
  echo "[smoke] quickstart ran against Couchbase from the installed tarball"
fi
