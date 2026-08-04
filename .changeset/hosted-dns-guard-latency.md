---
"@executor-js/sdk": patch
---

Cache hosted outbound DNS guard resolutions, so a proxied request no longer pays a fresh lookup on every hop. Also tightens the outbound guard's address classifiers: IPv6 prefixes that carry an IPv4 destination (IPv4-translatable, 6to4, local-use NAT64) are classified by that destination, every address a hostname resolves to is checked rather than the first, and address forms the platform resolver reads differently from a decimal-only parser (octal octets, a dotted quad in the head of a compressed literal) no longer classify as public.
