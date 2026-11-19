/**
 * Unit tests for the TypeScript Lens client.
 * Uses a fake `fetch` to verify URL construction, auth headers, and error handling.
 */
import { describe, it, expect, vi } from "vitest";
import { createLensClient, DEFAULT_BASE_URL } from "../clients/typescript/src/client.js";

function fakeFetch(response: { status: number; body?: unknown }) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

describe("createLensClient", () => {
  it("builds a URL with path parameters", async () => {
    const ff = fakeFetch({ status: 200, body: { price: "0.12", bestRoute: "soroswap" } });
    const client = createLensClient({ fetch: ff });
    await client.GET("/v1/price/{assetA}/{assetB}", {
      params: { path: { assetA: "XLM", assetB: "USDC" } },
    });
    expect(ff).toHaveBeenCalledOnce();
    const calledUrl = ff.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v1/price/XLM/USDC");
  });

  it("defaults baseUrl to localhost:3002", async () => {
    const ff = fakeFetch({ status: 200, body: {} });
    const client = createLensClient({ fetch: ff });
    await client.GET("/v1/status");
    const calledUrl = ff.mock.calls[0][0] as string;
    expect(calledUrl).toStartWith?.(DEFAULT_BASE_URL) ?? expect(calledUrl.startsWith(DEFAULT_BASE_URL)).toBe(true);
  });

  it("sends Authorization header when apiKey is set", async () => {
    const ff = fakeFetch({ status: 200, body: {} });
    const client = createLensClient({ fetch: ff, apiKey: "lns_test_key" });
    await client.GET("/v1/status");
    const init = ff.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer lns_test_key");
  });

  it("sends X-PAYMENT header when payment is set", async () => {
    const ff = fakeFetch({ status: 200, body: {} });
    const client = createLensClient({ fetch: ff, payment: "ey_token_abc" });
    await client.GET("/v1/status");
    const init = ff.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("X-PAYMENT")).toBe("ey_token_abc");
  });

  it("explicit per-call header wins over apiKey", async () => {
    const ff = fakeFetch({ status: 200, body: {} });
    const client = createLensClient({ fetch: ff, apiKey: "lns_default" });
    await client.GET("/v1/status", {
      headers: { Authorization: "Bearer lns_override" },
    });
    const init = ff.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer lns_override");
  });

  it("appends ?network= when network option is set and call does not provide one", async () => {
    const ff = fakeFetch({ status: 200, body: {} });
    const client = createLensClient({ fetch: ff, network: "mainnet" });
    await client.GET("/v1/status");
    const calledUrl = ff.mock.calls[0][0] as string;
    expect(calledUrl).toContain("network=mainnet");
  });

  it("does not duplicate network param when call already sets one", async () => {
    const ff = fakeFetch({ status: 200, body: {} });
    const client = createLensClient({ fetch: ff, network: "mainnet" });
    await client.GET("/v1/prices/history", {
      params: { query: { pair: "XLM/USDC", interval: "1h", network: "testnet" } },
    });
    const calledUrl = ff.mock.calls[0][0] as string;
    expect(calledUrl).toContain("network=testnet");
    expect(calledUrl.match(/network=/g)?.length).toBe(1);
  });

  it("returns error object instead of throwing on non-2xx", async () => {
    const ff = fakeFetch({ status: 401, body: { message: "Unauthorized" } });
    const client = createLensClient({ fetch: ff });
    const result = await client.GET("/v1/status");
    expect(result.error).toBeDefined();
    expect(result.data).toBeUndefined();
  });
});
