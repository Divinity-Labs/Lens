/**
 * Serialization precision standards for Lens prices and volumes.
 *
 * Background (Issue #230):
 * PostgreSQL schema (`prisma/schema.prisma`) declares:
 * - Prices: `Decimal(36, 18)` (18 decimal places of fractional precision)
 * - Volumes: `Decimal(36, 7)` (7 decimal places of fractional precision, matching Stellar stroops)
 *
 * Intermediate aggregations (SUM, AVG, MIN, MAX, array_agg) are computed in PostgreSQL
 * using exact arbitrary-precision `numeric` arithmetic rather than IEEE-754 `float8`.
 * This prevents order-dependent floating-point accumulation errors and precision loss
 * on small fractions (such as 1e-7 prices or multi-venue volume totals).
 *
 * At the serialization edge, values are cast once to JavaScript numbers with explicit,
 * documented precision:
 * - Price precision: up to 18 decimal places (`PRICE_DECIMAL_PLACES = 18`).
 * - Volume precision: up to 7 decimal places (`VOLUME_DECIMAL_PLACES = 7`).
 */

export const PRICE_DECIMAL_PLACES = 18
export const VOLUME_DECIMAL_PLACES = 7

/**
 * Format and cast a price value at the serialization edge with explicit precision.
 * Preserves exact decimal digits (up to 18 decimal places) while stripping floating-point
 * representation artifacts. Returns `null` if the input is `null` or `undefined`.
 */
export function formatPrice(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return null
  return Number(num.toFixed(PRICE_DECIMAL_PLACES))
}

/**
 * Format and cast a volume value at the serialization edge with explicit precision.
 * Denominated in Stellar stroops (7 decimal places). Returns `0` if null or undefined.
 */
export function formatVolume(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return 0
  return Number(num.toFixed(VOLUME_DECIMAL_PLACES))
}
