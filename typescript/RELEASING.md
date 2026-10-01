# Releasing the TypeScript package

Releases are published by `.github/workflows/release-typescript.yml` with npm trusted publishing (OIDC) and `--provenance`. No npm token is stored in GitHub.

## Every release

1. Update `version` in `package.json` (and the lockfile with `npm install --package-lock-only`) and add a section to `CHANGELOG.md`.
2. Merge to `main`, then tag that commit `typescript-v<version>` and push the tag. The workflow fails if the tag and `package.json` disagree.
3. Optional dry run first: run the workflow manually with `tag: typescript-v<version>` and `dry_run: true`. It runs every check, the live tests, a clean-project install of the packed tarball with the quickstart, and `npm publish --dry-run`, then stops.
4. The tag push runs the same steps and then `npm publish --provenance --access public`.

## First release only

npm only lets you add a trusted publisher to a package that already exists, so `0.1.0` has to be published by hand:

1. Run the workflow manually with `tag: typescript-v0.1.0` and `dry_run: true`, and check that it passes.
2. From a clean checkout of the tag, as an `@couchbase-examples` org member with 2FA:

   ```bash
   cd typescript
   npm ci
   npm run smoke:package
   npm publish --access public
   ```

   `--provenance` only works from a supported CI provider, so this first version has no provenance attestation.
3. On npmjs.com, open the package's **Settings** → **Trusted publishing** → **GitHub Actions** and enter organization `Couchbase-Ecosystem`, repository `couchbase-strands-agents`, workflow filename `release-typescript.yml`, environment `npm`.
4. Under **Publishing access**, choose "Require two-factor authentication and disallow tokens" so that only the workflow can publish.

Every later version is published by the workflow.
