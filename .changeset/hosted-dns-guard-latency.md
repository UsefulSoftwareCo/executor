---
"@executor-js/sdk": patch
---

Cache hosted outbound DNS guard resolutions, so a proxied request no longer pays a fresh lookup on every hop. `makeHostedHttp` builds the guarded fetch and the guarded HTTP client layer over one cache; building them separately still works but resolves each hostname twice.

The outbound guard also honors the caller's `redirect` mode, which it previously ignored: `manual` now returns the unfollowed 3xx with its Location header, and `error` rejects, rather than both silently following the redirect.

Address classification is tightened too: IPv6 prefixes that carry an IPv4 destination (IPv4-translatable, 6to4, local-use NAT64) are classified by that destination, every address a hostname resolves to is checked rather than the first, subresource integrity survives a cross-origin redirect, and address forms the platform resolver reads differently from a decimal-only parser (octal octets, a dotted quad in the head of a compressed literal) no longer classify as public.
