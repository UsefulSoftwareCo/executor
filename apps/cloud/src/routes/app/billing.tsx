import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Effect, Exit } from "effect";
import { toast } from "sonner";
import { trackEvent } from "@executor-js/react/api/analytics";
import { Button } from "@executor-js/react/components/button";
import { Badge } from "@executor-js/react/components/badge";
import { PageContainer, PageHeader } from "@executor-js/react/components/page";

type Plan = NonNullable<ReturnType<typeof useListPlans>["data"]>[number];

export const Route = createFileRoute("/{-$orgSlug}/billing")({
  component: BillingPage,
});

const PLAN_TAGLINES: Record<string, string> = {
  free: "Free for up to 3 members",
  team: "$15 per member per month",
  enterprise: "Custom enterprise agreement",
};

// Marker appended to the return URL so the page knows, on return, where it just
// came back from. `added`: the hosted card form (setup session) — the card only
// lands once the provider's webhook is processed, so wait for it. `managed`:
// the billing portal — the provider reads the default card live, so one
// refetch reflects whatever the user did there.
const CARD_RETURN_PARAM = "card";
type CardReturn = "added" | "managed";

/** The card Autumn reports as the customer's default payment method (the
 *  Stripe PaymentMethod object, expanded via `payment_method`). */
type CardOnFile = {
  readonly id: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
};

const CARD_BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
};

const cardOnFile = (paymentMethod: unknown): CardOnFile | null => {
  if (typeof paymentMethod !== "object" || paymentMethod === null) return null;
  const pm = paymentMethod as { id?: unknown; card?: unknown };
  if (typeof pm.id !== "string" || typeof pm.card !== "object" || pm.card === null) return null;
  const card = pm.card as {
    brand?: unknown;
    last4?: unknown;
    exp_month?: unknown;
    exp_year?: unknown;
    expMonth?: unknown;
    expYear?: unknown;
  };
  const expMonth = card.expMonth ?? card.exp_month;
  const expYear = card.expYear ?? card.exp_year;
  if (
    typeof card.brand !== "string" ||
    typeof card.last4 !== "string" ||
    typeof expMonth !== "number" ||
    typeof expYear !== "number"
  ) {
    return null;
  }
  return { id: pm.id, brand: card.brand, last4: card.last4, expMonth, expYear };
};

const cardBrandLabel = (brand: string): string =>
  CARD_BRANDS[brand] ?? (brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Card");

/**
 * Refresh the customer after returning from the hosted card form or the portal.
 *
 * Like checkout (see billing_.plans.tsx), the browser is redirected back from
 * the card form before Stripe's webhook reaches Autumn, so the first fetch on
 * return still shows no card. On detecting the `added` marker, poll until the
 * default payment method differs from the one we came back with (or a
 * timeout). Returns true while that reconciliation is in flight so the page can
 * show the card as updating rather than the stale one. The `managed` marker
 * (portal) has no race: a single refetch is enough.
 */
function useRefreshAfterCardUpdate(card: CardOnFile | null, refetch: () => void): boolean {
  const [previousCardId, setPreviousCardId] = useState<string | null | undefined>(undefined);
  const cardRef = useRef(card);
  cardRef.current = card;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const armedAtRef = useRef(0);

  // One-shot: consume the URL marker into state (see the plans page for why the
  // poll keys off state rather than living in this effect).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const returned = params.get(CARD_RETURN_PARAM) as CardReturn | null;
    if (returned !== "added" && returned !== "managed") return;
    params.delete(CARD_RETURN_PARAM);
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    if (returned === "managed") {
      refetchRef.current();
      return;
    }
    armedAtRef.current = Date.now();
    setPreviousCardId(cardRef.current?.id ?? null);
  }, []);

  useEffect(() => {
    if (previousCardId === undefined) return;
    const reflected = () => (cardRef.current?.id ?? null) !== previousCardId;

    refetchRef.current();
    const interval = setInterval(() => {
      if (reflected() || Date.now() - armedAtRef.current >= 20_000) {
        clearInterval(interval);
        setPreviousCardId(undefined);
        return;
      }
      refetchRef.current();
    }, 1500);
    return () => clearInterval(interval);
  }, [previousCardId]);

  useEffect(() => {
    if (previousCardId !== undefined && (card?.id ?? null) !== previousCardId) {
      setPreviousCardId(undefined);
    }
  }, [previousCardId, card]);

  return previousCardId !== undefined;
}

function BillingPage() {
  const {
    data: customer,
    openCustomerPortal,
    setupPayment,
    refetch: refetchCustomer,
    isLoading: customerLoading,
  } = useCustomer({ expand: ["payment_method"] });
  const { data: plans, isLoading: plansLoading } = useListPlans();
  const card = cardOnFile(customer?.paymentMethod);
  const cardUpdating = useRefreshAfterCardUpdate(card, refetchCustomer);
  const [openingCardForm, setOpeningCardForm] = useState(false);

  if (customerLoading || plansLoading) {
    return (
      <PageContainer>
        <div className="mb-10">
          <div className="h-8 w-28 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
      </PageContainer>
    );
  }

  const allPlans: Plan[] = plans ?? [];
  const activePlan = allPlans.find(
    (p) => p.customerEligibility?.status === "active" && p.id !== "free",
  );
  const scheduledPlan = allPlans.find(
    (p) => p.customerEligibility?.status === "scheduled" && p.id !== "free",
  );
  const isCanceling = activePlan?.customerEligibility?.canceling ?? false;
  const isSwitching = isCanceling && scheduledPlan != null;
  const isTrialing = activePlan?.customerEligibility?.trialing ?? false;

  const displayPlan = isSwitching ? scheduledPlan : activePlan;
  const planId = displayPlan?.id ?? "free";
  const planName = displayPlan?.name ?? "Free";
  const tagline = PLAN_TAGLINES[planId] ?? "";

  const sub = customer?.subscriptions?.find(
    (s) =>
      s.planId === (activePlan?.id ?? "free") && (s.status === "active" || s.status === "trialing"),
  );

  const executions = customer?.balances?.executions;
  const members = customer?.balances?.members;

  return (
    <PageContainer>
      <PageHeader title="Billing" />

      {/* Current plan */}
      <div className="flex items-center justify-between py-4">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground leading-none">{planName}</p>
            {isSwitching && <Badge className="bg-muted text-muted-foreground">Switching</Badge>}
            {isCanceling && !isSwitching && (
              <Badge className="bg-muted text-muted-foreground">Canceling</Badge>
            )}
            {isTrialing && !isCanceling && (
              <Badge className="bg-primary/10 text-primary">Free trial</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground leading-none">
            {isSwitching && sub?.currentPeriodEnd
              ? `Starts ${new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`
              : isCanceling && sub?.currentPeriodEnd
                ? `Access until ${new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`
                : isTrialing && sub?.currentPeriodEnd
                  ? `Trial ends, then billing starts ${new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`
                  : sub?.currentPeriodEnd
                    ? `Renews ${new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`
                    : tagline}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activePlan && !isCanceling && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                trackEvent("billing_cancel_plan_clicked", { plan_id: planId });
                openCustomerPortal();
              }}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              Cancel plan
            </Button>
          )}
          <Link
            to="/{-$orgSlug}/billing/plans"
            onClick={() => trackEvent("billing_manage_opened")}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Manage
          </Link>
        </div>
      </div>

      {/* Divider */}
      <div className="h-px bg-border/50 my-2" />

      {/* Payment method */}
      <div className="flex items-center justify-between py-4">
        <div>
          <p className="text-sm font-medium text-foreground leading-none">Payment method</p>
          <p className="mt-1 text-xs text-muted-foreground leading-none">
            {cardUpdating ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
                Updating card…
              </span>
            ) : card ? (
              `${cardBrandLabel(card.brand)} ending in ${card.last4} · Expires ${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`
            ) : (
              "No card on file"
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={openingCardForm || cardUpdating}
          onClick={async () => {
            trackEvent("billing_payment_method_update_clicked", { has_card: card != null });
            setOpeningCardForm(true);
            const returnTo = (marker: CardReturn) =>
              `${window.location.origin}${window.location.pathname}?${CARD_RETURN_PARAM}=${marker}`;
            // A setup session never REPLACES an existing default card at the
            // provider (it only sets one when none is on file), so changing
            // the card goes through the billing portal, where the user adds a
            // card and makes it the default. With no card yet, the hosted card
            // form sets it; its return URL is tagged so the page waits for the
            // card when the form redirects back (the webhook lands moments
            // after the redirect). Either call redirects the page on success;
            // on failure the button must come back rather than sit on
            // "Loading…" forever.
            const exit = await Effect.runPromiseExit(
              Effect.tryPromise(() =>
                card
                  ? openCustomerPortal({ returnUrl: returnTo("managed") })
                  : setupPayment({ successUrl: returnTo("added") }),
              ),
            );
            if (Exit.isFailure(exit)) {
              toast.error("Could not open the payment form. Try again.");
            }
            setOpeningCardForm(false);
          }}
          className="text-xs"
        >
          {openingCardForm ? "Loading…" : card ? "Update card" : "Add card"}
        </Button>
      </div>

      {/* Divider */}
      <div className="h-px bg-border/50 my-2" />

      {/* Usage */}
      {members && (
        <div className="py-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-foreground">Members</p>
            <p className="text-sm tabular-nums text-muted-foreground">
              {members.usage.toLocaleString()}
              {!members.unlimited && (
                <span className="text-muted-foreground">
                  {" / "}
                  {members.granted.toLocaleString()}
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      {executions && (
        <div className="py-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-foreground">Executions</p>
            <p className="text-sm tabular-nums text-muted-foreground">
              {executions.usage.toLocaleString()}
              {!executions.unlimited && (
                <span className="text-muted-foreground">
                  {" / "}
                  {executions.granted.toLocaleString()} this month
                </span>
              )}
            </p>
          </div>
          {!executions.unlimited && executions.granted > 0 && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={
                  {
                    "--progress": `${Math.min(100, (executions.usage / executions.granted) * 100)}%`,
                    width: "var(--progress)",
                  } as React.CSSProperties
                }
              />
            </div>
          )}
        </div>
      )}
    </PageContainer>
  );
}
