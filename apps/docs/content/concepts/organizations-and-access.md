---
title: Organizations and access
description: "Hosted and self-host group people into organizations. An organization owns its accounts, apps and deployments, and each member holds one role."
---

An **organization** is the boundary that owns accounts, apps and deployments on
hosted and self-host. Everything you connect or deploy belongs to one. Local
Executor has no organizations; it is one person on one machine.

## Members and roles

Every person in an organization is a member with one role:

| Role     | Can do                                           |
| -------- | ------------------------------------------------ |
| `owner`  | Everything, including managing the organization. |
| `admin`  | Manage apps and accounts, and run tools.         |
| `member` | Inspect the organization.                        |

Running a tool through MCP currently requires `admin` or `owner`. A `member` can
look but not execute.

People join by invitation. On hosted you can also be admitted by your identity
provider when one is configured.

## Slugs

An organization has a slug: lowercase letters, numbers and hyphens, up to 80
characters. Dashboard URLs are built from it, as `/org/<slug>/...`. If the slug
you want is taken, Executor adds a short random suffix. Changing a slug does not
leave a redirect behind, so old links stop working.

## Access is never implicit

Being in an organization is what grants access. There is no ambient "current
organization" that decides it: the organization you are looking at in the
dashboard is a display preference and nothing more.

That matters most for agents. An MCP connection is approved for one
organization, and the grant records it. Switching organization in the dashboard
afterwards does not retarget the connection, including after the token
refreshes. To reach a second organization, connect again and approve it
separately. An API call whose URL names a different organization than the grant
is refused, even when you belong to both.

Every request revalidates your membership. Losing it stops the connection
working immediately.

## Signing in

- **Hosted** supports Google, GitHub, passkeys and a verified email code.
- **Self-host** uses a password. The first person to finish setup becomes the
  owner, and there is one organization. After that, people join by invitation.
  You can add an OIDC identity provider and restrict it to your email domains.
  Self-host does not offer the hosted Google and GitHub buttons.

A login is not an account. Signing in with Google does not create a Google
account an app can use, and no tool ever receives your login token. See
[Providers and accounts](/concepts/providers-and-accounts).

## What is coming later

- Workspaces: a grouping inside an organization for installing apps and sharing
  accounts with a smaller set of people.
- Per-person account selection, so a shared app can use the caller's own
  account.
