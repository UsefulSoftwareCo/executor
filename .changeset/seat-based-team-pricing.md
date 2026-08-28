---
"@executor-js/cloud": patch
---

**Team pricing is per member with unlimited executions**

The Team plan moves from $150 per organization with a 250,000-execution
allowance to $15 per member per month with unlimited executions. The
`members` feature is unarchived in `autumn.config.ts` and billed in arrears
on the seat count the app reports; Free keeps its 3-member, 100,000-execution
shape and Enterprise stays custom with seat usage tracked for visibility.

Seat counts reconcile from a full WorkOS recount (active members only —
pending invites hold a seat for the plan gate but are not billed) after
member removal, invitation acceptance, organization creation, and on every
login callback, which also picks up joins the app never sees a mutation for
(SSO JIT provisioning, join by domain, dashboard edits). Plans that predate
seat pricing have no members balance and are skipped, so existing
subscriptions keep billing exactly as before on their current plan version.

The plans page, billing page, and marketing pricing cards now show the
per-member price.
