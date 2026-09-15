---
"@executor-js/cloud": patch
"@executor-js/api": patch
"@executor-js/react": patch
"@executor-js/sdk": patch
---

Member lists, the admin users page, and seat counts on cloud now read from the local membership mirror through the shared `MemberDirectory` seam instead of fanning out one WorkOS read per member. The admin users page gains an email/name search.

**Deploy prerequisite (cloud):** `bun run --cwd apps/cloud db:backfill-workos-mirror:prod` must complete before this build is deployed, and its printed membership count should match WorkOS. Until the backfill has stamped the mirror's marker, seat reporting to Autumn is skipped with a warning (never a partial count) and member lists show only members who have signed in since the mirror shipped.
