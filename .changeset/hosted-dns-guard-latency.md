---
"@executor-js/sdk": patch
---

Cache hosted outbound DNS guard resolutions, so a proxied request no longer pays a fresh lookup on every hop. Also classifies the IPv6 prefixes that carry an IPv4 destination (IPv4-translatable, 6to4, local-use NAT64) by that destination, and checks every address a hostname resolves to rather than the first.
