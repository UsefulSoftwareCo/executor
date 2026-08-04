---
"@executor-js/sdk": patch
---

Cache hosted outbound DNS guard resolutions, so a proxied request no longer pays a fresh lookup on every hop. `makeHostedHttp` builds the guarded fetch and the guarded HTTP client layer over one cache; building them separately still works but resolves each hostname twice.

The outbound guard also honors the caller's `redirect` mode, which it previously ignored: `manual` now returns the unfollowed 3xx with its Location header, and `error` rejects, rather than both silently following the redirect.

Address classification is tightened too: the cloud metadata endpoint is now blocked by the address a hostname denotes rather than by one dotted-decimal spelling, so its IPv6 forms (`::ffff:169.254.169.254`, the 6to4 `2002:a9fe:a9fe::`, NAT64) are blocked under `allowLocalNetwork` as well; IPv6 prefixes that carry an IPv4 destination (IPv4-translatable, 6to4, local-use NAT64) are classified by that destination; deprecated site-local addresses (`fec0::/10`) count as local; every address a hostname resolves to is checked rather than the first; subresource integrity survives a cross-origin redirect; and address forms the platform resolver reads differently from a decimal-only parser (octal octets, a dotted quad in the head of a compressed literal) no longer classify as public.
