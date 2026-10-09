---
title: Providers and accounts
description: "A provider describes how to authenticate with a service. An account is one saved, reusable instance of it, and an app requirement is the slot it fills."
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
account saved for one can be selected by the other. You do not coordinate an
identifier between apps; matching definitions are enough.

A provider reference is also not permission. Knowing it does not let an app read
an account. Access is authorized separately.

## Account

An **account** is one saved instance of one provider method: a label plus the
field values. It is owned, and it is reusable.

Two accounts of the same provider are normal. "Work Vercel" and "Personal
Vercel" hold different tokens, and each of your
[profiles](/concepts/apps-and-deployments#profile) for an app selects one of
them. Several apps can use the same account without copying the credential.

An account can also have a **description**: free text for agents, such as
"reads only; use the sandbox account for writes". Agents read it with the label
when they choose between accounts. Set it when you create the account or edit
it later; neither changes the credential.

Fields are an object that matches the method's schema — `{ token }`, or
`{ email, key }` — not one normalized secret string.

## Requirements

An app declares a **requirement** for each provider it needs. The requirement is
a named slot on the app.

```ts
const requirements = { accounts: { vercel } };
```

`vercel` is the slot name. A plain provider needs exactly one account.
`provider.many()` accepts zero or more, and the app receives a list.

Setting up a profile means choosing which account fills each slot. The profile
saves the account IDs, not copies of the credentials. Replace the credentials on
the account and every profile that selected it follows.

A profile cannot run a tool that needs a slot you have not filled.

## Not a login

Signing in to Executor with Google or GitHub is not an account in this sense. A
login proves who you are. An account is a credential an app uses. A login never
creates an account, and a tool never receives your login token.

## What is coming later

- Providers backed by a signed-in browser session.

See [Connect an account](/connect-an-account) for the steps.
