/** A launch-time profile choice leaves arbitrary authored layouts untouched. */
import type { ReactNode } from "react";
import type { App } from "@executor-js/sdk";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "../components/button.tsx";
import { appLaunchUrl, type AppReturnPath } from "../../contracts/app-launch.ts";
import { appToolReadiness, type AccountSummary } from "../../contracts/dashboard.ts";
import type { AccountContext } from "./account-group.tsx";
/** Only enabled and complete selections can open; account changes remain in Accounts. */
export function AppLaunch({
  app,
  origin,
  returnTo,
  contexts,
  accounts,
  manage,
}: {
  readonly app: App;
  readonly origin: string;
  readonly returnTo: AppReturnPath;
  readonly contexts: readonly AccountContext[];
  readonly accounts: readonly AccountSummary[];
  readonly manage: ReactNode;
}) {
  const available = contexts.filter(
    (context) => appToolReadiness(context.app, accounts).state === "ready",
  );
  return (
    <section className="mx-auto w-full max-w-lg px-6 py-10">
      <h1 className="text-xl font-semibold">Open {app.name}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {available.length === 0
          ? "Choose accounts in Accounts to open this app."
          : available.some((context) => context.profile !== undefined)
            ? "Choose a profile to open. Each uses its saved accounts."
            : "Open the app below."}
      </p>
      <div className="mt-6 divide-y rounded-lg border empty:hidden">
        {available.map((context) => (
          <a
            key={context.key}
            href={appLaunchUrl(origin, returnTo, context.profile?.id, window.location.hash)}
            className="flex min-h-12 items-center justify-between gap-4 px-4 py-3 text-sm font-medium hover:bg-muted focus-visible:outline-ring"
          >
            <span className="min-w-0 truncate">{context.label}</span>
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} aria-hidden />
          </a>
        ))}
      </div>
      <Button className="mt-5" variant="ghost" size="sm" asChild>
        {manage}
      </Button>
    </section>
  );
}
