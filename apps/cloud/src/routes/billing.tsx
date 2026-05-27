import { createFileRoute, Link } from "@tanstack/react-router";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Button } from "@executor-js/react/components/button";
import { Badge } from "@executor-js/react/components/badge";

type Plan = NonNullable<ReturnType<typeof useListPlans>["data"]>[number];

export const Route = createFileRoute("/billing")({
  component: BillingPage,
});

const PLAN_TAGLINES: Record<string, string> = {
  free: "Free for up to 3 members",
  team: "$49 per organization",
  enterprise: "Custom enterprise agreement",
};

function BillingPage() {
  const { data: customer, openCustomerPortal, isLoading: customerLoading } = useCustomer();
  const { data: plans, isLoading: plansLoading } = useListPlans();

  if (customerLoading || plansLoading) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
          <div className="mb-10">
            <div className="h-8 w-28 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-16 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none mb-10">
          Billing
        </h1>

        {/* Current plan */}
        <div className="flex items-center justify-between py-4">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-foreground leading-none">{planName}</p>
              {isSwitching && (
                <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  Switching
                </Badge>
              )}
              {isCanceling && !isSwitching && (
                <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  Canceling
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground leading-none">
              {isSwitching && sub?.currentPeriodEnd
                ? `Starts ${new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`
                : isCanceling && sub?.currentPeriodEnd
                  ? `Access until ${new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`
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
                onClick={() => openCustomerPortal()}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
              >
                Cancel plan
              </Button>
            )}
            <Link
              to="/billing/plans"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Manage
            </Link>
          </div>
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
                <span className="text-muted-foreground">
                  {" / "}
                  {executions.granted.toLocaleString()} this month
                </span>
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
      </div>
    </div>
  );
}
