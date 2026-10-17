import dns from 'dns';
import { McpErrorCode } from './codes.js';

export interface SafeUrlValidationOptions {
  allowedHosts?: string[];
  requireAllowlist?: boolean;
  dnsLookup?: (hostname: string) => Promise<string[]>;
}

export type SafeUrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; code: McpErrorCode; reason: string };

/**
 * Checks if a target host matches an allow-list of hosts/domains.
 *
 * Supports exact domain matches (e.g. 'stellar.org') and wildcard domains (e.g. '*.stellar.org').
 * Prevents near-miss spoofing (e.g. 'notstellar.org' or 'stellar.org.attacker.com').
 */
export function isHostAllowed(targetHost: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return false;
  if (!targetHost) return false;

  const cleanTarget = targetHost.toLowerCase().trim().replace(/:\d+$/, '');

  return allowedHosts.some((allowed) => {
    const cleanAllowed = allowed
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');

    if (!cleanAllowed) return false;

    if (cleanAllowed.startsWith('*.')) {
      const baseDomain = cleanAllowed.slice(2);
      return cleanTarget === baseDomain || cleanTarget.endsWith('.' + baseDomain);
    }

    return cleanTarget === cleanAllowed;
  });
}

/**
 * Checks whether an IP address is private, loopback, link-local, or cloud metadata.
 *
 * Covers:
 * - 127.0.0.0/8 (Loopback)
 * - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (Private networks RFC 1918)
 * - 169.254.0.0/16 (Link-local & AWS/GCP/Azure Cloud Metadata)
 * - 0.0.0.0/8, 100.64.0.0/10, 192.0.0.0/24, 198.51.100.0/24, 203.0.113.0/24
 * - 224.0.0.0/4 (Multicast), 240.0.0.0/4 (Reserved / Broadcast)
 * - ::1 (IPv6 Loopback), :: (Unspecified), fe80::/10 (Link-local), fc00::/7 (ULA)
 * - IPv4-mapped IPv6 (::ffff:x.x.x.x)
 */
export function isPrivateIp(ipAddress: string): boolean {
  let ip = ipAddress.trim();

  // Strip IPv4-mapped IPv6 prefix
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  // IPv6 checks
  if (ip === '::1' || ip === '::') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true; // Link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true; // Unique local address (ULA)

  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    const [p0, p1] = parts;
    if (p0 === 0) return true; // Current network
    if (p0 === 10) return true; // 10.0.0.0/8
    if (p0 === 127) return true; // 127.0.0.0/8 Loopback
    if (p0 === 169 && p1 === 254) return true; // 169.254.0.0/16 Link-local / Cloud Metadata
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true; // 172.16.0.0/12
    if (p0 === 192 && p1 === 168) return true; // 192.168.0.0/16
    if (p0 === 100 && p1 >= 64 && p1 <= 127) return true; // Carrier-grade NAT
    if (p0 >= 224) return true; // Multicast & Reserved
  }

  return false;
}

/**
 * Checks if a hostname matches private host patterns (e.g. localhost, .internal, etc.).
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().trim();
  if (host === 'localhost') return true;
  if (
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.localdomain')
  ) {
    return true;
  }
  return false;
}

/**
 * Resolves a hostname to a list of IP addresses using DNS.
 */
export async function resolveHostnameAddresses(
  hostname: string,
  customDnsLookup?: (hostname: string) => Promise<string[]>
): Promise<string[]> {
  if (customDnsLookup) {
    return customDnsLookup(hostname);
  }

  try {
    const results = await dns.promises.lookup(hostname, { all: true });
    return results.map((r) => r.address);
  } catch (err: any) {
    // If it's already an IP or resolution fails
    return [];
  }
}

/**
 * Validates a URL against protocol schemes, allow-lists, and SSRF restrictions
 * (including post-DNS resolution check for private, loopback, link-local, and metadata IPs).
 */
export async function validateSafeUrl(
  urlStr: string,
  options: SafeUrlValidationOptions
): Promise<SafeUrlValidationResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    return {
      ok: false,
      code: 'ERR_INVALID_URL',
      reason: `Malformed URL: "${urlStr}".`,
    };
  }

  // 1. Check scheme
  const proto = parsedUrl.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') {
    return {
      ok: false,
      code: 'ERR_INVALID_URL',
      reason: `Unsupported URL protocol: "${parsedUrl.protocol}". Only HTTP and HTTPS are permitted.`,
    };
  }

  const hostname = parsedUrl.hostname;

  // 2. Enforce allow-list if required or if configured
  if (options.requireAllowlist || (options.allowedHosts && options.allowedHosts.length > 0)) {
    if (!isHostAllowed(hostname, options.allowedHosts)) {
      return {
        ok: false,
        code: 'ERR_HOST_NOT_ALLOWED',
        reason: `Host "${hostname}" is not on the allowed host list.`,
      };
    }
  }

  // 3. Check for literal private hostnames
  if (isPrivateHostname(hostname)) {
    return {
      ok: false,
      code: 'ERR_PRIVATE_ADDRESS_REFUSED',
      reason: `Host "${hostname}" is a private or local address and is refused.`,
    };
  }

  // 4. Check for literal private IP
  if (isPrivateIp(hostname)) {
    return {
      ok: false,
      code: 'ERR_PRIVATE_ADDRESS_REFUSED',
      reason: `Address "${hostname}" is a private, loopback, or metadata address and is refused.`,
    };
  }

  // 5. Post-DNS resolution check: Resolve hostname and check all resolved IPs
  const resolvedIps = await resolveHostnameAddresses(hostname, options.dnsLookup);
  for (const ip of resolvedIps) {
    if (isPrivateIp(ip)) {
      return {
        ok: false,
        code: 'ERR_PRIVATE_ADDRESS_REFUSED',
        reason: `Host "${hostname}" resolves to private address "${ip}". Access is refused.`,
      };
    }
  }

  return { ok: true, url: parsedUrl };
}

export interface SafeFetchOptions {
  allowedHosts?: string[];
  requireAllowlist?: boolean;
  dnsLookup?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  maxRedirects?: number;
}

/**
 * Performs a fetch request while validating all URL redirects against SSRF constraints
 * and allow-lists, ensuring redirects do not lead to private or unapproved destinations.
 */
export async function safeFetchWithRedirects(
  initialUrl: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const fetchFn = options.fetchFn || fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let currentUrl = initialUrl;
  let redirectsCount = 0;

  while (redirectsCount <= maxRedirects) {
    const validation = await validateSafeUrl(currentUrl, {
      allowedHosts: options.allowedHosts,
      requireAllowlist: options.requireAllowlist,
      dnsLookup: options.dnsLookup,
    });

    if (!validation.ok) {
      const err = new Error(validation.reason) as any;
      err.code = validation.code;
      throw err;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetchFn(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Check for HTTP redirect
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw Object.assign(new Error('Redirect missing Location header'), { code: 'ERR_SERVICE_UNREACHABLE' });
      }

      redirectsCount++;
      if (redirectsCount > maxRedirects) {
        throw Object.assign(new Error('Too many redirects'), { code: 'ERR_SERVICE_UNREACHABLE' });
      }

      // Resolve relative redirect against current URL
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }

  throw Object.assign(new Error('Too many redirects'), { code: 'ERR_SERVICE_UNREACHABLE' });
}
