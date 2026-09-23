# Executor

Executor connects reusable accounts to apps people can build, run, and share. Products decide who can
access those resources.

## Language

**Provider**:
A service/auth definition authored in app code, with named authentication
methods. Matching normalized definitions have the same provider reference and
can reuse accounts. It has no separately registered owner or slug.

**Authentication method**:
One named way to connect an account, such as OAuth or API-key fields.

**Account**:
An independently owned, reusable saved instance of a provider method.
Several apps can select the same account ID without copying credentials.
_Avoid_: Integration, connection as a replacement name for the saved account.

**App**:
Software with its own name, owner, source, account selections, and data. An app can
exist before its first deployment. Configured copies can share code and select
different accounts.
_Avoid_: Integration, artifact project as a separate kind of app.

**Draft app**:
An app with editable source and no active deployment.

**Working source**:
The app's current editable source. Saving changes does not change the running
deployment.

**Source revision**:
An immutable state of an app's source files.

**Fork**:
A new app whose source and history start from another app and can change
independently. Its accounts and data are separate.

**Package name**:
The scoped name used to discover a public app listing.

**Publisher scope**:
An organization's publishing namespace. Existing ownership survives changes to
the organization's name or address.

**Publication**:
A public listing pointing to one selected Git commit. Republishing changes the
listing; unpublishing removes it. Installed copies remain independent.

**Public app installation**:
Copy a reviewed publication's source into a new owned app and deploy it. It has
its own Git repository, account selections and app data. Upstream changes do not
update it. Executor app-to-app package dependencies are deferred.

**App code**:
The authored program and revision history behind configured copies.

**Deployment**:
An immutable executable version of app code. Activating another deployment
changes the running code, not stored app data. Configured copies can select
deployments from the same code lineage.

**Account slot**:
An app-wide named requirement. A provider requires one account; provider.many()
accepts zero or more. Selected account IDs are saved on the configured app.

**Owner**:
The opaque product identity to which an account, configured app or deployment
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
