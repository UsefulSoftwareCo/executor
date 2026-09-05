---
"@executor-js/sdk": minor
"@executor-js/api": minor
---

Record the authenticated connector on personal and workspace connections, and expose that attribution in connection responses.

Self-hosted deployments can configure a separate trusted delegation token so an identity-aware gateway can bind each request to its verified member subject and current workspace role. Ordinary user and admin API keys cannot select another member's subject.
