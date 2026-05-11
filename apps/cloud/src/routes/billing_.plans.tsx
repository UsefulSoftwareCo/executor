import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Button } from "@executor-js/react/components/button";
import { Badge } from "@executor-js/react/components/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@executor-js/react/components/dialog";

type Plan = NonNullable<ReturnType<typeof useListPlans>["data"]>[number];

export const Route = createFileRoute("/billing_/plans")({
  component: PlansPage,
});

const PLAN_META: Record<string, { tagline: string; inherits?: string; features: string[] }> = {
  free: {
    tagline: "For small teams getting started",
    features: [
      "Up to 3 members",
      "10,000 included executions per month",
      "$0.20 per 1,000 additional executions",
      "Unlimited sources",
    ],
  },
  team: {
    tagline: "For growing organizations",
    features: [
      "Unlimited members",
      "250,000 included executions per month",
      "5 minute execution timeout",
      "Join by team domain",
      "$0.20 per 1,000 additional executions",
    ],
  },
};

const ACTION_LABELS: Record<string, string> = {
  activate: "Subscribe",
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  none: "Current plan",
  purchase: "Purchase",
};

const ENTERPRISE_FEATURES = [
  "Self-hosted or dedicated cloud deployment support",
  "SSO / SAML & SCIM provisioning",
  "Audit logs for every tool call",
  "Dedicated support & onboarding",
  "Security reviews, DPA & SOC 2 on request",
];

const ENTERPRISE_MAILTO = `mailto:rhys@executor.sh?subject=${encodeURIComponent(
  "Executor Enterprise inquiry",
)}&body=${encodeURIComponent(
  [
    "Hi,",
    "",
    "We're interested in Executor Enterprise.",
    "",
    "Company:",
    "Team size:",
    "Use case:",
    "Requirements (SSO, self-hosted, compliance, etc.):",
  ].join("\n"),
)}`;

function PlansPage() {
  const { attach, openCustomerPortal, isLoading: customerLoading } = useCustomer();
  const { data: plans, isLoading: plansLoading, isFetching } = useListPlans();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);

  const isLoading = customerLoading || plansLoading;

  const selfServePlans = (plans ?? ([] as Plan[])).filter(
    (p: Plan) => p.id === "free" || p.id === "team",
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8">
          <Link
            to="/billing"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
              <path
                d="M10 4L6 8l4 4"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Billing
          </Link>
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Choose a plan
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Pick the plan that works for you. Upgrade or downgrade anytime.
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
          </div>
        ) : (
          <div
            className={[
              "grid gap-4 grid-cols-1 md:grid-cols-3 transition-opacity",
              isFetching ? "opacity-50 pointer-events-none" : "",
            ].join(" ")}
          >
            {selfServePlans.map((plan: Plan) => {
              const meta = PLAN_META[plan.id];
              if (!meta) return null;

              const eligibility = plan.customerEligibility;
              const action = eligibility?.attachAction ?? "activate";
              const status = eligibility?.status;
              const isCanceling = eligibility?.canceling ?? false;
              const isCurrent = status === "active" && !isCanceling;
              const isScheduled = status === "scheduled";
              const label = isCanceling ? "Resume" : (ACTION_LABELS[action] ?? "Select");
              const isUpgradeAction = action === "upgrade" || action === "activate";

              return (
                <div
                  key={plan.id}
                  className={[
                    "flex flex-col rounded-xl border p-5",
                    isCurrent
                      ? "border-emerald-500/30 bg-emerald-500/[0.03]"
                      : isScheduled
                        ? "border-emerald-500/30 bg-emerald-500/[0.03]"
                        : "border-border",
                  ].join(" ")}
                >
                  <div className="flex h-6 items-center justify-between">
                    <p className="text-base font-semibold text-foreground leading-none">
                      {plan.name}
                    </p>
                    {isCurrent && (
                      <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        Your plan
                      </Badge>
                    )}
                    {isCanceling && (
                      <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                        Canceling
                      </Badge>
                    )}
                    {isScheduled && (
                      <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        Scheduled
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{meta.tagline}</p>

                  <div className="mt-4 flex items-baseline gap-1.5">
                    <span className="text-2xl font-semibold text-foreground tabular-nums">
                      ${plan.price?.amount ?? 0}
                    </span>
                    {plan.price?.interval && (
                      <span className="text-sm text-muted-foreground">
                        USD / org / {plan.price.interval}
                      </span>
                    )}
                    {!plan.price?.interval && (
                      <span className="text-sm text-muted-foreground">USD</span>
                    )}
                  </div>

                  <div className="mt-4">
                    {(isCurrent && !isCanceling) || isScheduled ? (
                      <div className="flex h-9 items-center justify-center rounded-md border border-border bg-muted/30 text-sm font-medium text-muted-foreground">
                        {isCurrent ? "Current plan" : "Scheduled"}
                      </div>
                    ) : isCanceling ? (
                      <Button
                        type="button"
                        disabled={loadingPlan !== null}
                        onClick={() => openCustomerPortal()}
                        className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                      >
                        Resume
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        disabled={loadingPlan !== null}
                        onClick={async () => {
                          setLoadingPlan(plan.id);
                          await attach({ planId: plan.id, redirectMode: "always" });
                          setLoadingPlan(null);
                        }}
                        className={[
                          "flex h-9 w-full items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-60",
                          isUpgradeAction
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "border border-border bg-background text-foreground hover:bg-muted",
                        ].join(" ")}
                      >
                        {loadingPlan === plan.id ? "Loading…" : label}
                      </Button>
                    )}
                  </div>

                  {meta.inherits && (
                    <p className="mt-5 text-xs font-medium text-foreground">
                      Everything in {meta.inherits}, plus
                    </p>
                  )}
                  <ul
                    role="list"
                    className={["space-y-2", meta.inherits ? "mt-2" : "mt-5"].join(" ")}
                  >
                    {meta.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          className="mt-px size-3.5 shrink-0 text-primary/60"
                        >
                          <path
                            d="M3.5 8.5L6.5 11.5L12.5 5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}

            <div className="flex flex-col rounded-xl border border-border p-5">
              <div className="flex h-6 items-center justify-between">
                <p className="text-base font-semibold text-foreground leading-none">Enterprise</p>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">For orgs with custom needs</p>

              <div className="mt-4 flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold text-foreground tabular-nums">Custom</span>
              </div>

              <div className="mt-4">
                <a
                  href={ENTERPRISE_MAILTO}
                  className="flex h-9 w-full items-center justify-center rounded-md border border-border bg-background text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  Contact us
                </a>
              </div>

              <p className="mt-5 text-xs font-medium text-foreground">Everything in Team, plus</p>
              <ul role="list" className="mt-2 space-y-2">
                {ENTERPRISE_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      className="mt-px size-3.5 shrink-0 text-primary/60"
                    >
                      <path
                        d="M3.5 8.5L6.5 11.5L12.5 5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <SlackContactCta />
      </div>
    </div>
  );
}

function SlackContactCta() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-10 flex flex-col items-center gap-3 border-t border-border pt-8 text-center">
      <p className="text-sm text-muted-foreground">Got questions?</p>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm font-medium">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-foreground hover:text-primary"
            >
              <SlackMark className="size-4" />
              Get in touch on Slack
              <span aria-hidden>→</span>
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Get in touch on Slack</DialogTitle>
              <DialogDescription>
                Add{" "}
                <a className="font-medium text-foreground underline" href="mailto:rhys@executor.sh">
                  rhys@executor.sh
                </a>{" "}
                on Slack Connect to get in touch.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Done
                </Button>
              </DialogClose>
              <Button asChild>
                <a href="mailto:rhys@executor.sh?subject=Executor%20Slack%20invite">
                  Email for invite
                </a>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <span className="text-muted-foreground/60" aria-hidden>
          ·
        </span>
        <a
          href="mailto:rhys@executor.sh?subject=Executor%20question"
          className="inline-flex items-center gap-1.5 text-foreground hover:text-primary transition-colors"
        >
          <MailIcon className="size-4" />
          Email us
          <span aria-hidden>→</span>
        </a>
      </div>
    </div>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 7l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
      />
    </svg>
  );
}

function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
        fill="#E01E5A"
      />
      <path
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.527 2.527 0 0 1 2.521 2.521 2.527 2.527 0 0 1-2.521 2.521H2.522A2.527 2.527 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
        fill="#36C5F0"
      />
      <path
        d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.272 0a2.528 2.528 0 0 1-2.521 2.521 2.527 2.527 0 0 1-2.521-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.521 2.522v6.312z"
        fill="#2EB67D"
      />
      <path
        d="M15.163 18.956a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.521-2.522v-2.522h2.521zm0-1.272a2.527 2.527 0 0 1-2.521-2.521 2.527 2.527 0 0 1 2.521-2.521h6.315A2.527 2.527 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.521h-6.315z"
        fill="#ECB22E"
      />
    </svg>
  );
}
