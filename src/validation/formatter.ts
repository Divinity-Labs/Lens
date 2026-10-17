import type { ZodError } from 'zod'

export interface FormattedValidationError {
  error: string
  code: string
  field?: string
  expected?: string
  details: Array<{
    field: string
    message: string
  }>
}

/**
 * Universal formatter for Zod validation errors across all Lens routes (#269).
 *
 * Produces a consistent, machine-readable error response that explicitly names
 * the offending parameter and what value/type was expected.
 */
export function formatZodError(zodError: ZodError): FormattedValidationError {
  const issues = zodError.issues
  const first = issues[0]
  const fieldName = first?.path?.join('.') || 'parameter'
  const message = first?.message || 'Invalid value'

  return {
    error: `Invalid parameter "${fieldName}": ${message}`,
    code: 'INVALID_PARAMETERS',
    field: fieldName,
    details: issues.map(issue => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
  }
}
