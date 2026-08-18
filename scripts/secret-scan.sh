#!/usr/bin/env bash
set -euo pipefail

# Lightweight repository secret scan for common accidental credentials.
# This intentionally avoids printing matching secret values.
patterns=(
  'gho_[A-Za-z0-9_]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'AKIA[0-9A-Z]{16}'
  '-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----'
  'COUCHBASE_PASSWORD=.*[^*[:space:]]'
)

status=0
for pattern in "${patterns[@]}"; do
  if git grep -n -E "$pattern" -- ':!scripts/secret-scan.sh' ':!**/.env.example' >/tmp/secret-scan-hit 2>/dev/null; then
    echo "Potential secret pattern found: $pattern"
    cut -d: -f1-2 /tmp/secret-scan-hit
    status=1
  fi
done
rm -f /tmp/secret-scan-hit
exit "$status"
