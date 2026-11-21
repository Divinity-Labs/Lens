import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  compareTestCases,
  countTestCases,
  extractTestCases,
} from '../scripts/dropped-tests.mjs'

const scriptPath = fileURLToPath(
  new URL('../scripts/check-dropped-tests.mjs', import.meta.url),
)

describe('extractTestCases', () => {
  it('extracts regular it() and test() declarations with either quote', () => {
    const source = [
      "it('adds two numbers', () => {})",
      'test("subtracts two numbers", () => {})',
    ].join('\n')

    expect(extractTestCases(source)).toEqual([
      'adds two numbers',
      'subtracts two numbers',
    ])
  })

  it('extracts one case per it.each/test.each declaration, not one per row', () => {
    const source = [
      'it.each([',
      "  ['a', 1],",
      "  ['b', 2],",
      "])('handles %s', (name, value) => {})",
      "test.each([1, 2, 3])('runs three times', () => {})",
    ].join('\n')

    expect(extractTestCases(source)).toEqual(['handles %s', 'runs three times'])
  })

  it('extracts parameterized declarations that put modifiers before each', () => {
    const source = [
      "it.skip.each([[1], [2]])('skipped rows', () => {})",
      "test.concurrent.each([1])('concurrent row', () => {})",
      "it.skipIf(process.env.CI)('conditionally skipped', () => {})",
    ].join('\n')

    expect(extractTestCases(source)).toEqual([
      'skipped rows',
      'concurrent row',
      'conditionally skipped',
    ])
  })

  it('extracts a declaration whose title sits on a later line', () => {
    const source = [
      'it(',
      "  'spans several lines',",
      '  () => {},',
      ')',
    ].join('\n')

    expect(extractTestCases(source)).toEqual(['spans several lines'])
  })

  it('extracts a title whose literal spans multiple lines in a template string', () => {
    const source = [
      'test(',
      '  `first line',
      'second line`,',
      '  () => {},',
      ')',
    ].join('\n')

    expect(extractTestCases(source)).toEqual(['first line\nsecond line'])
  })

  it('extracts a multi-line template-string title with interpolations', () => {
    const source = [
      'it(',
      '  `renders ${asset}',
      '   on its own line`,',
      '  () => {},',
      ')',
    ].join('\n')

    expect(extractTestCases(source)).toEqual(['renders ${}\n   on its own line'])
  })

  it('returns every copy of a duplicate title in the same file', () => {
    const source = [
      "it('same title', () => {})",
      "it('same title', () => {})",
    ].join('\n')

    expect(extractTestCases(source)).toEqual(['same title', 'same title'])
  })

  it('normalises ${} expressions in template titles so formatting is stable', () => {
    const source = [
      'it(`prices ${pair}`)',
      'it(`prices ${ pair }`)',
      'it(`prices ${pair.a} at ${price.toFixed(2)}`)',
    ].join('\n')

    expect(extractTestCases(source)).toEqual([
      'prices ${}',
      'prices ${}',
      'prices ${} at ${}',
    ])
  })

  it('counts cases inside describe blocks but not the describe titles', () => {
    const source = [
      "describe('outer group', () => {",
      "  it('inner case', () => {})",
      "  describe('nested group', () => {",
      "    test('deep case', () => {})",
      '  })',
      '})',
    ].join('\n')

    expect(extractTestCases(source)).toEqual(['inner case', 'deep case'])
  })

  it('extracts .skip, .only and .todo declarations', () => {
    const source = [
      "it.skip('skipped it', () => {})",
      "it.only('only it', () => {})",
      "it.todo('todo it')",
      "test.skip('skipped test', () => {})",
      "test.only('only test', () => {})",
      "test.todo('todo test')",
    ].join('\n')

    expect(extractTestCases(source)).toEqual([
      'skipped it',
      'only it',
      'todo it',
      'skipped test',
      'only test',
      'todo test',
    ])
  })

  it('ignores commented-out declarations in line and block comments', () => {
    const source = [
      "// it('line comment', () => {})",
      '/*',
      "it('block comment', () => {})",
      '*/',
      "it('real case', () => {}) // it('trailing comment', () => {})",
    ].join('\n')

    expect(extractTestCases(source)).toEqual(['real case'])
  })

  it('ignores it() text inside strings, templates and regex literals', () => {
    const source = [
      'const message = "it(\'in a string\', () => {})"',
      "const template = `it('in a template', () => {})`",
      "const pattern = /it\\('in a regex'\\)/",
      "it('real case', () => {})",
    ].join('\n')

    expect(extractTestCases(source)).toEqual(['real case'])
  })

  it('ignores method calls that are not test declarations', () => {
    const source = [
      "client.it('not a test')",
      "obj.test('also not a test')",
      "const test = 'it(' + 'x' + ')'",
    ].join('\n')

    expect(extractTestCases(source)).toEqual([])
  })
})

describe('compareTestCases', () => {
  it('reports nothing when every case is preserved', () => {
    expect(compareTestCases(['a', 'b'], ['b', 'a'])).toEqual({
      baseCount: 2,
      headCount: 2,
      missing: [],
      missingCount: 0,
    })
  })

  it('reports an added case as no loss', () => {
    const result = compareTestCases(['a'], ['a', 'new'])

    expect(result.missingCount).toBe(0)
    expect(result.headCount).toBe(2)
  })

  it('reports a removed case by name', () => {
    const result = compareTestCases(['kept', 'removed'], ['kept'])

    expect(result.missing).toEqual([{ name: 'removed', count: 1 }])
    expect(result.missingCount).toBe(1)
  })

  it('treats duplicate titles as separate cases', () => {
    const result = compareTestCases(['same', 'same'], ['same'])

    expect(result.missing).toEqual([{ name: 'same', count: 1 }])
    expect(result.missingCount).toBe(1)
  })

  it('counts how many copies of a duplicate title disappeared', () => {
    const result = compareTestCases(['same', 'same', 'same'], [])

    expect(result.missing).toEqual([{ name: 'same', count: 3 }])
  })

  it('counts titles per declaration', () => {
    const counts = countTestCases(['a', 'a', 'b'])

    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(1)
    expect(counts.get('c')).toBeUndefined()
  })
})

/**
 * Integration tests drive the real CLI against real, small git repositories.
 * Each scenario initialises a repo, commits a base, commits a divergent
 * feature branch, and asks the script what merging would drop.
 */
const repos: string[] = []

afterEach(() => {
  while (repos.length > 0) {
    const dir = repos.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dropped Tests',
      GIT_AUTHOR_EMAIL: 'dropped-tests@example.test',
      GIT_COMMITTER_NAME: 'Dropped Tests',
      GIT_COMMITTER_EMAIL: 'dropped-tests@example.test',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim()
}

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lens-dropped-tests-'))
  repos.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function writeTestFile(dir: string, path: string, content: string): void {
  const full = join(dir, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function commit(dir: string, message: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--no-gpg-sign', '-m', message)
}

function runGuard(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

describe('check-dropped-tests CLI against temporary repositories', () => {
  it('fails and names the case when one test case is removed', () => {
    const dir = createRepo()
    writeTestFile(
      dir,
      'tests/sample.test.ts',
      "it('kept case', () => {})\nit('removed case', () => {})\n",
    )
    commit(dir, 'base')

    git(dir, 'checkout', '-q', '-b', 'feature')
    writeTestFile(dir, 'tests/sample.test.ts', "it('kept case', () => {})\n")
    commit(dir, 'remove one case')

    const { status, output } = runGuard(dir, 'main', 'feature')

    expect(status).toBe(1)
    expect(output).toContain('1 test case(s)')
    expect(output).toContain('- removed case')
    expect(output).not.toContain('- kept case')
  })

  it('fails when a whole test file is removed', () => {
    const dir = createRepo()
    writeTestFile(
      dir,
      'tests/sample.test.ts',
      "it('first case', () => {})\nit('second case', () => {})\n",
    )
    commit(dir, 'base')

    git(dir, 'checkout', '-q', '-b', 'feature')
    git(dir, 'rm', '-q', 'tests/sample.test.ts')
    commit(dir, 'delete the test file')

    const { status, output } = runGuard(dir, 'main', 'feature')

    expect(status).toBe(1)
    expect(output).toContain('2 test case(s)')
    expect(output).toContain('- first case')
    expect(output).toContain('- second case')
  })

  it('passes when a test file is renamed and all its cases are kept', () => {
    const dir = createRepo()
    writeTestFile(
      dir,
      'tests/sample.test.ts',
      "it('moves with the file', () => {})\nit('also moves', () => {})\n",
    )
    commit(dir, 'base')

    git(dir, 'checkout', '-q', '-b', 'feature')
    mkdirSync(join(dir, 'tests/moved'), { recursive: true })
    git(dir, 'mv', 'tests/sample.test.ts', 'tests/moved/sample.test.ts')
    commit(dir, 'rename the test file')

    const { status, output } = runGuard(dir, 'main', 'feature')

    expect(status).toBe(0)
    expect(output).toContain('No test case present on the base is missing')
  })

  it('fails when one of two duplicate titles is removed', () => {
    const dir = createRepo()
    writeTestFile(
      dir,
      'tests/sample.test.ts',
      "it('duplicated title', () => {})\nit('duplicated title', () => {})\n",
    )
    commit(dir, 'base')

    git(dir, 'checkout', '-q', '-b', 'feature')
    writeTestFile(dir, 'tests/sample.test.ts', "it('duplicated title', () => {})\n")
    commit(dir, 'remove one duplicate')

    const { status, output } = runGuard(dir, 'main', 'feature')

    expect(status).toBe(1)
    expect(output).toContain('1 test case(s)')
    expect(output).toContain('- duplicated title')
  })

  it('passes on a clean merge that preserves every case from both sides', () => {
    const dir = createRepo()
    writeTestFile(dir, 'tests/base.test.ts', "it('base case', () => {})\n")
    commit(dir, 'base')

    git(dir, 'checkout', '-q', '-b', 'feature')
    writeTestFile(
      dir,
      'tests/feature.test.ts',
      "it('feature case', () => {})\nit('another feature case', () => {})\n",
    )
    commit(dir, 'add feature tests')

    git(dir, 'checkout', '-q', 'main')
    writeTestFile(
      dir,
      'tests/main.test.ts',
      "it('case added on main after the branch forked', () => {})\n",
    )
    commit(dir, 'add main tests')

    const { status, output } = runGuard(dir, 'main', 'feature')

    expect(status).toBe(0)
    expect(output).toContain('base main: 2 cases')
    expect(output).toContain('merging feature: 4 cases')
    expect(output).toContain('No test case present on the base is missing')
  })

  it('fails closed and says so when the merge conflicts', () => {
    const dir = createRepo()
    writeTestFile(dir, 'tests/sample.test.ts', "it('original case', () => {})\n")
    commit(dir, 'base')

    git(dir, 'checkout', '-q', '-b', 'feature')
    writeTestFile(dir, 'tests/sample.test.ts', "it('feature version', () => {})\n")
    commit(dir, 'change the case on the feature branch')

    git(dir, 'checkout', '-q', 'main')
    writeTestFile(dir, 'tests/sample.test.ts', "it('main version', () => {})\n")
    commit(dir, 'change the case on main')

    const { status, output } = runGuard(dir, 'main', 'feature')

    expect(status).toBe(1)
    expect(output).toMatch(/conflicts/)
    expect(output).not.toContain('No test case present on the base is missing')
  })
})
