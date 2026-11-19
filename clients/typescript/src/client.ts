import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema.js";

export type { paths } from "./schema.js";

export type LensClient = Client<paths>;

export type LensClientOptions = Omit<ClientOptions, "baseUrl" | "fetch"> & {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** API key sent as `Authorization: Bearer <key>` on every request. */
  apiKey?: string;
  /** x402 payment token sent in the `X-PAYMENT` header on every request. */
  payment?: string;
  /** Default network appended as `?network=` when a call does not set one. */
  network?: string;
};

export const DEFAULT_BASE_URL = "http://localhost:3002";

/**
 * Create a typed Lens API client.
 *
 * ```ts
 * const client = createLensClient({
 *   baseUrl: "https://lens.example.com",
 *   apiKey: "lns_abc123",       // -> Authorization: Bearer lns_abc123
 *   payment: "ey...",           // -> X-PAYMENT: ey...
 *   network: "mainnet",         // -> ?network=mainnet (unless call overrides)
 * });
 * ```
 *
 * Explicit headers passed per-call always win over `apiKey` / `payment`.
 */
export function createLensClient(
  options: LensClientOptions = {},
): LensClient {
  const { apiKey, payment, network, headers: _callerHeaders, ...rest } = options;

  const defaultHeaders: Record<string, string> = {};
  if (apiKey) defaultHeaders["Authorization"] = `Bearer ${apiKey}`;
  if (payment) defaultHeaders["X-PAYMENT"] = payment;
  // Caller-supplied static headers take precedence over derived ones
  if (_callerHeaders && typeof _callerHeaders === "object" && !Array.isArray(_callerHeaders)) {
    Object.assign(defaultHeaders, _callerHeaders as Record<string, string>);
  }

  const underlyingFetch = rest.fetch ?? globalThis.fetch;

  const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
    let urlStr: string;
    if (typeof input === "string") {
      urlStr = input;
    } else if (input instanceof URL) {
      urlStr = input.href;
    } else {
      urlStr = (input as Request).url;
    }

    const url = new URL(urlStr.startsWith("http") ? urlStr : `${options.baseUrl ?? DEFAULT_BASE_URL}${urlStr}`);
    if (network && !url.searchParams.has("network")) {
      url.searchParams.set("network", network);
    }

    const mergedInit: RequestInit = { ...(init ?? {}) };
    const headers = new Headers(mergedInit.headers ?? {});
    for (const [k, v] of Object.entries(defaultHeaders)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    mergedInit.headers = headers;

    return underlyingFetch(url.href, mergedInit);
  };

  return createClient<paths>({
    ...rest,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    fetch: wrappedFetch,
  });
}
