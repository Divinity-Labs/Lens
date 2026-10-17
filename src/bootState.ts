/**
 * Application Lifecycle & Boot Readiness State (#334)
 *
 * Tracks whether initialization (migrations, connections, and worker scheduling)
 * has completed, allowing /ready to report 503 during startup and 200 once ready.
 */

let bootCompleted = false

export function setBootComplete(completed = true): void {
  bootCompleted = completed
}

export function isBootCompleted(): boolean {
  return bootCompleted
}

export function resetBootStateForTesting(): void {
  bootCompleted = false
}
