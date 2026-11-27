---
title: Plans and billing
description: "Compare Executor Cloud plans, start a 14-day Team trial, change plans, and manage invoices and payment methods."
---

**Billing** (`/org/<slug>/billing`) lets organization owners and admins view their Executor Cloud plan, start a **14-day trial** of the **Team** plan when offered, switch plans, or open **Manage billing** for the billing portal. Open it from **Billing** in the sidebar or from **Settings → Billing → Open billing**.

Available on **Cloud** only. Local Executor and Self-host have no Cloud billing pages or Cloud plan limits.

**Prerequisites:** Organization **owners** and **admins** can view plan and billing details, change plans, and open **Manage billing**. Regular **members** see the **Billing access** screen with **Manage billing** and **Change plan** disabled and the note `An organization owner or admin can manage billing.` (and **Open billing** is disabled in **Settings**).

**You'll know it worked when:** After selecting a plan (and completing checkout if it opens), `/org/<slug>/billing` shows **Current plan** (or **Current plan · Trial**) on your selected plan. If payment confirmation is still pending after two minutes, select **Check again**. Reopen **Settings → Members** to confirm the updated member limit once Team is active or trialing.

## Executor Cloud plans

Every Executor Cloud organization is on one of three plans (see [pricing](https://executor.sh/pricing) for current details):

| Plan | Price | Members | Highlights |
| --- | --- | --- | --- |
| **Free** | [`$0 / month`](https://executor.sh/pricing) | Up to 3 members | Core workspace for individuals and small teams. |
| **Team** | [`$15` per active member / month](https://executor.sh/pricing) after a 14-day trial when offered | Free plan cap lifted once active or trialing | Advertised with verified domains. Starting the trial requires a payment card. |
| **Enterprise** | [Custom](https://executor.sh/pricing) | Free plan cap lifted | Adds SAML and OIDC SSO (the **Single sign-on** card appears in **Settings** for Enterprise owners and admins). |

## Start a trial or change plans

1. Open **Billing** (`/org/<slug>/billing`) from the sidebar (or **Settings → Billing → Open billing**).
2. Review your current plan card, marked **Current plan** or **Current plan · Trial**.
3. On the plan you want:
   - Select **Start 14-day trial** when offered or **Choose Team** to move to **Team**. Executor syncs your current member count and opens checkout when payment confirmation is required (a payment card is required to start the 14-day trial); plan changes that need no checkout link refresh in place.
   - Select **Choose Free** to downgrade to **Free**. When the billing provider schedules a downgrade for the end of a billing period, **Scheduled** appears on the target plan card.
   - Select **Contact sales** on **Enterprise** to inquire about an Enterprise plan.
4. Complete checkout if it opens. When you return to `/org/<slug>/billing`, the page watches for payment confirmation (`Waiting for payment confirmation. This page updates automatically.`) and updates to **Current plan** or **Current plan · Trial**. If confirmation is still pending after two minutes, select **Check again**.

## Manage payment methods and invoices

1. Open **Billing** (`/org/<slug>/billing`) as an owner or admin.
2. Click **Manage billing**.
3. Executor opens the billing provider's customer portal to manage your payment methods, invoices, and subscription.

## How seat billing works

On the **Team** plan, billing counts active organization members. Team costs [`$15` per active member per month](https://executor.sh/pricing). If a 14-day trial is offered and you start it, paid billing begins when the trial ends. Pending invitations do not count toward billed seats. Executor synchronizes the seat count in the background when organization membership changes.

On the **Free** plan, an organization can have up to **3 members**. At the Free limit, the dashboard opens the **Member limit reached** dialog with an **Upgrade plan** link to `/org/<slug>/billing` when you click **Add member** or **Resend**. An owner or admin's direct invite API request returns `403 ORGANIZATION_MEMBERSHIP_LIMIT_REACHED`.

## Example

When a **Free** plan organization already has 3 members, **Add member** opens **Member limit reached** in the dashboard (and a direct invite request returns `403 ORGANIZATION_MEMBERSHIP_LIMIT_REACHED`). Moving to **Team** on `/org/<slug>/billing`:

1. Select **Start 14-day trial** (when offered) or **Choose Team**, and complete checkout if it opens.
2. Confirm **Current plan · Trial** or **Current plan** on `/org/<slug>/billing` (using **Check again** if confirmation takes longer than two minutes).
3. Once Team is active or trialing, the server lifts the three-member cap. Reopen **Settings → Members** to see the updated limit and invite the fourth member; seat count syncs in the background once they join.

## Limits

- **Cloud only:** Local Executor and Self-host have no Cloud billing pages or Cloud plan limits.
- **Role restriction:** Regular **members** see **Billing access** with **Manage billing** and **Change plan** disabled and cannot view plan details or manage billing.
- **Trial card requirement:** Starting the **Team** plan's 14-day trial through checkout requires a payment card.
- **Enterprise self-service:** You cannot self-serve upgrade to **Enterprise** from the checkout screen; use **Contact sales**. The **Single sign-on** card in **Settings** is gated to Enterprise owners and admins in the dashboard.
- **Organization deletion cancels billing:** Deleting a Cloud organization from **Settings → Delete organization** schedules cancellation of its paid billing subscription as part of background cleanup.

## Related

- [Members and roles](/docs/organizations/members)
- [Organization settings](/docs/organizations/settings)
- [Organizations and access](/docs/concepts/organizations-and-access)
- [Account settings](/docs/account)
