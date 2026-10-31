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
browser sign-in. `interactive({ label })` means the requiring app acquires its
own credential through `connect.<slot>` handlers and the standard Connect dialog.

A provider is not registered anywhere and has no owner and no slug. Two apps
that declare the same provider resolve to the same provider reference, so an
account saved for one can be used by the other. You do not coordinate an
identifier between apps; matching definitions are enough.

An interactive account is an exception to reuse: its opaque reference belongs
to the app that acquired it. Matching provider definitions do not let another
app link it. The app keeps the service's tokens and handles their lifecycle;
Executor retains only the reference, ownership and links. See
[app-owned sign-in](/author-an-app#app-owned-sign-in).

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

## Host-provisioned methods

Declare `secrets({ label, fields, provisioned: true })` when only the host
creates the credential. The Accounts tab shows "Set up automatically" when
all of a requirement's methods are provisioned. It offers no reconnect or
credential update for those accounts. Connection APIs refuse those methods,
including submissions to a mixed provider. The host can still use
`managedAccounts.add` and `managedAccounts.replaceCredentials`.

The flag is part of the provider definition. Adopting it changes the provider
reference. The host must migrate or provision the appropriate accounts and
links when it changes an existing declaration.

## Displaying account status

A provider's `health` can return `AccountCheckResult` with optional `accountInfo`
and `status`. For an app-acquired account, add an optional
`connect.<slot>.check(ctx, { method, ref })` handler returning the same result.
It receives the same app accounts, caller, cancellation signal and services as
the other connect steps. The host supplies the saved reference. A check must be
a safe read. Throw `ProviderError` to classify a failure, as provider health
checks do. The host gives the whole check 15 seconds, including account
resolution, and ends the app's deadline one second earlier.

```ts
async check(ctx, { method, ref }) {
  const backend = ctx.app.accounts.backend;
  if (backend === undefined) throw new Error("Connect the backend account first");
  const response = await ctx.fetch("https://service.example/accounts/" + encodeURIComponent(ref), {
    signal: ctx.signal,
    headers: backend.headers(),
  });
  // Decode and classify the service response before returning display data.
  return {
    accountInfo: { displayName: "Example account" },
    status: {
      badges: [{ label: "Available", tone: "good" }],
      meters: [{ label: "5h", remaining: 0.75, resetsAt: "2030-01-02T03:04:05Z" }],
      stats: [{ label: "Requests", value: "42" }],
    },
  };
}
```

`status` has three arrays. Supply an empty array for a kind with no entries.

| Field | Limit |
| --- | --- |
| `badges` | 8 entries; each has `label` and `tone`: `neutral`, `good`, `warning` or `bad` |
| `meters` | 4 entries; each has `label` and `remaining`: a finite fraction from 0 through 1, or `null` for unknown |
| `stats` | 8 entries; each has `label` and string `value` up to 128 characters |
| Every `label` | 1 through 64 characters |
| Meter `resetsAt` | Optional ISO timestamp, at most 35 characters |
| Meter `detail` | Optional text, at most 256 characters |

These are display fields, never credentials or raw service responses. They do
not grant access, select accounts, refresh credentials or control routing.
The Accounts tab renders them below the account's check badge and marks older results
outdated. It stores them only for that check and clears them when a later check
fails or returns no status. The last passing `accountInfo` remains available
when a later check fails. Opening the Accounts tab rechecks missing, outdated
or five-minute-old results once per view.

Status is stored beside identity in the existing JSON health record. It adds no
storage schema version. The previous server reads its known identity fields and
ignores the display data. A status-only check keeps the last identity and its
original check time; a failed check clears display status.

Every identity and status string returned by a check is checked before it leaves
the app and again against raw credentials before the host stores or exposes it.
Checks reject the account reference, credential values and their UTF-8 base64,
base64url, percent-encoded and hexadecimal forms. Identity-only results are checked
too. A refused result records a check failure without the sensitive text. The
matcher does not attempt arbitrary transformations or nested encodings.

The matcher accepts at most 128 display strings containing 32,768 characters in
total. It visits at most 16,384 credential nodes to depth 32, retaining at most
1,024 candidate strings and examining at most 262,144 candidate characters. A
secret longer than every display string cannot fit and is skipped. Exceeding a
budget rejects the check. Empty secrets are skipped.

A function-form app may omit `connect.check`. The host then uses provider health
when declared, or records no check when neither handler exists. An exception from
a check that exists remains a check failure.

A provider may mix host-provisioned and ordinary methods. A connection can save
an ordinary account only when doing so preserves every host-provisioned link.
The shared link boundary enforces this under the app's lock for account radio
selection, agent connection creation or update, and every connection completion.
Local direct linking uses the same rule. Host provisioning uses a separate trusted
link path and can still repair or replace its own accounts.
