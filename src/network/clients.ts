/**
 * Per-network Horizon / Soroban RPC client factories.
 *
 * Every ingester and aggregator that talks to a Stellar network needs a
 * Horizon.Server or SorobanRpc.Server bound to that network's endpoints.
 * Previously these were created once as module-level singletons bound to
 * whatever network was active at import time, which made it impossible to
 * run ingesters against more than one network in the same process.
 *
 * getHorizonServer(network) / getRpcServer(network) return a client cached
 * per network so repeated calls for the same network reuse one instance,
 * while different networks always resolve to distinct clients.
 */

import { Horizon, rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { getNetworkConfig, type NetworkName } from '../config'

const horizonClients = new Map<NetworkName, Horizon.Server>()
const rpcClients = new Map<NetworkName, SorobanRpc.Server>()

export function getHorizonServer(network: NetworkName): Horizon.Server {
  let client = horizonClients.get(network)
  if (!client) {
    client = new Horizon.Server(getNetworkConfig(network).horizon.url)
    horizonClients.set(network, client)
  }
  return client
}

export function getRpcServer(network: NetworkName): SorobanRpc.Server {
  let client = rpcClients.get(network)
  if (!client) {
    client = new SorobanRpc.Server(getNetworkConfig(network).rpc.url, { allowHttp: true })
    rpcClients.set(network, client)
  }
  return client
}

/**
 * Test-only: drops the memoised clients so a test can rebind the mocked
 * Horizon/RPC constructors between cases. Production code never calls this —
 * clearing the cache mid-run would silently open new connections.
 */
export function resetNetworkClients(): void {
  horizonClients.clear()
  rpcClients.clear()
}
