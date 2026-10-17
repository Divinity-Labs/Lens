type LogFields = Record<string, string | number | boolean | null | undefined>

/** Emit one JSON log event so operators can filter and aggregate field values. */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: LogFields = {},
): void {
  const record = JSON.stringify({ level, message, ...fields })
  if (level === 'error') console.error(record)
  else if (level === 'warn') console.warn(record)
  else console.log(record)
}
