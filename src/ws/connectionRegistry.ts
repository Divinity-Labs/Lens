import type { ApiKeyContext } from '../api/auth'

export interface WsClientSocket {
  readyState: number
  close(code?: number, reason?: string): void
  send(data: string, cb?: (err?: Error) => void): void
  apiKey?: ApiKeyContext
  [key: string]: any
}

export class WebSocketConnectionRegistry {
  private connections = new Map<string, Set<WsClientSocket>>()

  /**
   * Returns the maximum allowed concurrent WebSocket connections per API key.
   * Configurable via WS_MAX_CONNECTIONS_PER_KEY env var (default: 10).
   */
  getMaxConnectionsPerKey(): number {
    const raw = process.env.WS_MAX_CONNECTIONS_PER_KEY
    if (raw) {
      const parsed = parseInt(raw, 10)
      if (!isNaN(parsed) && parsed > 0) return parsed
    }
    return 10
  }

  /**
   * Returns the count of active connections currently held by this keyId.
   */
  getConnectionCount(keyId: string): number {
    return this.connections.get(keyId)?.size ?? 0
  }

  /**
   * Returns the set of active sockets for a keyId.
   */
  getConnections(keyId: string): Set<WsClientSocket> | undefined {
    return this.connections.get(keyId)
  }

  /**
   * Registers an open socket for the given keyId.
   */
  addConnection(keyId: string, socket: WsClientSocket): boolean {
    let set = this.connections.get(keyId)
    if (!set) {
      set = new Set()
      this.connections.set(keyId, set)
    }
    set.add(socket)
    return true
  }

  /**
   * Unregisters a socket upon close.
   */
  removeConnection(keyId: string, socket: WsClientSocket): boolean {
    const set = this.connections.get(keyId)
    if (!set) return false
    const removed = set.delete(socket)
    if (set.size === 0) {
      this.connections.delete(keyId)
    }
    return removed
  }

  /**
   * Closes all live connections for a given keyId.
   * Distinguishable close code 4401 with reason 'api_key_revoked'
   * so reconnect logic knows not to retry endlessly.
   */
  closeConnectionsForKey(keyId: string, code: number = 4401, reason: string = 'api_key_revoked'): number {
    const set = this.connections.get(keyId)
    if (!set || set.size === 0) return 0
    let count = 0
    for (const socket of Array.from(set)) {
      try {
        socket.close(code, reason)
        count++
      } catch {
        // Socket may already be closing or closed
      }
    }
    this.connections.delete(keyId)
    return count
  }

  clear(): void {
    this.connections.clear()
  }
}

export const wsConnectionRegistry = new WebSocketConnectionRegistry()
