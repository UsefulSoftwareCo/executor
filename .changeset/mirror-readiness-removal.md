---
"@executor-js/cloud": patch
---

`authorizeOrganization` now reads the local membership mirror unconditionally: the per-request readiness check (`MirrorReadiness`) and its live WorkOS `listUserMemberships` fallback are gone from the request path entirely. The backfill is complete and permanent, and an organization that predates the mirror is still covered by the existing on-demand scan (`ensureOrganizationBackfilled`). A stalled reconciler is now an operational alert instead of a per-request fallback: after each run, the cron checks the mirror's `drained_at` heartbeat and, if it has fallen behind the lag budget, logs a structured error and reports it to Sentry. The deploy gate (`scripts/ensure-workos-mirror-ready.ts`) is unchanged — it still refuses to ship while the mirror is unready — and `drained_at` keeps being written by every reconciler run.
