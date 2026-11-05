---
"@executor-js/cloud": patch
---

Executor Cloud no longer creates organizations: new organizations are created in Executor v2. A signed-in account with no organization is sent to Executor v2's sign-up page, or to a page listing its pending invitations when it has been invited to an existing organization. `/create-org` and the organization switcher's new-organization link open Executor v2, and `POST /api/auth/create-organization` answers `OrganizationCreationMoved` (410) without creating anything.
