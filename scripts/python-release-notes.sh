#!/usr/bin/env bash
# Prints the release notes for a python-v* tag: GitHub's generated notes (grouped by
# .github/release.yml), filtered down to the pull requests that touched the Python package.
#
# This repository holds two packages, and GitHub's generator lists every PR merged since the
# previous tag, TypeScript ones included. The filter keeps a PR only if one of its commits
# in the release range touches a Python path below.
#
# Usage: GH_REPO=owner/repo scripts/python-release-notes.sh <tag> [<target-ref>]
#   <tag>         the release tag, e.g. python-v0.1.1. It does not have to exist yet.
#   <target-ref>  the commit the release covers; defaults to the tag if it exists, else HEAD.
# Needs full git history (fetch-depth: 0) and an authenticated `gh`.
set -euo pipefail

tag="${1:?usage: $0 <tag> [<target-ref>]}"
repo="${GH_REPO:?set GH_REPO=owner/repo}"
if [[ -n "${2:-}" ]]; then
  target="$2"
elif git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  target="$tag"
else
  target=HEAD
fi
target_sha="$(git rev-parse "$target^{commit}")"

paths=(
  python
  ':(glob).github/workflows/*-python.yml'
  scripts/setup-live-couchbase.sh
  scripts/smoke-test-python-package.sh
  scripts/python-release-notes.sh
)

# The newest python-v* tag reachable from the target, other than the tag being released.
previous="$(git tag --list 'python-v*' --merged "$target_sha" --sort=-v:refname | grep -vxF "$tag" | head -1 || true)"

prs="$(
  git log --format=%H "${previous:+$previous..}$target_sha" -- "${paths[@]}" | while read -r sha; do
    gh api "repos/$repo/commits/$sha/pulls" \
      --jq '.[] | select(.merged_at != null) | .number'
  done | sort -un | tr '\n' ' '
)"

# Without a previous python-v* tag (the first Python release), GitHub compares against the latest
# release of either package, so the notes start there and its Full Changelog link is dropped below.
args=(-f "tag_name=$tag" -f "target_commitish=$target_sha")
[[ -n "$previous" ]] && args+=(-f "previous_tag_name=$previous")
notes="$(gh api "repos/$repo/releases/generate-notes" "${args[@]}" --jq .body)"

# Keep bullet lines whose PR is in the list, and the headings above them; drop headings that end
# up empty. Everything else (the generator comment, Full Changelog link) passes through.
awk -v keep="$prs" -v previous="$previous" '
  BEGIN { n = split(keep, list, " "); for (i = 1; i <= n; i++) wanted[list[i]] = 1 }
  /^## /  { h2 = $0; h3 = ""; next }
  /^### / { h3 = $0; next }
  /^\* / {
    if (match($0, /\/pull\/[0-9]+/) && (substr($0, RSTART + 6, RLENGTH - 6) in wanted)) {
      if (h2 != "") { print ""; print h2; h2 = "" }
      if (h3 != "") { print h3; h3 = "" }
      print; kept++
    }
    next
  }
  /^\*\*Full Changelog\*\*/ {
    if (!kept) { print ""; print "No Python changes" (previous != "" ? " since " previous : "") "." }
    if (previous != "") { print ""; print }
    next
  }
  /^[[:space:]]*$/ { next }
  { print }
' <<<"$notes"
