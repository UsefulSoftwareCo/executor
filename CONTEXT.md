# Executor

Executor connects reusable accounts to apps people can build, run, and share. Products decide who can
access those resources.

## Language

**Provider**:
A service/auth definition authored in app code, with named authentication
methods. Matching normalized definitions have the same provider reference and
can reuse accounts; hosts and setup help are not compared. It has no separately
registered owner or slug.

**Authentication method**:
One named way to connect an account, such as OAuth or API-key fields.

**Setup help**:
What an app version tells people connecting an account: a secrets method's
`guide`, an OAuth method's `clientGuide`, and each field's `title` and
`description`. It belongs to the version, not the provider.
_Avoid_: Setup guide for the whole; onboarding uses it for assistant setup.

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
the app, with an account of their own. It fills an app requirement for everyone.

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
A named set of current members of one organization, used to share apps and OAuth clients.
Accounts are never shared.

**App access**:
Who can use a hosted app: its creator only, selected groups, or everyone in the organization.

**Personal account**:
A saved provider account owned by one organization member. Every hosted account is personal;
only its owner, while still a member, can use or manage it.

**Management access**:
Permission to configure a resource. It does not grant permission to use its credentials.
