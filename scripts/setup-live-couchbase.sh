#!/usr/bin/env bash
# Initialize a fresh single-node Couchbase Server for the live integration tests:
# cluster init, bucket, seed documents and the Hyperscale Vector Index.
#
# Hyperscale Vector Indexes are trained on existing vectors, so seed documents are
# written (in their own namespace) before the index is created.
#
# Usage: scripts/setup-live-couchbase.sh
# Env:   COUCHBASE_HOST (localhost), COUCHBASE_MGMT_PORT (8091), COUCHBASE_QUERY_PORT (8093),
#        COUCHBASE_USERNAME (Administrator), COUCHBASE_PASSWORD (password),
#        COUCHBASE_BUCKET (strands_memory), COUCHBASE_VECTOR_DIMENSIONS (3),
#        COUCHBASE_DISTANCE_METRIC (L2_SQUARED), COUCHBASE_NODE_HOSTNAME (127.0.0.1; the address
#        the node advertises to SDK clients)
set -euo pipefail

HOST="${COUCHBASE_HOST:-localhost}"
MGMT="http://${HOST}:${COUCHBASE_MGMT_PORT:-8091}"
QUERY="http://${HOST}:${COUCHBASE_QUERY_PORT:-8093}/query/service"
USERNAME="${COUCHBASE_USERNAME:-Administrator}"
PASSWORD="${COUCHBASE_PASSWORD:-password}"
BUCKET="${COUCHBASE_BUCKET:-strands_memory}"
DIMENSIONS="${COUCHBASE_VECTOR_DIMENSIONS:-3}"
METRIC="${COUCHBASE_DISTANCE_METRIC:-L2_SQUARED}"
INDEX_NAME="strands-memory-vector-index"

log() { echo "[setup-live-couchbase] $*"; }

retry() {
  local attempts=$1 delay=$2
  shift 2
  for ((i = 1; i <= attempts; i++)); do
    if "$@"; then return 0; fi
    sleep "$delay"
  done
  log "gave up after ${attempts} attempts: $*"
  return 1
}

query() {
  local response
  response=$(curl -sS -u "${USERNAME}:${PASSWORD}" "$QUERY" --data-urlencode "statement=$1")
  if [[ "$(jq -r '.status' <<<"$response")" != "success" ]]; then
    echo "$response" >&2
    return 1
  fi
  echo "$response"
}

log "waiting for Couchbase REST API at ${MGMT}"
retry 60 2 curl -sf -o /dev/null "${MGMT}/ui/index.html"

if curl -sf -o /dev/null -u "${USERNAME}:${PASSWORD}" "${MGMT}/pools/default"; then
  log "cluster already initialized"
else
  log "initializing cluster (kv, n1ql, index)"
  curl -sSf -o /dev/null "${MGMT}/clusterInit" \
    -d hostname="${COUCHBASE_NODE_HOSTNAME:-127.0.0.1}" \
    -d services=kv,n1ql,index \
    -d memoryQuota=512 \
    -d indexMemoryQuota=512 \
    -d indexerStorageMode=plasma \
    -d clusterName=strands-live \
    -d port=SAME \
    --data-urlencode "username=${USERNAME}" \
    --data-urlencode "password=${PASSWORD}"
fi

if curl -sf -o /dev/null -u "${USERNAME}:${PASSWORD}" "${MGMT}/pools/default/buckets/${BUCKET}"; then
  log "bucket ${BUCKET} already exists"
else
  log "creating bucket ${BUCKET}"
  curl -sSf -o /dev/null -u "${USERNAME}:${PASSWORD}" "${MGMT}/pools/default/buckets" \
    -d name="${BUCKET}" -d bucketType=couchbase -d ramQuota=256 -d replicaNumber=0 -d flushEnabled=1
fi

log "seeding training documents"
seed_docs() {
  local values=() i vector d
  for ((i = 0; i < 16; i++)); do
    vector=()
    for ((d = 0; d < DIMENSIONS; d++)); do vector+=("$(((i * 7 + d * 3) % 11)).0"); done
    values+=("VALUES (\"seed::${i}\", {\"content\": \"seed document ${i}\", \"embedding\": [$(IFS=,; echo "${vector[*]}")], \"metadata\": {\"seed\": true}, \"namespace\": \"__seed__\"})")
  done
  query "UPSERT INTO \`${BUCKET}\` (KEY, VALUE) $(IFS=,; echo "${values[*]}")" >/dev/null
}
# Retries cover the bucket warming up after creation.
retry 60 2 seed_docs

if [[ "$(query "SELECT RAW COUNT(*) FROM system:indexes WHERE name = '${INDEX_NAME}'" | jq '.results[0]')" != "0" ]]; then
  log "index ${INDEX_NAME} already exists"
else
  log "creating Hyperscale Vector Index ${INDEX_NAME} (dimension ${DIMENSIONS}, ${METRIC})"
  retry 10 3 query "CREATE VECTOR INDEX \`${INDEX_NAME}\`
    ON \`${BUCKET}\`.\`_default\`.\`_default\` (\`embedding\` VECTOR)
    INCLUDE (\`content\`, \`metadata\`, \`namespace\`)
    USING GSI
    WITH {\"dimension\": ${DIMENSIONS}, \"similarity\": \"${METRIC}\", \"description\": \"IVF,SQ8\"}" >/dev/null
fi

index_online() {
  [[ "$(query "SELECT RAW state FROM system:indexes WHERE name = '${INDEX_NAME}'" | jq -r '.results[0]')" == "online" ]]
}
log "waiting for ${INDEX_NAME} to come online"
retry 90 2 index_online
log "ready"
