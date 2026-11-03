# Executor

Executor connects reusable accounts to apps people can build, run, and share. Products decide who can
access those resources.

## Language

**Provider**:
A service/auth definition authored in app code, with named authentication
methods. Matching normalized definitions have the same provider reference and
can reuse accounts. A secrets method's label and its fields' titles and
descriptions are display text, not part of the definition that matches. A
provider stored before display text left the reference keeps its own. An app
with that stored provider's exact wording keeps that reference; other wordings
use the least stored reference of the definition. It has no separately
registered owner or slug.

**Authentication method**:
One named way to connect an account, such as OAuth or API-key fields.

**Account**:
An independently owned, reusable saved instance of a provider method.
Several apps can select the same account ID without copying credentials.
_Avoid_: Integration, connection as a replacement name for the saved account.

**App**:
Software with its own name, owner, source, account selections, and data. An app can
exist before its first version. Configured copies can share code and select
different accounts.
_Avoid_: Integration, artifact project as a separate kind of app.

**Undeployed app**:
An app with editable source and no active version. It is the same app as
after deploying, not a separate draft resource.
_Avoid_: Draft app.

**Working source**:
The app's current editable source. Saving changes does not change the running
version.

**Source revision**:
An immutable state of an app's source files.

**Fork**:
A new app whose source and history start from another app and can change
independently. Its accounts and data are separate.

**Package name**:
The scoped name used to discover a public app listing, such as
`@acme.executor.community/notes`. Its label, `notes`, identifies the listing
within its publisher.

**Publisher scope**:
An organization's publishing namespace, `<slug>.executor.community`. It follows
the organization's current slug and is never claimed: a rename moves every
listing to the new scope, and the old one is free for the next organization
that takes the slug.

**Publication**:
A public listing pointing to one selected Git commit. Republishing changes the
listing; unpublishing removes it. Installed copies remain independent.

**Public app installation**:
Copy a reviewed publication's source into a new owned app and deploy it. It has
its own Git repository, account selections and app data. Upstream changes do not
update it.

**App code**:
The authored program and revision history behind configured copies.

**Version**:
An immutable executable version of app code. Deploying creates a version.
Activating another version changes the running code, not stored app data.
Configured copies can select versions from the same code lineage.
_Avoid_: Deployment as a name for the retained version.

**Account slot**:
An app-wide named requirement, in one scope. A provider requires one account;
provider.many() accepts zero or more. A name is used once across both scopes.

**User account**:
An account filling a user requirement (`ctx.user.accounts`): linked by each
caller for themselves.

**App account**:
An account filling an app requirement (`ctx.app.accounts`): linked for everyone
by people who can edit the app, and used through the app by every caller and
its background work.

**App link**:
One `(app, requirement, account)` with no subject, set by someone who can edit
the app and use the account. It fills an app requirement for everyone.

**User link**:
One `(app, requirement, account)` for one member, set by that member. It fills a
user requirement for their calls. A plain requirement keeps one link per scope
(and member): linking another replaces it. `.many()` keeps every link.

**Owner**:
The opaque product identity to which an account, configured app or version
belongs. Ownership does not grant access to another resource.

**Tool**:
An operation exposed by a live app evaluation. Availability can depend on the
configured app's accounts and the service's current capabilities.

## Hosted access

**Group**:
A named set of current members of one organization, used to share apps and accounts.

**App access**:
Who can use a hosted app: its creator only, selected groups, or everyone in the organization.

**Personal account**:
A saved provider account whose metadata and use are private to one organization member.

**Shared account**:
An organization account with its own group or Everyone access, independent of app access.

**Account offer**:
A saved account made available for an app requirement, with a default for members who have access.

**Member choice**:
An explicit On or Off for an offered account. No choice means follow its default.

**Management access**:
Permission to configure a resource. It does not grant permission to use its credentials.
