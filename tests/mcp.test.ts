import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Registry } from 'prom-client';
import { BazaarMcpServer } from '../src/mcp/server';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('BazaarMcpServer', () => {
  it('should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Transaction signature expired. Signature expiration ledger 123 is less than current ledger 125'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_EXPIRED_AUTHORISATION');
  });

  it('should map missing trustline error to ERR_MISSING_TRUSTLINE', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('op_no_trust: The account does not have a trustline for this asset'));
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
  });

  it('should map 402 rejected error to ERR_PAYMENT_REJECTED', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => 'Payment Required'
    });
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBe(true);
    const content = JSON.parse(response.content[0].text);
    expect(content.code).toBe('ERR_PAYMENT_REJECTED');
  });
  
  it('should return successfully on a successful call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: "hello" })
    });
    
    const server = new BazaarMcpServer({ fetchWithPayment: mockFetch });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) {
        handler = fn;
      }
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'http://example.com/paid'
        }
      }
    });

    expect(response.isError).toBeFalsy();
    const parsedText = JSON.parse(response.content[0].text);
    expect(parsedText.success).toBe(true);
  });

  it('should refuse N calls under per-call limit once their sum exceeds the cumulative ceiling (#405)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => (h === 'x-payment-amount' ? '1.00' : null),
      },
      text: async () => JSON.stringify({ success: true, count: 1 }),
    });

    // Ceiling is $2.50, per-call limit is $1.00, each call costs $1.00
    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      maxPrice: 1.0,
      maxCumulativeSpend: 2.5,
      defaultCallCost: 1.0,
    });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    (server as any).setupHandlers();

    // Call 1 ($1.00 spent, total $1.00 <= $2.50)
    const res1 = await handler({
      params: { name: 'paid_call', arguments: { url: 'http://example.com/api', amount: 1.0 } },
    });
    expect(res1.isError).toBeFalsy();
    expect(server.getRunningTotal()).toBe(1.0);
    expect(server.getRemainingBudget()).toBe(1.5);

    // Call 2 ($1.00 spent, total $2.00 <= $2.50)
    const res2 = await handler({
      params: { name: 'paid_call', arguments: { url: 'http://example.com/api', amount: 1.0 } },
    });
    expect(res2.isError).toBeFalsy();
    expect(server.getRunningTotal()).toBe(2.0);
    expect(server.getRemainingBudget()).toBe(0.5);

    // Call 3 ($1.00 attempted, $2.00 + $1.00 = $3.00 > $2.50 ceiling) -> REFUSED!
    const res3 = await handler({
      params: { name: 'paid_call', arguments: { url: 'http://example.com/api', amount: 1.0 } },
    });
    expect(res3.isError).toBe(true);
    const content = JSON.parse(res3.content[0].text);
    expect(content.code).toBe('ERR_SPEND_LIMIT_EXCEEDED');
    expect(content.reason).toContain('Cumulative spend limit');
    expect(server.getRunningTotal()).toBe(2.0); // didn't increase
  });

  it('should make remaining budget discoverable in tool description and bazaar_spend_budget tool (#405)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true }),
    });

    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      maxPrice: 1.0,
      maxCumulativeSpend: 5.0,
      defaultCallCost: 1.0,
    });

    let listHandler: any = null;
    let callHandler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === ListToolsRequestSchema) listHandler = fn;
      if (schema === CallToolRequestSchema) callHandler = fn;
    };
    (server as any).setupHandlers();

    // Before call:
    const toolsBefore = await listHandler({});
    const paidToolBefore = toolsBefore.tools.find((t: any) => t.name === 'paid_call');
    expect(paidToolBefore.description).toContain('remaining budget: $5.00');

    // Make 1 call
    await callHandler({
      params: { name: 'paid_call', arguments: { url: 'http://example.com/api', amount: 1.0 } },
    });

    // Check listTools dynamic description after call
    const toolsAfter = await listHandler({});
    const paidToolAfter = toolsAfter.tools.find((t: any) => t.name === 'paid_call');
    expect(paidToolAfter.description).toContain('Current spent: $1.00');
    expect(paidToolAfter.description).toContain('remaining budget: $4.00');

    // Check bazaar_spend_budget tool response
    const budgetRes = await callHandler({
      params: { name: 'bazaar_spend_budget', arguments: {} },
    });
    const budgetData = JSON.parse(budgetRes.content[0].text);
    expect(budgetData.maxCumulativeSpend).toBe(5.0);
    expect(budgetData.totalSpent).toBe(1.0);
    expect(budgetData.remainingBudget).toBe(4.0);
  });

  it('should assert a failed payment is recorded as an attempt without secret material (#406)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: {
        get: () => null,
      },
      text: async () => 'Internal Server Error',
    });

    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      maxPrice: 1.0,
      maxCumulativeSpend: 5.0,
    });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    (server as any).setupHandlers();

    const response = await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'https://bazaar.stellar.org/api/fail',
        },
      },
    });

    expect(response.isError).toBe(true);
    const records = server.getSpendLedger().getRecords();
    expect(records.length).toBe(1);
    expect(records[0].outcome).toBe('failed');
    expect(records[0].url).toBe('https://bazaar.stellar.org/api/fail');
    expect(records[0].host).toBe('bazaar.stellar.org');
    expect(records[0].reason).toContain('500');

    // Assert zero secret material is recorded
    const recordString = JSON.stringify(records[0]);
    expect(recordString).not.toContain('secret');
    expect(recordString).not.toContain('envelope');
    expect(recordString).not.toContain('private');
    expect(recordString).not.toContain('signer');
  });

  it('should record transaction hash when present in payment-response or header (#406)', async () => {
    const mockTxHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef';
    const paymentResponseObj = {
      transaction: mockTxHash,
      network: 'stellar:pubnet',
      amount: '0.25',
    };
    const paymentResponseHeader = Buffer.from(JSON.stringify(paymentResponseObj)).toString('base64');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (header: string) => {
          if (header === 'payment-response') return paymentResponseHeader;
          return null;
        },
      },
      text: async () => JSON.stringify({ success: true }),
    });

    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      maxPrice: 1.0,
      maxCumulativeSpend: 5.0,
    });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    (server as any).setupHandlers();

    await handler({
      params: {
        name: 'paid_call',
        arguments: {
          url: 'https://bazaar.stellar.org/api/quote',
        },
      },
    });

    const records = server.getSpendLedger().getRecords();
    expect(records.length).toBe(1);
    expect(records[0].outcome).toBe('success');
    expect(records[0].transactionHash).toBe(mockTxHash);
    expect(records[0].amount).toBe(0.25);
    expect(records[0].network).toBe('stellar:pubnet');
  });

  it('should export spend metrics with bounded labels (#406)', async () => {
    const customRegistry = new Registry();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (h: string) => (h === 'x-payment-amount' ? '0.50' : null),
      },
      text: async () => JSON.stringify({ success: true }),
    });

    const server = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      metricsRegistry: customRegistry,
      allowedHosts: ['bazaar.stellar.org'],
    });

    let handler: any = null;
    (server as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler = fn;
    };
    (server as any).setupHandlers();

    // 1. Call to allowed host
    await handler({
      params: {
        name: 'paid_call',
        arguments: { url: 'https://bazaar.stellar.org/api/v1', amount: 0.5 },
      },
    });

    // 2. Call to unlisted/arbitrary host -> should map to 'other'
    await handler({
      params: {
        name: 'paid_call',
        arguments: { url: 'https://random-unlisted-domain.com/pay', amount: 0.5 },
      },
    });

    const metricsStr = await customRegistry.metrics();
    expect(metricsStr).toContain('mcp_payment_attempts_total');
    expect(metricsStr).toContain('mcp_spend_total');
    expect(metricsStr).toContain('host="bazaar.stellar.org"');
    expect(metricsStr).toContain('host="other"');
  });

  it('should persist and restore running total across restarts when spendLedgerPath is configured (#405)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-mcp-test-'));
    const ledgerFile = path.join(tempDir, 'ledger.jsonl');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true }),
    });

    // Session 1: make a call and record spend
    const server1 = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      maxPrice: 2.0,
      maxCumulativeSpend: 5.0,
      spendLedgerPath: ledgerFile,
      defaultCallCost: 1.5,
    });

    let handler1: any = null;
    (server1 as any).server.setRequestHandler = (schema: any, fn: any) => {
      if (schema === CallToolRequestSchema) handler1 = fn;
    };
    (server1 as any).setupHandlers();

    await handler1({
      params: { name: 'paid_call', arguments: { url: 'http://localhost/pay', amount: 1.5 } },
    });
    expect(server1.getRunningTotal()).toBe(1.5);

    // Session 2: new server instance pointing to the same ledgerFile
    const server2 = new BazaarMcpServer({
      fetchWithPayment: mockFetch,
      maxPrice: 2.0,
      maxCumulativeSpend: 5.0,
      spendLedgerPath: ledgerFile,
      defaultCallCost: 1.5,
    });

    // Running total must be restored from disk!
    expect(server2.getRunningTotal()).toBe(1.5);
    expect(server2.getRemainingBudget()).toBe(3.5);
    expect(server2.getSpendLedger().getRecords().length).toBe(1);

    // Clean up temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
