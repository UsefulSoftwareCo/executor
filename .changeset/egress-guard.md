---
"@executor-js/sdk": patch
"@executor-js/plugin-openapi": patch
---

fix: block SSRF targets when fetching integration specs by URL

Adding an OpenAPI (or other URL-based) integration fetched the spec URL
server-side with no egress filtering. A crafted URL pointing at cloud
metadata (169.254.169.254), loopback, RFC1918, or link-local addresses let
the fetch feature reach internal state on hosted deployments.

A shared egress guard (`assertFetchable`) now validates every spec-fetch
target before connecting: it normalizes DNS-encoding tricks (decimal/octal/
hex integer IPv4, trailing dots), resolves hostnames, and fails closed if
any resolved address is loopback, RFC1918, link-local, carrier-grade NAT,
IPv6 link-local/ULA, or IPv4-mapped private. The resolved address is pinned
for the connect (no second resolution, so DNS rebinding cannot swap in a
private target), and the original host is preserved in the Host header.
Rejections are coarse ("blocked by egress policy") and never echo internal
addresses.
