---
"@executor-js/plugin-openapi": patch
---

**Exa preset points at Exa's live OpenAPI spec**

The `exa` preset now fetches https://exa.ai/docs/exa-spec.yaml instead of the stale exa-labs/openapi-spec GitHub master (last synced April 2026). The retired `/research` endpoints broke connection health checks (`RESEARCH_RETIRED`, "Degraded" status) and exposed dead `research-*` tools. The live spec removes those and adds Monitors, Agent, the `publication` category, `deep-lite`, and a cheap `GET /v0/teams/me` health-check candidate.
