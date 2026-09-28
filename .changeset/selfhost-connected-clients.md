---
"executor": minor
---

**Self-host: a Connected clients page — everything that can act as you, and a way to cut each one off**

The console had no view of the MCP clients that connected over OAuth, and no way to disconnect one short of editing the database. The new **Connected clients** page lists, for the signed-in user only: MCP clients (Claude Code, Cursor, Codex, …) with their last sign-in, personal API keys, and browser sessions. Each can be revoked after a confirmation. Revoking an MCP client deletes its tokens and its consent, so it is signed out on its next request — including a session it already has open, since MCP authenticates every request — and must be approved again before it can call a tool.

The plane (`/api/access/*`) answers the signed-in browser only: a request carrying `Authorization` or `x-api-key` is refused, so an agent cannot list or revoke the credentials of the person it acts for. Mutations also require a same-origin `Origin`, a user only ever sees and revokes their own credentials (anyone else's read as not found), and no token, key hash or client secret is ever served.
