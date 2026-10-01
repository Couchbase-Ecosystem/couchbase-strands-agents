# AGENTS.md

Notes for anyone, human or agent, changing this repository. The package READMEs are for users. This file covers how the repository is worked on and released.

## Layout

| Path | What it is | Tooling |
| --- | --- | --- |
| `typescript/` | `@couchbase-ecosystem/strands-couchbase` on npm | npm with `package-lock.json`, Node.js 22+ |
| `python/` | `strands-couchbase` (not on PyPI yet) | hatch, version from `python-v*` tags via `hatch-vcs` |
| `docs/` | Shared setup, tutorial and design docs | |
| `scripts/` | Live Couchbase setup, secret scan, Python package smoke test, release notes for each package | bash |

The two packages are independent: separate CI workflows, tags, changelogs and release workflows. Keep a change to one package out of the other unless it really affects both. Don't switch package managers (npm, hatch) or merge the per-package workflows.

## Checks

TypeScript, from `typescript/`:

```bash
npm ci
npm run check            # format:check, lint, type-check (includes README snippets), test, build
npm pack --dry-run
npm run smoke:package    # installs the packed tarball in a clean project
```

Run `npm run readme:sync` after changing a code sample in `typescript/README.md`. The live tests (`npm run test:live`) need Couchbase Server 8 with the bucket and index from `scripts/setup-live-couchbase.sh`. CI runs them in `live-typescript.yml`.

Python, from `python/`:

```bash
pip install hatch
hatch run lint && hatch run typecheck && hatch run test && hatch run build
```

The live tests (`COUCHBASE_INTEGRATION_TESTS=1 hatch run test -m integration`) need Couchbase Server 8 with the bucket and index from `scripts/setup-live-couchbase.sh`, and so does `scripts/smoke-test-python-package.sh`, which installs the built wheel in a clean venv and runs `examples/smoke_test.py`. CI runs them in `live-python.yml`.

Repository-wide: `./scripts/secret-scan.sh`. Never commit `.env` files or credentials.

## Pull requests

- Use a conventional-commit title with the package as the scope, for example `fix(typescript): …`, `feat(python): …`, `chore(deps): …`, `ci(typescript): …`, `docs: …`.
- For a user-visible change, add a line under `## [Unreleased]` in that package's changelog (`typescript/CHANGELOG.md` or `python/CHANGELOG.md`) in the same PR.
- Label the PR. Release notes are generated from merged PR titles and grouped by label (`.github/release.yml`); an unlabelled PR ends up under "Other changes".

| Label | Use for |
| --- | --- |
| `breaking-change` | Public API, supported Node/Python or `@strands-agents/sdk` range, or stored document format changes in a way users must act on |
| `enhancement` | New functionality |
| `bug` | Fixes |
| `testing` | Test suite changes |
| `ci` | Workflows and release automation |
| `documentation` | Documentation only |
| `dependencies` | Dependency updates |
| `skip-changelog` | Release version bumps and chores that should not appear in the notes |
| `typescript`, `python` | Which package the PR touches (for filtering, not for the notes) |

`label-pull-requests.yml` applies most of these automatically: from the title prefix (`feat` → `enhancement`, `fix` → `bug`, `docs` → `documentation`, `test` → `testing`, `ci`/`build` → `ci`, a `deps` scope → `dependencies`, a `release` scope → `skip-changelog`, `!` or a `BREAKING CHANGE:` footer → `breaking-change`) and from changed paths (`.github/**` → `ci`, `*.md` → `documentation`, test files → `testing`, package directories → `typescript`/`python`). It only adds labels, so a label corrected by hand stays. Labels can still be fixed after merge; then run **Draft release - TypeScript** or **Draft release - Python** from the Actions tab to regenerate the draft.

## Releases

The full checklists are in [`typescript/RELEASING.md`](typescript/RELEASING.md) and [`python/RELEASING.md`](python/RELEASING.md), and both packages are summarized in [`RELEASING.md`](RELEASING.md). The TypeScript flow:

1. Every merge to `main` refreshes a draft GitHub release for the next TypeScript version (`draft-release-typescript.yml`). Only PRs that touched the TypeScript package are listed.
2. A maintainer opens a `chore(release): typescript <version>` PR that bumps `typescript/package.json` and the lockfile and dates the `Unreleased` changelog entries.
3. After it merges, a maintainer pushes the tag `typescript-v<version>`. `release-typescript.yml` checks the tag against `package.json` and npm, runs every check and the live tests, publishes to npm with provenance over OIDC, then publishes the draft release.

The Python flow:

1. Every merge to `main` refreshes a draft GitHub release for the next Python version (`draft-release-python.yml`), named after the newest version in `python/CHANGELOG.md`. Only PRs that touched the Python package are listed.
2. A maintainer opens a `chore(release): python <version>` PR that dates the `Unreleased` changelog entries. There is no version to bump: `hatch-vcs` reads it from the tag.
3. After it merges, a maintainer runs `git fetch` and pushes the tag `python-v<version>` on that exact commit hash. `release-python.yml` checks that the built version equals the tag and is not on PyPI, runs every check, the live tests and the clean-venv smoke test, publishes to PyPI over OIDC from the `pypi` environment, then publishes the draft release.

Agents may prepare release PRs (version bump, changelog, docs). Pushing `typescript-v*` or `python-v*` tags, publishing or editing GitHub releases, running the release workflows with `dry_run: false`, and anything on npmjs.com or PyPI need explicit approval from a maintainer for that specific release. Ask before dispatching a release workflow, even as a dry run.

Things that break publishing if changed without updating npmjs.com: the workflow filename `release-typescript.yml`, the `npm` environment name, and `repository.url` in `typescript/package.json` (provenance requires it to match this repository).

Things that break publishing if changed without updating the trusted publisher on PyPI: the workflow filename `release-python.yml`, the `pypi` environment name, and the project name in `python/pyproject.toml`.
