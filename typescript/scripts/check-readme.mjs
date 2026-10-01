#!/usr/bin/env node
// Keeps README.md's TypeScript blocks honest.
// - A ```ts block right after `<!-- embed: examples/<file>.ts -->` must match that file exactly.
//   `--write` copies the files into the README instead of failing.
// - Every ```ts block is written to .readme-snippets/ and compiled with tsconfig.readme.json.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = join(root, 'README.md')
const outDir = join(root, '.readme-snippets')
const write = process.argv.includes('--write')

let readme = readFileSync(readmePath, 'utf8')
const blockPattern = /(<!-- embed: (\S+) -->\n\n)?```ts\n([\s\S]*?)```\n/g
const stale = []
readme = readme.replace(blockPattern, (block, marker, embedPath, code) => {
  if (embedPath === undefined) return block
  const source = readFileSync(join(root, embedPath), 'utf8')
  if (source === code) return block
  stale.push(embedPath)
  return `${marker}\`\`\`ts\n${source}\`\`\`\n`
})
if (stale.length > 0) {
  if (!write) {
    console.error(`README.md is out of date with ${stale.join(', ')}. Run \`npm run readme:sync\`.`)
    process.exit(1)
  }
  writeFileSync(readmePath, readme)
  console.log(`Updated README.md from ${stale.join(', ')}.`)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir)
const blocks = [...readme.matchAll(blockPattern)].map((match) => match[3])
blocks.forEach((code, i) => {
  // `export {}` makes every block a module, so top-level await compiles.
  writeFileSync(join(outDir, `block-${String(i + 1).padStart(2, '0')}.ts`), `${code}\nexport {}\n`)
})
try {
  execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', join(root, 'tsconfig.readme.json')], {
    stdio: 'inherit',
  })
} catch {
  console.error(`README.md TypeScript blocks failed to compile (written to ${outDir}).`)
  process.exit(1)
}
console.log(`README.md: ${blocks.length} TypeScript blocks compile.`)
