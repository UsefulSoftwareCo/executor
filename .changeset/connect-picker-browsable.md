---
"@executor-js/react": patch
---

**The connect picker is browsable instead of an 85-row scroll box**

Connecting an integration meant scrolling a flat list of every preset every plugin ships — about 85 of them — through a 224px window in a 560px dialog. Two providers contribute roughly half of those rows as bare service names ("Users", "Directory", "Profile", "My Graph Operations"), which say nothing on their own, so the list read as noise and search was the only way through it.

Providers with more than one service now browse as a single card that opens into its services, which turns 85 rows into 39 cards, and the curated `featured` presets lead, so the two providers standing in for half the library sit on the first screen rather than twelve rows down. Searching deliberately ungroups: typing "outlook" returns Outlook Mail, Calendar, and Contacts rather than the Microsoft card they were trying to see past. Protocol facets (All, OpenAPI, MCP, GraphQL) each count the cards they reveal for the active query. The dialog is wider, lays the catalog out in two columns, and moves the add-by-protocol links to the footer, out of the way of the thing people came for.
