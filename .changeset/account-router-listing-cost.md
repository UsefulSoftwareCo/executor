---
"apps": patch
"@executor-js/sdk": patch
---

`accountRouter` merges a listing's tools in time that follows the distinct schema definitions
they hold, rather than their number times the definitions each tool reaches. Routers give every
tool that reaches a definition the same object, and a densely connected API reaches most of its
definitions from every tool: Stripe's 610 tools name about 330,000 `$defs` entries but only 1,537
distinct definitions. Merging wrote each tool's whole schemas to compare its accounts', wrote each
of its definitions again to combine them, and checked each merged tool's schemas on their own, so
a cold Stripe listing spent most of a Cloud app Worker's CPU time there: about 17 seconds with
one account, and with three it reached the Worker's CPU limit. A listing now reads each definition object once, and
the catalog read checks every tool's schemas in its existing single pass. Listings are unchanged.
Apps get this when they are rebuilt on this `apps` release.

When loading an app's tools stops at a resource limit, the recovery still allows one retry, then
says to stop retrying unchanged and investigate: rebuild the app on the host's `apps` version if it
was built on an older one, otherwise reduce what the app does while listing. The limit is matched
from the failure's text, so the recovery does not claim a repeat proves its cause.
