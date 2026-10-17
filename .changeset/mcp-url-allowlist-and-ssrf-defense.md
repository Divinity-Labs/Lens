---
"lens": minor
---

Enforce URL allowlisting and SSRF defense on Bazaar MCP server:
- Added `ERR_HOST_NOT_ALLOWED`, `ERR_PRIVATE_ADDRESS_REFUSED`, and `ERR_INVALID_URL` error codes to `MCP_ERROR_CODES`.
- `paid_call` enforces a configured payment host allowlist (`allowedHosts`, `allowedPaymentHosts`, env `MCP_ALLOWED_HOSTS`) before contacting the network. The default configuration pays nobody (`[]`). Unapproved hosts are refused with a structured error naming the host.
- Near-miss host spoofing (e.g. `notstellar.org`, `stellar.org.attacker.com`) is strictly blocked.
- Non-HTTP/HTTPS schemes (e.g. `file:`, `ftp:`, `gopher:`) are rejected.
- `bazaar_search` blocks requests to private, loopback, link-local, and cloud metadata addresses (e.g. `127.0.0.1`, `169.254.169.254`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`).
- Post-DNS resolution validation prevents DNS rebinding to internal or private IP addresses.
- Redirects are validated manually, refusing redirects leading to forbidden or private destinations.
