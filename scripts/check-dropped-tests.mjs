#!/usr/bin/env node
/**
 * Fail when a branch would delete test cases that exist on the base.
 *
 * This exists because it happened twice in one day and git said nothing both
 * times. A branch opened before several PRs landed replaces a whole test file
 * rather than merging it, so there is no textual conflict — the file is simply
 * the older version plus the author's additions. Merging it silently removes
 * every case added in between.
 *
 * Observed on Lens #480 (19 cases: the Zod argument suite and the upstream
 * deadline suite) and again on #492 (the same 19). Both reported "mergeable",
 * both typechecked, and in both cases the loss was only visible by counting
 * `it(` on each side.
 *
 * What this does NOT do: run the tests, or judge whether a removal is correct.
 * Removing a test is sometimes exactly right — the feature went away, the case
 * was a duplicate, the assertion was wrong. It reports which cases disappear so
 * the decision is made deliberately rather than by accident. Say so in the PR
 * and apply the override label.
 *
 * Compares the base against the MERGE RESULT, not against the branch tip.
 * Comparing against the tip over-reports wildly — a branch 47 commits behind
 * is "missing" every case added since it forked, whether or not merging would
 * drop them. What matters is the tree that would actually land.
 *
 * Case identity is the title plus its multiplicity, repository-wide:
 *  - Duplicate titles are counted separately, so removing one of two copies is
 *    reported (a Set keyed by title silently ignored that).
 *  - Comparing titles across the repository rather than per file means renaming
 *    or moving a test file is not reported as a deletion when its cases remain.
 *  - `it.each` rows are one declaration with one title, not one case per row.
 *  - Constructs inside comments, strings, templates or regex literals are not
 *    cases; extraction lives in dropped-tests.mjs and is not a single regex.
 *
 * A merge with conflicts is not compared at all: the conflicted tree contains
 * both sides' chunks and cannot say what would actually land, so the check
 * fails closed instead of reporting a result that may give false comfort.
 *
 *   node scripts/check-dropped-tests.mjs <base-ref> [head-ref]
 *
 * Exits 1 when cases are missing from the merge result (or the merge
 * conflicts), 0 otherwise.
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { compareTestCases, extractTestCases } from './dropped-tests.mjs'

const DEFAULT_BASE = 'origin/main'

/** Test files: `foo.test.ts`, `foo.spec.js`, and the .mjs/.cjs/.tsx variants. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** Test files tracked at a ref. */
export function testFilesAt(ref) {
  return git('ls-tree', '-r', '--name-only', ref)
    .split('\n')
    .filter((file) => TEST_FILE.test(file))
}

/** Every test-case title in every test file at a ref. */
export function casesAt(ref) {
  const cases = []
  for (const file of testFilesAt(ref)) {
    let source
    try {
      source = git('show', `${ref}:${file}`)
    } catch {
      continue
    }
    cases.push(...extractTestCases(source))
  }
  return cases
}

/**
 * The tree merging HEAD into BASE would produce, or a conflict marker.
 *
 * `git merge-tree --write-tree` exits 1 and still prints a tree on conflict.
 * That tree is not a merge result — it can contain conflict markers and only
 * parts of either side — so it is reported as conflicting and never compared.
 */
export function mergeResult(base, head) {
  try {
    const stdout = git('merge-tree', '--write-tree', base, head)
    return { tree: stdout.trim().split('\n')[0], conflict: false }
  } catch (error) {
    if (error && error.status === 1) {
      return { tree: null, conflict: true }
    }
    throw error
  }
}

/** Run the check. Returns the process exit code. */
export function run(base = DEFAULT_BASE, head = 'HEAD', log = console.log) {
  const merged = mergeResult(base, head)
  if (merged.conflict) {
    log(
      `Merging ${head} into ${base} conflicts, so no merge tree can be compared.` +
        '\nResolve the conflicts and push again; the dropped-test check is not run' +
        '\nagainst a conflicted tree because it cannot say what would land.',
    )
    return 1
  }

  const baseCases = casesAt(base)
  const result = compareTestCases(baseCases, casesAt(merged.tree))

  log(`base ${base}: ${result.baseCount} cases`)
  log(`merging ${head}: ${result.headCount} cases`)

  if (result.missingCount === 0) {
    log('\nNo test case present on the base is missing from this branch.')
    return 0
  }

  log(`\n${result.missingCount} test case(s) on ${base} would be removed by merging:\n`)
  for (const { name, count } of result.missing) {
    log(`  - ${name}${count > 1 ? ` (x${count})` : ''}`)
  }
  log(
    '\nIf that is deliberate — the feature went away, the case was a duplicate,' +
      '\nthe assertion was wrong — say so in the PR and apply the' +
      '\n`tests-removed-intentionally` label.' +
      '\n\nIf it is not, the usual cause is a branch opened before other PRs' +
      '\nlanded: merging `main` in replaces the file wholesale and takes the' +
      '\ncases added in between with it. Rebase, then keep both sides.',
  )
  return 1
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  process.exit(run(process.argv[2] ?? DEFAULT_BASE, process.argv[3] ?? 'HEAD'))
}
