export const DEFAULT_MAX_RESULT_BYTES = 64 * 1024; // 64 KB

export interface BoundedReadResult {
  text: string;
  truncated: boolean;
  bytesRead: number;
}

/**
 * Reads an HTTP response body up to `maxBytes` without buffering oversized
 * responses in full. If the response stream exceeds `maxBytes`, reading stops
 * and the stream is cancelled.
 */
export async function readBoundedResponseBody(
  res: Response,
  maxBytes: number = DEFAULT_MAX_RESULT_BYTES
): Promise<BoundedReadResult> {
  const body = res.body;

  // Fallback for mock/stub responses without a ReadableStream body
  if (!body || typeof (body as any).getReader !== 'function') {
    const raw = await res.text();
    const byteLen = Buffer.byteLength(raw, 'utf-8');
    if (byteLen > maxBytes) {
      const truncatedText = Buffer.from(raw, 'utf-8').subarray(0, maxBytes).toString('utf-8');
      return {
        text: truncatedText,
        truncated: true,
        bytesRead: maxBytes,
      };
    }
    return {
      text: raw,
      truncated: false,
      bytesRead: byteLen,
    };
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (bytesRead + value.byteLength > maxBytes) {
          const needed = maxBytes - bytesRead;
          if (needed > 0) {
            chunks.push(value.subarray(0, needed));
            bytesRead += needed;
          }
          truncated = true;
          // Cancel the stream to prevent buffering the remainder in memory
          await reader.cancel('Exceeded maxResultBytes limit');
          break;
        } else {
          chunks.push(value);
          bytesRead += value.byteLength;
        }
      }
    }
  } catch (err) {
    if (!truncated) throw err;
  }

  const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return {
    text: combined.toString('utf-8'),
    truncated,
    bytesRead,
  };
}

/**
 * Serializes and bounds a result object or string for an MCP tool response.
 * Never pretty-prints with indentation.
 * If the output was truncated or exceeds maxBytes, returns an explicit
 * truncation envelope.
 */
export function formatBoundedToolOutput(
  rawText: string,
  wasStreamTruncated: boolean,
  maxBytes: number = DEFAULT_MAX_RESULT_BYTES
): string {
  if (wasStreamTruncated) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Incomplete JSON due to stream truncation is expected; keep as string
      parsed = rawText;
    }
    return JSON.stringify({
      truncated: true,
      maxBytes,
      warning: `Response exceeded maximum size limit of ${maxBytes} bytes and was truncated.`,
      data: parsed,
    });
  }

  // Attempt to parse JSON and serialize without indentation
  let serialized: string;
  try {
    const parsed = JSON.parse(rawText);
    // If it's a collection with resources array, bound the array if huge
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as any).resources)) {
      const resources = (parsed as any).resources;
      const json = JSON.stringify(parsed);
      if (Buffer.byteLength(json, 'utf-8') > maxBytes) {
        // Truncate collection explicitly
        const half = Math.max(1, Math.floor(resources.length / 2));
        return JSON.stringify({
          truncated: true,
          totalItems: resources.length,
          returnedItems: half,
          maxBytes,
          warning: `Collection exceeded size limit of ${maxBytes} bytes; returned partial items.`,
          resources: resources.slice(0, half),
        });
      }
    }
    serialized = JSON.stringify(parsed);
  } catch {
    serialized = rawText;
  }

  const byteLength = Buffer.byteLength(serialized, 'utf-8');
  if (byteLength > maxBytes) {
    const cut = Buffer.from(serialized, 'utf-8').subarray(0, maxBytes).toString('utf-8');
    return JSON.stringify({
      truncated: true,
      maxBytes,
      warning: `Output exceeded maximum size limit of ${maxBytes} bytes and was truncated.`,
      text: cut,
    });
  }

  return serialized;
}
