/**
 * Exact decimal arithmetic for exchange quotes (#644).
 *
 * Exchanges send prices as decimal strings ("0.1234"). Taking a mid or
 * inverting a quote in floating point works on a binary approximation of that
 * string, so the result is off before it ever reaches the `Decimal(36, 18)`
 * price column. These helpers keep the value as an exact ratio of two bigints
 * and round once, half-up, at the column's scale when the result is written
 * out as a decimal string.
 */

import { PRICE_DECIMAL_PLACES } from '../../pricing/precision'

/** A non-negative rational number `num / den`, with `den > 0`. */
export interface ExactDecimal {
  readonly num: bigint
  readonly den: bigint
}

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/

/**
 * Parse a plain non-negative decimal string ("12", "0.098"). Anything else —
 * a sign, an exponent, whitespace inside, an empty string — returns null, so a
 * malformed exchange field is treated as missing rather than guessed at.
 */
export function parseDecimal(text: string | null | undefined): ExactDecimal | null {
  if (typeof text !== 'string') return null
  const match = PLAIN_DECIMAL.exec(text.trim())
  if (!match) return null
  const fraction = match[2] ?? ''
  return { num: BigInt(match[1] + fraction), den: 10n ** BigInt(fraction.length) }
}

export function isPositive(value: ExactDecimal): boolean {
  return value.num > 0n
}

/** `(a + b) / 2`, exactly. */
export function midpoint(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return { num: a.num * b.den + b.num * a.den, den: 2n * a.den * b.den }
}

/** `1 / value`, exactly. Null for zero, which has no inverse. */
export function invert(value: ExactDecimal): ExactDecimal | null {
  if (value.num === 0n) return null
  return { num: value.den, den: value.num }
}

/**
 * Write `value` as a plain decimal string rounded half-up to `places`
 * fractional digits (the price column's 18 by default), without trailing
 * zeros: 1/3 -> "0.333333333333333333", 1/8 -> "0.125", 2 -> "2".
 */
export function toDecimalString(value: ExactDecimal, places: number = PRICE_DECIMAL_PLACES): string {
  const scale = 10n ** BigInt(places)
  const scaled = (2n * value.num * scale + value.den) / (2n * value.den)
  if (places === 0) return scaled.toString()
  const digits = scaled.toString().padStart(places + 1, '0')
  const whole = digits.slice(0, digits.length - places)
  const fraction = digits.slice(digits.length - places).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
