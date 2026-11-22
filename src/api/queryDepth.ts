import {
  GraphQLError,
  Kind,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationRule,
} from 'graphql'

/** The deepest application selection in the current schema is three fields. */
export const DEFAULT_MAX_GRAPHQL_QUERY_DEPTH = 3

/** Reads the GraphQL selection-depth ceiling at server registration time. */
export function getMaxGraphQLQueryDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GRAPHQL_MAX_QUERY_DEPTH
  if (raw === undefined) return DEFAULT_MAX_GRAPHQL_QUERY_DEPTH

  // A bad value is a startup error: treating it as "no limit" would turn a
  // deployment typo into a security regression.
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('GRAPHQL_MAX_QUERY_DEPTH must be a positive integer.')
  }

  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error('GRAPHQL_MAX_QUERY_DEPTH must be a positive integer.')
  }
  return value
}

function selectedOperation(document: DocumentNode, operationName?: string | null): OperationDefinitionNode | undefined {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  )

  if (operationName) return operations.find(operation => operation.name?.value === operationName)
  return operations.length === 1 ? operations[0] : undefined
}

/**
 * Returns the greatest number of field selections along any application-field
 * path. Fragment nodes themselves do not add depth; their selected fields do.
 * A fragment currently being expanded is not expanded again, so normal
 * GraphQL fragment-cycle validation reports cycles without this traversal
 * recursing forever.
 */
function selectionDepth(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  depth: number,
  expandingFragments: ReadonlySet<string>,
): number {
  let maximum = depth

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      // Full-schema introspection is exempt only at the operation root. A
      // mixed operation still has its application branch measured.
      if (depth === 0 && (selection.name.value === '__schema' || selection.name.value === '__type')) continue

      const fieldDepth = depth + 1
      maximum = Math.max(maximum, fieldDepth)
      if (selection.selectionSet) {
        maximum = Math.max(
          maximum,
          selectionDepth(selection.selectionSet, fragments, fieldDepth, expandingFragments),
        )
      }
      continue
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      maximum = Math.max(maximum, selectionDepth(selection.selectionSet, fragments, depth, expandingFragments))
      continue
    }

    const fragment = fragments.get(selection.name.value)
    if (fragment && !expandingFragments.has(fragment.name.value)) {
      const nextExpandingFragments = new Set(expandingFragments)
      nextExpandingFragments.add(fragment.name.value)
      maximum = Math.max(maximum, selectionDepth(fragment.selectionSet, fragments, depth, nextExpandingFragments))
    }
  }

  return maximum
}

/**
 * Root fields that fan out into several network and database reads each:
 * `depth` reads every AMM pool snapshot plus a fee lookup per pool, `impact`
 * reads the same reserves, and `book` reads the Horizon order book and the
 * pool snapshots. They are the only queries whose cost grows with the number
 * of times a document names them.
 */
export const COSTLY_ROOT_FIELDS = ['depth', 'impact', 'book'] as const

/**
 * How many costly root field selections one document may contain.
 *
 * The depth limit alone does not bound these: aliases let one document name the
 * same field many times (`a: book(...) b: book(...)`) without adding depth, so a
 * single request could otherwise trigger hundreds of Horizon and Postgres
 * round-trips. Five leaves room to compare several arguments in one round-trip
 * while keeping the worst case bounded.
 */
export const MAX_COSTLY_ROOT_FIELDS = 5

function countRootFields(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  counts: Map<string, number>,
  expandingFragments: ReadonlySet<string>,
): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      // Every Field node counts, aliased or not: an alias is a separate
      // execution of the resolver, which is exactly what this bound is for.
      counts.set(selection.name.value, (counts.get(selection.name.value) ?? 0) + 1)
      continue
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      countRootFields(selection.selectionSet, fragments, counts, expandingFragments)
      continue
    }

    const fragment = fragments.get(selection.name.value)
    if (fragment && !expandingFragments.has(fragment.name.value)) {
      const nextExpandingFragments = new Set(expandingFragments)
      nextExpandingFragments.add(fragment.name.value)
      countRootFields(fragment.selectionSet, fragments, counts, nextExpandingFragments)
    }
  }
}

/** Total selections of the costly root fields in the requested operation. */
export function costlyRootFieldCount(document: DocumentNode, operationName?: string | null): number {
  const operation = selectedOperation(document, operationName)
  if (!operation) return 0

  const fragments = new Map(
    document.definitions
      .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map(fragment => [fragment.name.value, fragment]),
  )
  const counts = new Map<string, number>()
  countRootFields(operation.selectionSet, fragments, counts, new Set())

  let total = 0
  for (const [name, count] of counts) {
    if ((COSTLY_ROOT_FIELDS as readonly string[]).includes(name)) total += count
  }
  return total
}

/**
 * Caps how many costly root field selections one document may make, counting
 * aliases and fields reached through fragments. Rejected before any resolver
 * runs, so a request cannot multiply the cost of a single query with aliases.
 */
export function costlyRootFieldValidationRules(operationName?: string | null): ValidationRule[] {
  return [context => ({
    Document(node) {
      // Missing or ambiguous operation names are reported by the specified
      // GraphQL rules with a more precise message.
      if (!selectedOperation(node, operationName)) return false

      const requested = costlyRootFieldCount(node, operationName)
      if (requested > MAX_COSTLY_ROOT_FIELDS) {
        context.reportError(new GraphQLError(
          `Query selects ${requested} expensive trade-cost fields (${COSTLY_ROOT_FIELDS.join(', ')}), ` +
          `which exceeds the maximum of ${MAX_COSTLY_ROOT_FIELDS} per request. Split it into several requests.`,
          { nodes: [selectedOperation(node, operationName)!] },
        ))
      }
      return false
    },
  })]
}

/**
 * Creates Mercurius-compatible validation rules for the requested operation.
 *
 * Depth is the maximum count of field selections from an operation root to a
 * leaf. Aliases, inline fragments, and fragment spreads do not count on their
 * own. A pure __schema or __type operation is exempt so GraphiQL's standard
 * introspection query keeps working; an operation with application selections
 * still measures those selections and cannot use introspection as a bypass.
 */
export function queryDepthValidationRules(
  maximumDepth: number,
  operationName?: string | null,
): ValidationRule[] {
  return [context => ({
    Document(node) {
      const operation = selectedOperation(node, operationName)
      // The specified GraphQL rules give a more precise error for missing or
      // ambiguous operation names and malformed documents.
      if (!operation) return false

      const fragments = new Map(
        node.definitions
          .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
          .map(fragment => [fragment.name.value, fragment]),
      )
      const requestedDepth = selectionDepth(operation.selectionSet, fragments, 0, new Set())
      if (requestedDepth > maximumDepth) {
        context.reportError(new GraphQLError(
          `Query depth ${requestedDepth} exceeds the maximum allowed depth of ${maximumDepth}.`,
          { nodes: [operation] },
        ))
      }
      return false
    },
  })]
}
