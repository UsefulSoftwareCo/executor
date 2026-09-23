import { PageSkeleton, DetailSkeleton } from "@executor-js/ui/dashboard/loading";
import { AsyncResult } from "effect/unstable/reactivity";
import { Alert, AlertDescription } from "@executor-js/ui/components/alert";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { Card } from "@executor-js/ui/components/card";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { QueryResult, useQuery } from "@executor-js/ui/dashboard/context";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { Button } from "@executor-js/ui/components/button";
import { Exit, Option } from "effect";
import { useState } from "react";
import { billingAtom, checkoutAtom, portalAtom } from "../../contracts/billing.ts";

/**
 * The checkout and portal answers are navigation targets, so the browser checks one thing at the
 * moment it navigates: an HTTPS URL that carries no credentials. `javascript:`, `data:` and plain
 * HTTP never reach `location.assign`.
 */
const openBillingUrl = (url: string) => {
  const target = URL.parse(url);
  if (target === null || target.protocol !== "https:" || target.username || target.password)
    return false;
  window.location.assign(url);
  return true;
};

/** Checkout return context is only a UI hint, never evidence of payment or authority. */
export const billingSearch = (search: Record<string, unknown>) => ({
  organization: typeof search.organization === "string" ? search.organization : "",
  plan: typeof search.plan === "string" ? search.plan : "",
});

function BillingDetails({ returned }: { readonly returned: ReturnType<typeof billingSearch> }) {
  const organization = useOrganizationRoute();
  const { result, data, refresh } = useQuery(billingAtom(organization.organization));
  const checkout = useAtomSet(checkoutAtom, { mode: "promiseExit" });
  const portal = useAtomSet(portalAtom, { mode: "promiseExit" });
  const checkoutState = useAtomValue(checkoutAtom);
  const portalState = useAtomValue(portalAtom);
  const [error, setError] = useState<string | null>(null);
  const busy = checkoutState.waiting || portalState.waiting || !AsyncResult.isSuccess(result);
  const waitingForPlan =
    returned.organization === organization.id &&
    returned.plan !== "" &&
    Option.isSome(data) &&
    !data.value.subscriptions.some(
      (subscription) =>
        subscription.planId === returned.plan &&
        ["active", "trialing"].includes(subscription.status),
    );
  return (
    <section className="page w-full shrink-0 max-w-315 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Billing
        </h1>
        <Button
          data-product-area="billing"
          data-product-action="open_portal"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setError(null);
            const result = await portal({ params: { organization: organization.organization } });
            if (Exit.isFailure(result) || !openBillingUrl(result.value.url))
              setError("Unable to open billing settings. Try again.");
          }}
        >
          Manage billing
        </Button>
      </div>
      <p className="muted text-muted-foreground">{organization.name}</p>
      {returned.organization && returned.organization !== organization.id && (
        <Alert className="notice border border-border rounded-[8px] py-[12px] px-[16px] my-[20px] mx-0 text-[13px]">
          <AlertDescription>
            Checkout was opened for another organization. Select that organization to see its plan.
          </AlertDescription>
        </Alert>
      )}
      {waitingForPlan && (
        <Alert
          className="notice border border-border rounded-[8px] py-[12px] px-[16px] my-[20px] mx-0 text-[13px]"
          role="status"
        >
          <AlertDescription>
            Waiting for payment confirmation. This page updates automatically.
          </AlertDescription>
        </Alert>
      )}
      {Option.isSome(data) && data.value.usage && (
        <p className="text-sm text-muted-foreground my-4">
          {data.value.usage.used.toLocaleString()} executions used this month
          {data.value.usage.unlimited
            ? " · Unlimited"
            : ` · ${data.value.usage.remaining.toLocaleString()} remaining`}
        </p>
      )}
      {error && (
        <p role="alert" className="auth-error text-destructive text-[13px]">
          {error}
        </p>
      )}
      <QueryResult
        result={result}
        Failure={BillingFailure}
        retry={refresh}
        pending={<DetailSkeleton label="Loading plans" />}
      >
        {(billing) =>
          billing.plans.length === 0 ? (
            <EmptyState
              title="Plans unavailable"
              action={
                <Button variant="outline" onClick={refresh} disabled={result.waiting}>
                  Refresh plans
                </Button>
              }
            >
              We couldn’t find any plans. Refresh to try again, or contact support if this
              continues.
            </EmptyState>
          ) : (
            <div className="catalog-grid grid grid-cols-3 gap-3 max-[1050px]:grid-cols-2 max-[640px]:grid-cols-1">
              {billing.plans.map((plan) => {
                const subscription = billing.subscriptions.find(
                  (subscription) =>
                    subscription.planId === plan.id &&
                    ["active", "trialing", "scheduled"].includes(subscription.status),
                );
                return (
                  <Card key={plan.id} asChild className="gap-0 rounded-lg shadow-none">
                    <article className="plan-card flex flex-col gap-4.5 border border-border rounded-[8px] p-[20px] min-h-45 [&_h2]:text-[15px] [&_h2]:font-medium [&_button]:mt-auto">
                      <h2>{plan.name}</h2>
                      <p className="plan-price text-[24px] font-medium [&_span]:text-[13px] [&_span]:text-muted-foreground [&_span]:font-normal">
                        {plan.purchase === "contact" ? (
                          "Custom"
                        ) : plan.price === null ? (
                          "Free"
                        ) : (
                          <>
                            {new Intl.NumberFormat("en-US", {
                              style: "currency",
                              currency: "USD",
                              maximumFractionDigits: 0,
                            }).format(plan.price.amount)}
                            <span>
                              {" "}
                              / {plan.price.unit === "member" ? "member / " : ""}
                              {plan.price.interval}
                            </span>
                          </>
                        )}
                      </p>
                      {plan.purchase === "contact" && !subscription ? (
                        <Button asChild variant="outline">
                          <a href="mailto:rhys@executor.sh?subject=Executor%20Enterprise%20inquiry">
                            Contact sales
                          </a>
                        </Button>
                      ) : (
                        <Button
                          data-product-area="billing"
                          data-product-action="select_plan"
                          variant={subscription ? "outline" : "default"}
                          disabled={busy || !!subscription}
                          onClick={async () => {
                            setError(null);
                            const result = await checkout({
                              params: { organization: organization.organization },
                              payload: { plan: plan.id },
                            });
                            if (Exit.isFailure(result))
                              setError(
                                "Unable to confirm the plan change. Check your current plan before trying again.",
                              );
                            else if (result.value.url === null) refresh();
                            else if (!openBillingUrl(result.value.url))
                              setError(
                                "Unable to confirm the plan change. Check your current plan before trying again.",
                              );
                          }}
                        >
                          {subscription
                            ? subscription.status === "scheduled"
                              ? "Scheduled"
                              : "Current plan"
                            : `Choose ${plan.name}`}
                        </Button>
                      )}
                    </article>
                  </Card>
                );
              })}
            </div>
          )
        }
      </QueryResult>
    </section>
  );
}
function BillingFailure({ retry }: { readonly retry?: (() => void) | undefined }) {
  return (
    <EmptyState
      title="Billing unavailable"
      role="alert"
      action={<Button onClick={retry}>Try again</Button>}
    >
      We couldn’t load your billing details.
    </EmptyState>
  );
}
/** Members never fetch billing; the backend independently enforces the same rule. */
export function BillingPage({ returned }: { readonly returned: ReturnType<typeof billingSearch> }) {
  const organization = useOrganizationRoute();
  if (organization.role === undefined) return <PageSkeleton title="Billing" />;
  if (organization.role === "member")
    return (
      <section className="page w-full shrink-0 max-w-315 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Billing
        </h1>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabledReason="Only organization owners and admins can manage billing."
          >
            Manage billing
          </Button>
          <Button disabledReason="Only organization owners and admins can change the billing plan.">
            Change plan
          </Button>
        </div>
        <EmptyState title="Billing access">
          An organization owner or admin can manage billing.
        </EmptyState>
      </section>
    );
  return <BillingDetails key={organization.organization} returned={returned} />;
}
