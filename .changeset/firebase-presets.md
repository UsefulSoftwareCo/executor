---
"@executor-js/plugin-mcp": patch
"@executor-js/plugin-openapi": patch
---

**Firebase joins the well-known integration catalogs**

The MCP plugin's preset catalog now includes the Firebase CLI's MCP server
(`npx -y firebase-tools@latest mcp`, local stdio) for project management, Auth
users, Firestore, security rules, Cloud Messaging, and deploys. The OpenAPI
plugin's Google catalog additionally includes Firebase Management
(`firebase.googleapis.com/v1beta1`) and Cloud Firestore
(`firestore.googleapis.com/v1`) as OAuth presets, covering projects, apps,
hosting, extensions, documents, collections, queries, and indexes.
