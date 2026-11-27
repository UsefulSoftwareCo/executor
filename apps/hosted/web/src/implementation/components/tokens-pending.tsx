import { Button } from "@executor-js/ui/components/button";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";

export const tokensTitle = "Tokens";
export const tokensDescription =
  "Personal access tokens for scripts and agents. They belong to you, not to an organization.";

export function TokensIntro() {
  return (
    <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
      Tokens have your current permissions. Limit a token to one organization, or give it your full
      account so it can reach every organization you belong to. Membership and role changes apply
      automatically. Tokens stay active when you sign out.
    </p>
  );
}

export function TokenListPending() {
  return (
    <div role="status" aria-label="Loading tokens" className="overflow-x-auto">
      <table className="w-full text-left text-sm" aria-hidden>
        <thead className="border-b text-xs text-muted-foreground">
          <tr>
            {["Name", "Scope", "Last used", "Expires", "Status", ""].map((label) => (
              <th key={label} className="px-4 py-3 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="min-w-44 space-y-2 px-4 py-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-36" />
            </td>
            {["Scope", "Last used", "Expires", "Status"].map((label) => (
              <td key={label} className="px-4 py-4">
                <Skeleton className="h-3 w-20" />
              </td>
            ))}
            <td className="px-4 py-4">
              <Button variant="outline" size="sm" disabled>
                Revoke
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
      <span className="sr-only">Loading tokens…</span>
    </div>
  );
}

export function TokensPending() {
  return (
    <PageFrame>
      <PageHeader title={tokensTitle} description={tokensDescription}>
        <Button disabled>Create token</Button>
      </PageHeader>
      <TokensIntro />
      <div className="overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Your tokens</h2>
          <Button variant="ghost" size="sm" disabled>
            Refresh
          </Button>
        </div>
        <TokenListPending />
      </div>
    </PageFrame>
  );
}
