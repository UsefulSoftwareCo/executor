# Product Scope Language

Executor has a real scope model, but the product should mostly avoid saying
"scope" to users. Use ownership and usage language instead.

## Product Terms

- **Personal**: only this user can use or update the credential/connection.
- **Organization**: everyone with access to the source can use the shared
  credential/connection.
- **Source owner**: where the source definition and shared auth method live.
  This is usually implicit from the current page/context and should not be
  shown as debug information.
- **Used by**: who uses a specific credential value for a shared auth slot.
- **Saved to**: where a newly created secret or OAuth token/connection is
  stored.

## UI Rules

- Communicate source auth as two separate choices:
  - the shared authentication method for the source, such as bearer header,
    query parameter, or OAuth;
  - the credential/connection value used for that method.
- Do not imply users can change the auth method per person when the backend only
  allows credential values to vary per scope.
- Put secret storage choices in the new-secret flow, because choosing Personal
  or Organization there creates a reusable secret at that ownership level.
- Put credential usage choices next to the credential picker as **Used by**,
  because attaching a secret to a source slot is separate from where the secret
  itself is stored.
- Put OAuth token/connection storage next to **Connect via OAuth** as **Token
  saved to**. This is independent from OAuth client ID/client secret storage.
- Secret lists should show secrets from all visible ownership levels with a
  Personal/Organization badge.

## Preferred Copy

- Use "Personal" and "Organization" for selectors.
- Use "Used by" for source credential bindings.
- Use "Save secret to" in secret creation.
- Use "Token saved to" for OAuth sign-in results.
- Use "Add without credentials" whenever the source can be added with missing
  initial credential values, not only for OAuth.

Avoid copy like "scope", "target scope", "source scope", "binding scope", or
"credential target scope" in product UI unless it is explicitly a developer or
debug surface.
