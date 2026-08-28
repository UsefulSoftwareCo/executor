---
"executor": patch
---

**The RFC 8707 `resource` parameter is now gated on what the authorization server advertises**

Executor sent `resource` unconditionally on every authorization, code exchange, refresh, and client-credentials request whenever an OAuth app had a resource configured. Microsoft Entra v2 rejects that: a request carrying both `resource` and a v2 `scope` such as `https://api.fabric.microsoft.com/.default` fails with `AADSTS9010010` before the consent screen, so the Microsoft Fabric Core MCP server could not be connected at all.

The rule now applied on all four grants, in full:

- **No authorization-server metadata was discovered → send `resource`.** Nothing is known about the server, and the MCP authorization spec expects resource indicators. This is the previous behavior, unchanged, and it covers every manually configured provider.
- **Metadata was discovered and advertises `resource_indicators_supported: true` → send `resource`.**
- **Metadata was discovered and the flag is absent or `false` → omit `resource`.** RFC 8414 §2 makes an omitted metadata field mean "not advertised", and RFC 8707 §2 makes `resource` optional for clients, so omitting it is conformant.

The decision reads only what a server publishes about itself — there is no Microsoft special case and no host allowlist. `resource_indicators_supported` is not in the IANA authorization-server metadata registry (RFC 8707 registered no discovery parameter), but it is the only machine-readable signal a server gives, so discovery now parses it and threads it to the grant helpers.

The protected resource is still discovered, validated against the requested endpoint, and retained in the flow state for MCP binding when the parameter itself is withheld. The `executor.oauth.has_resource` span attribute now reports what actually went on the wire rather than what was configured.

Providers whose authorization server advertises the capability, and providers reached without any metadata discovery, are unaffected.
