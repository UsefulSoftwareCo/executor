---
"@executor-js/plugin-mcp": patch
---

**Stdio MCP servers no longer inherit executor's full environment**

A stdio MCP server that declared any `env` at all was spawned with every environment variable this process holds. The MCP SDK already guards against that: it spawns with `{ ...getDefaultEnvironment(), ...serverParams.env }`, where `getDefaultEnvironment()` is a sudo-style safe-list of `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER`. Passing `{ ...process.env, ...config.env }` did not add to that safe-list, it overwrote it. In practice, adding one third-party `npx` server went from "this server can see the API key I gave it" to "this server also holds `EXECUTOR_SECRET_KEY`, the key that decrypts every other stored credential, plus `EXECUTOR_AUTH_TOKEN` and `DATABASE_URL`". The leak sat on the `config.env` branch — the branch a credential-bearing integration takes.

A stdio server now receives the SDK's safe-list, the variables declared on the source config, and one short allowlist of infrastructure variables read from the host: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (both spellings), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR`. Those carry no credential, no source config declares them, and a server behind a corporate proxy or an intercepting CA cannot reach anything without them — the same reasoning and the same list `service install` already uses when it bakes a supervised unit's minimal environment. The declared `env` wins on a key collision. On Windows that collision is resolved case-insensitively, because the OS treats `Path` and `PATH` as one variable while a JavaScript spread does not: a declared `http_proxy` now replaces an inherited `HTTP_PROXY` instead of travelling beside it, which would have left the child reading whichever spelling Windows resolved first.

If a stdio server relied on some other variable arriving from the host, set it explicitly on the source's `env`. That is now the only way anything beyond the lists above reaches a server, and it is the mechanism that already existed for it.
