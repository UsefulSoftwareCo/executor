import { createFileRoute, Link } from "@tanstack/react-router";
import { Exit } from "effect";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { trackEvent } from "@executor-js/react/api/analytics";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useCustomer } from "autumn-js/react";
import { toast } from "sonner";
import { orgDomainWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { Button } from "@executor-js/react/components/button";
import { Badge } from "@executor-js/react/components/badge";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@executor-js/react/components/dropdown-menu";
import { OrgPage as SharedOrgPage } from "@executor-js/react/pages/org";
import { orgDomainsAtom, getDomainVerificationLink, deleteDomain } from "../../web/org-atoms";

// ---------------------------------------------------------------------------
// Cloud organization page. The members / roles / invite / org-name surface is
// the SHARED `@executor-js/react` OrgPage over the provider-neutral
// `/account/*` atoms — identical to self-host. Cloud composes its WorkOS-only
// extras AROUND that page:
//   - a seat/billing banner (Autumn member-limit upsell)
//   - the WorkOS domain-verification section (over the surviving cloud-local
//     `/org/domains` endpoints)
// These are cloud additions, not a fork of the shared page.
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/{-$orgSlug}/org")({
  component: OrgPage,
});

type DomainData = {
  id: string;
  domain: string;
  state: string;
  verificationToken?: string;
  verificationPrefix?: string;
};

function OrgPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Shared members / roles / invite / org-name surface. */}
      <SharedOrgPage
        domainsSection={<DomainsSection />}
        upgradeAction={
          <Link to="/{-$orgSlug}/billing/plans">
            <Button size="sm">Upgrade plan</Button>
          </Link>
        }
      />
    </div>
  );
}

function DomainsSection() {
  const domainsResult = useAtomValue(orgDomainsAtom);
  const doDeleteDomain = useAtomSet(deleteDomain, { mode: "promiseExit" });
  const doGetVerificationLink = useAtomSet(getDomainVerificationLink, {
    mode: "promiseExit",
  });
  const { check, isLoading: customerLoading } = useCustomer();
  const canUseDomains = customerLoading
    ? false
    : check({ featureId: "domain-verification" }).allowed;

  const handleDeleteDomain = async (domainId: string, domain: string) => {
    const exit = await doDeleteDomain({
      params: { domainId },
      reactivityKeys: orgDomainWriteKeys,
    });
    trackEvent("org_domain_removed", { success: Exit.isSuccess(exit) });
    toast[Exit.isSuccess(exit) ? "success" : "error"](
      Exit.isSuccess(exit) ? `Removed ${domain}` : "Failed to remove domain",
    );
  };

  const handleAddDomain = async () => {
    const exit = await doGetVerificationLink({
      reactivityKeys: orgDomainWriteKeys,
    });
    trackEvent("org_domain_added", { success: Exit.isSuccess(exit) });
    if (Exit.isSuccess(exit)) {
      window.open(exit.value.link, "_blank");
    } else {
      toast.error("Failed to generate verification link");
    }
  };

  return (
    <section className="mb-2">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-medium text-foreground">Domains</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Verify a domain to let anyone with a matching email join automatically.
          </p>
        </div>
        <Button size="sm" className="min-w-32" disabled={!canUseDomains} onClick={handleAddDomain}>
          Add domain
        </Button>
      </div>

      {!canUseDomains && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Join by domain is available on the Team plan.
          </p>
          <Link to="/{-$orgSlug}/billing/plans">
            <Button size="sm" variant="outline">
              Upgrade
            </Button>
          </Link>
        </div>
      )}

      {AsyncResult.match(domainsResult, {
        onInitial: () => (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/50" />
            ))}
          </div>
        ),
        onFailure: () => (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <p className="text-sm text-destructive">Failed to load domains</p>
          </div>
        ),
        onSuccess: ({ value }) => {
          if (value.domains.length === 0) {
            if (!canUseDomains) return null;
            return (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No domains yet. Add your company domain so members can join without an invite.
              </p>
            );
          }

          return (
            <div className="space-y-2">
              {value.domains.map((d: DomainData) => (
                <DomainCard
                  key={d.id}
                  domain={d}
                  onDelete={() => handleDeleteDomain(d.id, d.domain)}
                />
              ))}
            </div>
          );
        },
      })}
    </section>
  );
}

function DomainCard({ domain: d, onDelete }: { domain: DomainData; onDelete: () => void }) {
  const isVerified = d.state === "verified";
  const isPending = d.state === "pending";

  const recordValue = d.verificationPrefix
    ? `${d.verificationPrefix}=${d.verificationToken}`
    : (d.verificationToken ?? "");

  const copyPromptValue = `Add a DNS TXT record for domain verification:\n\nDomain: ${d.domain}\nRecord name: @\nRecord value: ${recordValue}\n\nPlease add this TXT record to my DNS configuration.`;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{d.domain}</p>
            <Badge
              className={
                isVerified
                  ? "bg-muted text-foreground"
                  : isPending
                    ? "bg-muted text-muted-foreground"
                    : "bg-destructive/10 text-destructive"
              }
            >
              {isVerified ? "Verified" : isPending ? "Pending" : "Failed"}
            </Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7">
                <svg viewBox="0 0 16 16" className="size-3">
                  <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                  <circle cx="8" cy="13" r="1.2" fill="currentColor" />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive text-sm"
                onClick={onDelete}
              >
                Remove domain
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {!isVerified && d.verificationToken && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Add this TXT record to your DNS provider to verify ownership.
            </p>
            <CopyButton value={copyPromptValue} label="Copy prompt" />
          </div>
          <div className="mt-3 grid grid-cols-[4rem_3.5rem_1fr] items-center gap-y-2">
            <p className="text-xs font-medium text-muted-foreground">Type</p>
            <p className="text-xs font-medium text-muted-foreground">Name</p>
            <p className="text-xs font-medium text-muted-foreground">Value</p>
            <p className="text-sm font-mono text-foreground">TXT</p>
            <p className="text-sm font-mono text-foreground">@</p>
            <span className="inline-flex min-w-0 items-center gap-1">
              <code className="truncate text-sm font-mono text-foreground">{recordValue}</code>
              <CopyButton value={recordValue} />
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            DNS changes can take up to 72 hours to propagate, but usually complete within a few
            minutes.
          </p>
        </div>
      )}
    </div>
  );
}
