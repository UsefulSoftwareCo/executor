---
"@executor-js/cloud": patch
---

The cloud membership mirror is now reconciled from the WorkOS Events API: an every-minute cron replays user, organization-membership, and organization events from a persisted cursor, so changes made in the WorkOS dashboard (a removed member, a role edit, a profile update) reach the mirror without anyone signing in. A signed webhook at `/api/webhooks/workos` pokes the same reconciler so those changes land in seconds, and `bun run --cwd apps/cloud db:drain-workos-events:prod` runs the same replay out-of-band until the stream is drained.

**Ops steps (cloud):** set the webhook signing secret with `wrangler secret put WORKOS_WEBHOOK_SECRET`, then register `https://executor.sh/api/webhooks/workos` as a webhook endpoint in the WorkOS dashboard for the `user.*`, `organization_membership.*`, `organization.updated`, and `organization.deleted` events. Until the secret is set the route answers 503 and the cron alone keeps the mirror current.
