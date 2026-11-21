/**
 * Pure extraction and comparison logic used by check-dropped-tests.mjs.
 *
 * Kept separate from the CLI so the parts can be tested directly: extracting
 * case titles from file text, and comparing two sets of titles. The CLI keeps
 * the shebang, the git work and the exit codes.
 */

/** Functions that declare a test case. `describe` is deliberately absent. */
const TEST_DECLARATIONS = new Set(['it', 'test', 'fit', 'ftest', 'xit', 'xtest'])

/** After these words a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
])

function isIdentStart(c) {
  return typeof c === 'string' && /[A-Za-z_$]/.test(c)
}

function isIdentPart(c) {
  return typeof c === 'string' && /[A-Za-z0-9_$]/.test(c)
}

function skipSpace(source, i) {
  let j = i
  while (j < source.length && /\s/.test(source[j])) j++
  return j
}

/** Index just past the closing quote, or at the newline for an unterminated string. */
function skipQuoted(source, i) {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    const c = source[j]
    if (c === '\\') { j += 2; continue }
    if (c === quote) return j + 1
    if (c === '\n' || c === '\r') return j
    j++
  }
  return j
}

/** Index just past the interpolation body (the `}` matching an opened `${`). */
function skipInterpolation(source, i) {
  let depth = 1
  let j = i
  while (j < source.length) {
    const c = source[j]
    if (c === "'" || c === '"') { j = skipQuoted(source, j); continue }
    if (c === '`') { j = skipTemplate(source, j); continue }
    if (c === '{') { depth++; j++; continue }
    if (c === '}') {
      depth--
      j++
      if (depth === 0) return j
      continue
    }
    j++
  }
  return j
}

/** Index just past the closing backtick (handles `${...}` and nesting). */
function skipTemplate(source, i) {
  let j = i + 1
  while (j < source.length) {
    const c = source[j]
    if (c === '\\') { j += 2; continue }
    if (c === '`') return j + 1
    if (c === '$' && source[j + 1] === '{') { j = skipInterpolation(source, j + 2); continue }
    j++
  }
  return j
}

/** Index just past a `/.../flags` literal, or `i` if this `/` is a division. */
function skipRegex(source, i) {
  let j = i + 1
  let inClass = false
  while (j < source.length) {
    const c = source[j]
    if (c === '\\') { j += 2; continue }
    if (c === '\n' || c === '\r') return i
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) {
      j++
      while (j < source.length && isIdentPart(source[j])) j++
      return j
    }
    j++
  }
  return i
}

/**
 * Replace comments with spaces, preserving offsets and newlines, without
 * touching comment-like text inside strings, template literals or regexes.
 * Extraction runs on this text, so a commented-out `it(` is invisible.
 */
export function stripComments(source) {
  let out = ''
  let i = 0
  let canStartRegex = true
  while (i < source.length) {
    const c = source[i]

    if (c === '/' && source[i + 1] === '/') {
      let j = i
      while (j < source.length && source[j] !== '\n') j++
      out += ' '.repeat(j - i)
      i = j
      continue
    }

    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      const end = close === -1 ? source.length : close + 2
      out += source.slice(i, end).replace(/[^\r\n]/g, ' ')
      i = end
      continue
    }

    if (c === "'" || c === '"') {
      const end = skipQuoted(source, i)
      out += source.slice(i, end)
      i = end
      canStartRegex = false
      continue
    }

    if (c === '`') {
      const end = skipTemplate(source, i)
      out += source.slice(i, end)
      i = end
      canStartRegex = false
      continue
    }

    if (c === '/' && canStartRegex) {
      const end = skipRegex(source, i)
      if (end > i + 1) {
        out += source.slice(i, end)
        i = end
        canStartRegex = false
        continue
      }
    }

    if (isIdentStart(c)) {
      let j = i + 1
      while (j < source.length && isIdentPart(source[j])) j++
      const word = source.slice(i, j)
      out += word
      i = j
      canStartRegex = REGEX_AFTER_WORDS.has(word)
      continue
    }

    if (/\d/.test(c)) {
      let j = i + 1
      while (j < source.length && /[0-9A-Za-z_.]/.test(source[j])) j++
      out += source.slice(i, j)
      i = j
      canStartRegex = false
      continue
    }

    out += c
    if (!/\s/.test(c)) canStartRegex = /[([{,;:=!&|?+\-*%<>~^]/.test(c)
    i++
  }
  return out
}

/** Index just past the `)` matching the `(` at `i`, skipping strings/templates. */
function skipBalanced(source, i) {
  let depth = 0
  let j = i
  while (j < source.length) {
    const c = source[j]
    if (c === "'" || c === '"') { j = skipQuoted(source, j); continue }
    if (c === '`') { j = skipTemplate(source, j); continue }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return j + 1
    }
    j++
  }
  return j
}

/**
 * Read a title literal starting at `i`. Returns `{ name, end }` or null.
 * Template interpolations become `${}` so reformatting a `${expr}` does not
 * look like a renamed case.
 */
function readTitle(source, i) {
  const quote = source[i]
  if (quote === "'" || quote === '"') {
    let j = i + 1
    let name = ''
    while (j < source.length) {
      const c = source[j]
      if (c === '\\') { name += source.slice(j, j + 2); j += 2; continue }
      if (c === quote) return { name, end: j + 1 }
      if (c === '\n' || c === '\r') return null
      name += c
      j++
    }
    return null
  }
  if (quote === '`') {
    let j = i + 1
    let name = ''
    while (j < source.length) {
      const c = source[j]
      if (c === '\\') { name += source.slice(j, j + 2); j += 2; continue }
      if (c === '`') return { name, end: j + 1 }
      if (c === '$' && source[j + 1] === '{') {
        name += '${}'
        j = skipInterpolation(source, j + 2)
        continue
      }
      name += c
      j++
    }
    return null
  }
  return null
}

/**
 * Parse `it`/`test` plus its modifier chain at `i` (just past the identifier).
 * The first call whose first argument is a string/template literal is the
 * declaration: `it('x')` and `it.todo('x')` hit immediately, while
 * `it.each([...])('x')` and `it.skipIf(cond)('x')` skip their setup call first.
 */
function parseDeclaration(source, i) {
  let j = skipSpace(source, i)
  while (source[j] === '.') {
    j++
    while (j < source.length && isIdentPart(source[j])) j++
    j = skipSpace(source, j)
    // Tagged-template modifier such as test.each`...` — not a title, skip it.
    if (source[j] === '`') { j = skipSpace(source, skipTemplate(source, j)); }
  }

  if (source[j] !== '(') return null
  const firstArgument = skipSpace(source, j + 1)
  const title = readTitle(source, firstArgument)
  if (title) return title

  // The first call was setup (`.each([...])`, `.skipIf(cond)`)); the title is
  // in the call that follows it.
  const afterSetup = skipSpace(source, skipBalanced(source, j))
  if (source[afterSetup] !== '(') return null
  return readTitle(source, skipSpace(source, afterSetup + 1))
}

/**
 * Every test-case title declared in `source`, in source order, duplicates
 * included. Describes are containers, not cases, so they are not returned;
 * the cases inside them are found by the same scan.
 */
export function extractTestCases(source) {
  const code = stripComments(source)
  const names = []
  let i = 0
  let canStartRegex = true
  while (i < code.length) {
    const c = code[i]

    if (c === "'" || c === '"') {
      i = skipQuoted(code, i)
      canStartRegex = false
      continue
    }

    if (c === '`') {
      i = skipTemplate(code, i)
      canStartRegex = false
      continue
    }

    // A regex literal may contain `it('...')` text; it is not a declaration.
    if (c === '/' && canStartRegex) {
      const end = skipRegex(code, i)
      if (end > i + 1) {
        i = end
        canStartRegex = false
        continue
      }
    }

    if (!isIdentStart(c)) {
      if (!/\s/.test(c)) canStartRegex = /[([{,;:=!&|?+\-*%<>~^]/.test(c)
      i++
      continue
    }

    let j = i + 1
    while (j < code.length && isIdentPart(code[j])) j++
    const word = code.slice(i, j)
    const previous = i === 0 ? '' : code[i - 1]

    if (TEST_DECLARATIONS.has(word) && previous !== '.') {
      const title = parseDeclaration(code, j)
      if (title) {
        names.push(title.name)
        i = title.end
        canStartRegex = false
        continue
      }
    }
    i = j
    canStartRegex = REGEX_AFTER_WORDS.has(word)
  }
  return names
}

/** Map of title -> number of declarations across the given titles. */
export function countTestCases(names) {
  const counts = new Map()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return counts
}

/**
 * Cases present on the base more times than in the merge result.
 * Returns `{ baseCount, headCount, missing, missingCount }` where `missing`
 * is `[{ name, count }]` for the number of lost occurrences of each title.
 */
export function compareTestCases(baseNames, headNames) {
  const base = countTestCases(baseNames)
  const head = countTestCases(headNames)
  const missing = []
  for (const [name, count] of base) {
    const kept = head.get(name) ?? 0
    if (kept < count) missing.push({ name, count: count - kept })
  }
  return {
    baseCount: baseNames.length,
    headCount: headNames.length,
    missing,
    missingCount: missing.reduce((total, entry) => total + entry.count, 0),
  }
}
