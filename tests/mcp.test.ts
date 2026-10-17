import { describe, it, expect, vi } from 'vitest';
import { BazaarMcpServer } from '../src/mcp/server';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('BazaarMcpServer', () => {
  describe('baseline paid_call error tests', () => {
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
  });

  describe('Structure-first error classification (Issue #410)', () => {
    it('should classify Horizon op_no_trust by result_codes structure without relying on message text', async () => {
      const horizonError = {
        message: 'A customized failure happened on submission', // completely reworded, no "trustline" word
        response: {
          status: 400,
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_failed',
                operations: ['op_no_trust']
              }
            }
          }
        }
      };

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn().mockRejectedValue(horizonError) });
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'paid_call', arguments: { url: 'https://bazaar.org/pay' } }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_MISSING_TRUSTLINE');
      expect(content.reason).toBe('Missing trustline for the required asset.');
    });

    it('should classify Horizon op_underfunded and tx_insufficient_balance by result_codes structure', async () => {
      const underfundedError = {
        message: 'Balance error',
        resultCodes: {
          transaction: 'tx_failed',
          operations: ['op_underfunded']
        }
      };

      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn().mockRejectedValue(underfundedError) });
      let handler: any = null;
      (server as any).server.setRequestHandler = (schema: any, fn: any) => {
        if (schema === CallToolRequestSchema) handler = fn;
      };
      (server as any).setupHandlers();

      const response = await handler({
        params: { name: 'paid_call', arguments: { url: 'https://bazaar.org/pay' } }
      });

      expect(response.isError).toBe(true);
      const content = JSON.parse(response.content[0].text);
      expect(content.code).toBe('ERR_INSUFFICIENT_BALANCE');
      expect(content.reason).toBe('Insufficient balance to complete the payment.');

      // Also test transaction level code
      const txFeeError = {
        message: 'Fee error',
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_insufficient_fee',
              operations: []
            }
          }
        }
      };

      const feeRes = (server as any).classifyPaidCallError(txFeeError);
      expect(feeRes.code).toBe('ERR_INSUFFICIENT_BALANCE');
    });

    it('should classify Horizon tx_bad_auth and tx_too_late by structure', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const badAuthError = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: 'tx_bad_auth'
              }
            }
          }
        }
      };

      const res = (server as any).classifyPaidCallError(badAuthError);
      expect(res.code).toBe('ERR_EXPIRED_AUTHORISATION');

      const tooLateError = {
        resultCodes: {
          transaction: 'tx_too_late'
        }
      };
      const tooLateRes = (server as any).classifyPaidCallError(tooLateError);
      expect(tooLateRes.code).toBe('ERR_EXPIRED_AUTHORISATION');
    });

    it('should classify explicit signature expiration fields on the error object', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });
      const expirationObj = {
        signatureExpirationLedger: 500,
        currentLedger: 505,
        message: 'Ledger limit exceeded' // no "expired" word
      };

      const res = (server as any).classifyPaidCallError(expirationObj);
      expect(res.code).toBe('ERR_EXPIRED_AUTHORISATION');
      expect(res.reason).toContain('signature expired');
    });

    it('should classify x402 HTTP status codes directly without inspecting message text', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

      // HTTP 402
      const err402 = { status: 402, message: 'Unspecified challenge failure' };
      expect((server as any).classifyPaidCallError(err402).code).toBe('ERR_PAYMENT_REJECTED');

      // HTTP 401
      const err401 = { statusCode: 401, message: 'Bad bearer token' };
      expect((server as any).classifyPaidCallError(err401).code).toBe('ERR_EXPIRED_AUTHORISATION');

      // HTTP 503
      const err503 = { response: { status: 503 }, message: 'Server temporarily overloaded' };
      expect((server as any).classifyPaidCallError(err503).code).toBe('ERR_SERVICE_UNREACHABLE');

      // HTTP 400
      const err400 = { status: 400, message: 'Bad request headers' };
      expect((server as any).classifyPaidCallError(err400).code).toBe('ERR_BAD_REQUEST');
    });

    it('should classify socket and network error codes directly without false positive string matches', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

      const econnError = { code: 'ECONNREFUSED', message: 'Connection refused' };
      expect((server as any).classifyPaidCallError(econnError).code).toBe('ERR_SERVICE_UNREACHABLE');

      const dnsError = { cause: { code: 'ENOTFOUND' }, message: 'Address not found' };
      expect((server as any).classifyPaidCallError(dnsError).code).toBe('ERR_SERVICE_UNREACHABLE');

      const timeoutError = { name: 'TimeoutError', message: 'Request exceeded deadline' };
      expect((server as any).classifyPaidCallError(timeoutError).code).toBe('ERR_SERVICE_UNREACHABLE');
    });

    it('should not misclassify an error containing "fetch" when structured codes indicate trustline or balance', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

      // In the old code, msg.includes('fetch') would falsely report this as ERR_SERVICE_UNREACHABLE
      const misleadingMessageError = {
        message: 'Failed to fetch account balance due to op_no_trust on destination asset',
        response: {
          data: {
            extras: {
              result_codes: {
                operations: ['op_no_trust']
              }
            }
          }
        }
      };

      const res = (server as any).classifyPaidCallError(misleadingMessageError);
      expect(res.code).toBe('ERR_MISSING_TRUSTLINE');
      expect(res.code).not.toBe('ERR_SERVICE_UNREACHABLE');
    });

    it('should fall back to message text matching when error is unstructured', async () => {
      const server = new BazaarMcpServer({ fetchWithPayment: vi.fn() });

      const unstructuredTrustline = new Error('op_no_trust was encountered');
      expect((server as any).classifyPaidCallError(unstructuredTrustline).code).toBe('ERR_MISSING_TRUSTLINE');

      const unstructuredFunding = new Error('The account is underfunded');
      expect((server as any).classifyPaidCallError(unstructuredFunding).code).toBe('ERR_INSUFFICIENT_BALANCE');

      const unstructuredExpired = new Error('Signature expired');
      expect((server as any).classifyPaidCallError(unstructuredExpired).code).toBe('ERR_EXPIRED_AUTHORISATION');

      const unstructuredNetwork = new Error('Failed to fetch from host');
      expect((server as any).classifyPaidCallError(unstructuredNetwork).code).toBe('ERR_SERVICE_UNREACHABLE');

      const unknownError = new Error('Completely random unmapped exception');
      expect((server as any).classifyPaidCallError(unknownError).code).toBe('ERR_INTERNAL_FAILURE');
    });
  });
});
