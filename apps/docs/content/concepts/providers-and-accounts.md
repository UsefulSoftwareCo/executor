---
title: Providers and accounts
description: "A provider describes how to authenticate with a service. An account is one saved, reusable instance of it, and an app requirement is the slot it fills: with each caller's own account, or one linked for everyone."
---

## Provider

A **provider** is a service and its authentication, declared in app code. It has
a name and one or more named authentication methods.

```ts
import { defineProvider, object, secrets, string } from "apps";

const vercel = defineProvider({
  name: "Vercel",
  auth: {
    apiKey: secrets({
      label: "API token",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
  },
});
```

`apiKey` is the method name. `secrets` means fields you paste; `oauth2` means a
browser sign-in.

A provider is not registered anywhere and has no owner and no slug. Two apps
that declare the same provider resolve to the same provider reference, so an
account saved for one can be used by the other. You do not coordinate an
identifier between apps; matching definitions are enough.

A provider reference is also not permission. Knowing it does not let an app read
an account. Access is authorized separately.

## Account

An **account** is one saved instance of one provider method: a label plus the
field values. It is owned, and it is reusable.

Two accounts of the same provider are normal. "Work Vercel" and "Personal
Vercel" hold different tokens, and both can be linked to one app. Several apps
can use the same account without copying the credential.

An account can also have a **description**: free text for agents, such as
"reads only; use the sandbox account for writes". Agents read it with the label,
for example when deciding which account to link. Set it when you create the account or edit
it later; neither changes the credential.

Fields are an object that matches the method's schema — `{ token }`, or
`{ email, key }` — not one normalized secret string.

## Requirements

An app declares a **requirement** for each provider it needs. The requirement is
a named slot on the app, and it belongs to one of two scopes:

```ts
const requirements = {
  app: { accounts: { datadog } },
  user: { accounts: { vercel } },
};
```

- A **user account** requirement (`user`) is filled by each caller's own
  account. Every member links their own, and each call uses the caller's.
- An **app account** requirement (`app`) is filled by an account linked for
  everyone by people who can edit the app. Every caller, and the app's schedules
  and webhooks, use it through the app.

`vercel` and `datadog` are the slot names; a name is used once across both
scopes. A plain provider needs exactly one account. `provider.many()` accepts
zero or more, and the app receives a list.

### User accounts

Using an app means linking your accounts to it. A link records that you use an
account with that app; it is not copied into the app and grants nobody else
anything. Replace the credentials on the account and every app linked to it
follows. Hosted and local link accounts the same way, from the app's
**Accounts** tab.

Each link names the slot it fills. A plain slot has one linked account per
member. Linking another account replaces it in the app; the previous account
stays saved. A `.many()` slot uses every linked account; unlink one to stop
using it. Calls never choose accounts: tools, schedules and app pages all run
with your links.

### App accounts

People who can edit an app link its app accounts for everyone, in the **App
accounts** section of the app's **Accounts** tab. Linking needs edit access to
the app and use of the account. Callers use the account through the app without
access to the account itself, and they cannot choose or replace it; everyone
else sees the section read-only, without the account's details from the
provider. Linking another account to a plain slot replaces the one before; a
`.many()` slot uses every linked account. Unlinking stops the app using the
account, which stays saved. An account linked to an app for everyone cannot be
deleted until it is unlinked. The same account may also be linked for yourself.

When an app account needs reconnecting, the people who can edit the app are
told, and a call that needs it fails saying that one of them must reconnect it.

An app cannot run a tool that needs a slot with no linked account.

## Not a login

Signing in to Executor with Google or GitHub is not an account in this sense. A
login proves who you are. An account is a credential an app uses. A login never
creates an account, and a tool never receives your login token.

## What is coming later

- Providers backed by a signed-in browser session.

See [Connect an account](/connect-an-account) for the steps.
