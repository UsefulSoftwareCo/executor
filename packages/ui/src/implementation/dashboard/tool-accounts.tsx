import type { App } from "@executor-js/sdk";
import { selectedAccountLabels, type AccountSummary } from "../../contracts/dashboard.ts";
import { useDashboard } from "./context.tsx";

/** Identify the actual saved account context; several accounts still produce one app catalog. */
export function ToolAccounts({
  app,
  accounts,
  compact = false,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly compact?: boolean;
}) {
  const { AppLink, AccountLink } = useDashboard();
  const selected = selectedAccountLabels(app, accounts);
  return (
    <div
      aria-label="Tool account context"
      className={
        compact
          ? "flex flex-wrap items-center gap-x-1.5 gap-y-1 py-3 text-xs text-muted-foreground"
          : "flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-2 border-b px-4 py-3 text-xs text-muted-foreground"
      }
    >
      <span>
        {selected.length > 0
          ? compact
            ? "For"
            : "Tools for"
          : Object.keys(app.requirements.accounts).length === 0
            ? "No account required"
            : "No accounts selected"}
      </span>
      {selected.map(({ id, label }, index) => (
        <span key={id} className="inline-flex items-center gap-1.5">
          {index > 0 && <span>+</span>}
          <span className="text-foreground [&_a]:underline-offset-4 [&_a:hover]:underline">
            <AccountLink account={id}>{label}</AccountLink>
          </span>
        </span>
      ))}
      {selected.length > 1 && (
        <span className="ml-1 text-muted-foreground">· Combined catalog</span>
      )}
      {!compact && Object.keys(app.requirements.accounts).length > 0 && (
        <AppLink
          app={app.id}
          view="accounts"
          className="ml-auto text-foreground underline underline-offset-4"
        >
          Manage accounts
        </AppLink>
      )}
    </div>
  );
}
