export const MCP_ERROR_CODES = {
  ERR_PAYMENT_REJECTED: 'ERR_PAYMENT_REJECTED',
  ERR_INSUFFICIENT_BALANCE: 'ERR_INSUFFICIENT_BALANCE',
  ERR_EXPIRED_AUTHORISATION: 'ERR_EXPIRED_AUTHORISATION',
  ERR_MISSING_TRUSTLINE: 'ERR_MISSING_TRUSTLINE',
  ERR_SERVICE_UNREACHABLE: 'ERR_SERVICE_UNREACHABLE',
  ERR_BAD_REQUEST: 'ERR_BAD_REQUEST',
  ERR_INTERNAL_FAILURE: 'ERR_INTERNAL_FAILURE'
  // ERR_NO_RESULTS is deliberately not defined here.
  // An empty search is a successful result with an empty collection, not an error.
  // Real failures (unreachable, malformed response, refused host) remain errors.
} as const;

export type McpErrorCode = keyof typeof MCP_ERROR_CODES;

export interface McpErrorResponse {
  isError: true;
  code: McpErrorCode;
  reason: string;
}
