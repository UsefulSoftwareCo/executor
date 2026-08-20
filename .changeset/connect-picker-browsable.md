---
"@executor-js/react": patch
---

**The connect picker is browsable instead of an 85-row scroll box**

Every preset every plugin ships was listed flat through a 224px window, and two providers contributed half those rows as bare service names ("Users", "Directory", "Profile"). Providers with more than one service now browse as a single card that opens into its services — 85 rows become 39 cards — with the curated `featured` presets leading. Searching ungroups, so "outlook" returns the Outlook services rather than the Microsoft card hiding them, and protocol facets (All, OpenAPI, MCP, GraphQL) count the cards each reveals. The dialog is wider and two columns.
