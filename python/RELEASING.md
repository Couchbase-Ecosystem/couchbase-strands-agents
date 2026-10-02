# Releasing the Python package

Releases are published to PyPI as [`strands-couchbase`](https://pypi.org/project/strands-couchbase/) by `.github/workflows/release-python.yml` with PyPI trusted publishing (OIDC). No PyPI token is stored in GitHub, and trusted publishing attaches a [PEP 740](https://peps.python.org/pep-0740/) attestation to every file by default.

The version comes from the git tag through `hatch-vcs`: building at the commit tagged `python-v0.1.0` produces `0.1.0`. There is no version to bump in `pyproject.toml`. Anywhere else the build gets a development version such as `0.1.dev29+gc65a5f3`, which the release workflow refuses to publish.

## How the pieces fit

| Piece | What it does |
| --- | --- |
| `.github/workflows/draft-release-python.yml` | On every push to `main`, regenerates a draft GitHub release for the next version, named after the newest version heading in `CHANGELOG.md`. If that version is already tagged, the draft is named after the next patch as a placeholder. Hand edits to the draft are overwritten on the next merge. |
| `scripts/python-release-notes.sh` | Builds the notes: GitHub's generated notes since the previous `python-v*` tag, filtered to the PRs that touched the Python package. |
| `.github/release.yml` | Groups the notes by PR label (Features, Fixes, Testing and CI, …). PRs labelled `skip-changelog` are left out. |
| `.github/workflows/label-pull-requests.yml` | Labels PRs from their conventional-commit title and changed paths, so the notes stay grouped. |
| `.github/workflows/release-python.yml` | On a `python-v*` tag: builds the sdist and wheel, checks the built version matches the tag and is not on PyPI yet, runs lint, typecheck, unit tests and `twine check`, runs the live tests against Couchbase Server 8, installs the wheel in a clean venv and runs `examples/smoke_test.py`, publishes to PyPI from the `pypi` environment, then publishes the draft GitHub release (or creates one if there is no draft). |

## One-time setup

Do this once, before the first release. Each step needs an owner of the account involved.

1. **Decide who owns the PyPI project.** Whoever creates the trusted publisher below becomes the owner of `strands-couchbase` when the first upload creates it. Check whether Couchbase has a [PyPI organization](https://docs.pypi.org/organization-accounts/) first and create the publisher from it if so. Otherwise use a maintainer's account, and add the other maintainers as co-owners after the first release (**Manage** → **Collaborators**).
2. **Add a pending trusted publisher on PyPI**, shortly before tagging. A pending publisher does not reserve the name: anyone can still register `strands-couchbase` first, and the pending publisher is then dropped. On [pypi.org/manage/account/publishing](https://pypi.org/manage/account/publishing/) (or the organization's publishing page), add a GitHub publisher with:

   | Field | Value |
   | --- | --- |
   | PyPI project name | `strands-couchbase` |
   | Owner | `Couchbase-Ecosystem` |
   | Repository name | `couchbase-strands-agents` |
   | Workflow name | `release-python.yml` |
   | Environment name | `pypi` |

   The first successful upload turns it into a normal trusted publisher on the new project.
3. **Create the GitHub environment `pypi`** under **Settings** → **Environments** in this repository. Limit its deployment branches and tags to the tag pattern `python-v*`, and optionally add required reviewers so a maintainer approves each upload. The publish job is the only job that uses it, so reviewers are asked only after every check has passed. GitHub checks the tag rule against the ref the workflow runs from, so a manual run with `dry_run: false` must be started from the tag ("Use workflow from" → the tag), not from `main` with the `tag` input.
4. **Optional: rehearse on TestPyPI.** TestPyPI is a separate service with its own accounts, so it needs its own account and its own pending publisher (same fields, but a separate environment such as `testpypi`). Then point a temporary copy of the publish job at it with `repository-url: https://test.pypi.org/legacy/` and that environment. Don't merge that change. TestPyPI versions can't be reused either, so a rehearsal uses up the version number there.

## Every release

1. Look at the draft release on the [Releases page](https://github.com/Couchbase-Ecosystem/couchbase-strands-agents/releases) to see what has merged since the last release, and pick the next version (semver; anything that breaks the public API before 1.0 is a minor bump).
2. Open a release PR titled `chore(release): python <version>` that moves the entries under `## [Unreleased]` in `CHANGELOG.md` into a new `## [<version>] - <YYYY-MM-DD>` section (or, for 0.1.0, dates the existing entry), and updates the compare links at the bottom. For the first release, also change the `python/` row of the layout table in `AGENTS.md` to say it is on PyPI.

   When it merges, the draft is renamed to `python-v<version>`.
3. Optionally edit the draft's wording. Do this after the release PR merges, because each merge regenerates the draft.
4. Tag the release PR's merge commit by its exact hash. Fetch first, and check that the hash is that merge commit:

   ```bash
   git fetch origin
   git log --oneline -3 origin/main
   git tag python-v<version> <merge-commit-sha>
   git push origin python-v<version>
   ```

   The workflow fails if the version built at the tag is not exactly `<version>`, or if the version is already on PyPI.
5. Watch the **Release - Python** run, and approve the `pypi` deployment if the environment requires reviewers. When it passes, the package is on PyPI with attestations and the GitHub release is published.
6. Check the result:

   ```bash
   pip index versions strands-couchbase
   gh release view python-v<version>
   ```

   The attestations are listed on the file's page under **Download files** on pypi.org.

A pre-release version such as `0.2.0rc1` is marked as a pre-release on GitHub. `pip install strands-couchbase` skips it unless `--pre` is passed.

### Dry run

To rehearse without publishing, run the workflow manually from the Actions tab with `tag: python-v<version>` and `dry_run: true` (the default). It runs every check, the live tests and the clean-venv smoke test, and uploads the built files as the `python-dist` artifact. It skips the PyPI upload and does not touch the GitHub release.

Without a tag, or from a branch, the build has a development version, so the run stops at the version check.

### If something goes wrong

- **The workflow failed before the PyPI upload.** Fix the problem on `main`. If the fix changes the released code, delete the tag (`git push origin :refs/tags/python-v<version>`), then tag the new commit and push again. Otherwise re-run the failed jobs.
- **The PyPI upload succeeded but the GitHub release job failed.** Re-run only that job. It publishes the draft, or creates the release if there is no draft.
- **A bad version reached PyPI.** PyPI never accepts the same version or filename twice, even after a delete. [Yank](https://pypi.org/help/#yanked) the version on pypi.org (**Manage** → **Releases** → **Options** → **Yank**) with a reason and release a new patch.

## Settings that break publishing

These must match between this repository and PyPI. Renaming any of them without updating the trusted publisher on PyPI breaks publishing:

- the workflow filename `release-python.yml`;
- the GitHub environment name `pypi`;
- the repository name and owner, `Couchbase-Ecosystem/couchbase-strands-agents`;
- the project name `strands-couchbase` in `pyproject.toml`.

Changing `tag_regex` or `git_describe_command` in `pyproject.toml` changes how the version is read from the tag, and the version check then stops the release.
