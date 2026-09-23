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
Vercel" hold different tokens, and an app selects one of them. Several apps can
select the same account without copying the credential.

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

Configuring an app means choosing which account fills each slot. Those account
IDs are saved on the app, not copied into it. Replace the credentials on the
account and every app that selected it follows.

An app cannot run a tool that needs a slot you have not filled.

## Not a login

Signing in to Executor with Google or GitHub is not an account in this sense. A
login proves who you are. An account is a credential an app uses. A login never
creates an account, and a tool never receives your login token.

## What is coming later

- Per-person account selection on a shared app.
- Providers backed by a signed-in browser session.

See [Connect an account](/connect-an-account) for the steps.
