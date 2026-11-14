---
"@executor-js/mcp-auth": patch
---

Dynamic client registrations that omit `application_type` are native when a callback is an RFC 8252 loopback or private-use one, and every callback is held to the native rules. A client that registers a web callback beside a loopback or private-use one is no longer refused.
