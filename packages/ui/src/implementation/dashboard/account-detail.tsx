import { EmptyState } from "./empty-state.tsx";
import type { Account, App } from "@executor-js/sdk";
import { Exit, type Cause } from "effect";
import { useState, type ComponentType, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { AccountDetail, FailureProps } from "../../contracts/dashboard.ts";
import { providerDisplayUrl } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { ProviderIcon, SectionHeading } from "./common.tsx";
import { useDashboard } from "./context.tsx";
import { productTitle, useDocumentTitle } from "../hooks/document-title.ts";

/** Products supply authority and navigation; the view has no organization or role model. */
export function AccountDetails<E>({
  data,
  rename,
  Failure,
  signInAction,
  disconnectAction,
  readOnlyMessage,
  children,
}: {
  readonly data: AccountDetail;
  readonly rename: (label: string) => Promise<Exit.Exit<Account, E>>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly signInAction: ReactNode;
  readonly disconnectAction: ReactNode;
  readonly readOnlyMessage: ReactNode;
  readonly children?: ReactNode;
}) {
  const { account, provider, apps, canManage } = data;
  const [draftLabel, setLabel] = useState<string>();
  const label = draftLabel ?? account.label;
  useDocumentTitle(productTitle(account.label || "Account"));
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  const oauth = provider.definition.auth[account.method]?.type === "oauth2";
  return (
    <>
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <div className="account-heading flex items-center gap-3.75 min-w-0 [&_>_div]:min-w-0 [&_h1]:wrap-anywhere">
          <ProviderIcon
            name={provider.definition.name}
            url={providerDisplayUrl(provider.definition)}
            large
          />
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
              {account.label || "Unnamed account"}
            </h1>
            <p>
              {provider.definition.name} · {oauth ? "OAuth" : account.method}
            </p>
          </div>
        </div>
        {canManage && <div className="shrink-0">{signInAction}</div>}
      </div>
      <div className="account-detail max-w-145">
        {canManage ? (
          <form
            className="setup-form max-w-145 flex flex-col gap-5.75 pt-2.5 max-[740px]:gap-5.25"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending || !label.trim()) return;
              setPending(true);
              setError(undefined);
              setSaved(false);
              const exit = await rename(label.trim());
              setPending(false);
              if (Exit.isFailure(exit)) {
                setError(exit.cause);
                return;
              }
              setLabel(undefined);
              setSaved(true);
            }}
          >
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
              Account name
              <Input
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setSaved(false);
                }}
                required
                pattern=".*\S.*"
                maxLength={120}
                disabled={pending}
              />
            </label>
            {error && <Failure cause={error} />}
            <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px]">
              <Button type="submit" loading={pending}>
                Save name
              </Button>
              {saved && (
                <span className="muted text-muted-foreground" role="status">
                  Saved
                </span>
              )}
            </div>
          </form>
        ) : (
          <p className="muted text-muted-foreground">{readOnlyMessage}</p>
        )}
        <section className="account-section border-t border-t-border mt-7.5 pt-5.5">
          <SectionHeading>
            Used by <span className="muted text-muted-foreground">{apps.length}</span>
          </SectionHeading>
          <AccountApps apps={apps} />
        </section>
        {children}
        {canManage && (
          <div className="account-disconnect mt-6.5 border-t border-t-border pt-4.5 [&_a]:text-destructive">
            {disconnectAction}
          </div>
        )}
      </div>
    </>
  );
}

/** Show affected apps before deleting credentials, using the host's typed mutation. */
export function DisconnectAccount<E>({
  data,
  disconnect,
  onDisconnected,
  cancel,
  Failure,
  title = "Disconnect account?",
  submitLabel = "Disconnect account",
  impact,
}: {
  readonly title?: string;
  readonly submitLabel?: string;
  readonly impact?: ReactNode;
  readonly data: AccountDetail;
  readonly disconnect: () => Promise<Exit.Exit<unknown, E>>;
  readonly onDisconnected: () => void;
  readonly cancel: ReactNode;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
}) {
  const { account, provider, apps } = data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<E>>();
  return (
    <>
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          {title}
        </h1>
      </div>
      <div className="setup-form max-w-145 flex flex-col gap-5.75 pt-2.5 max-[740px]:gap-5.25">
        <div className="setup-provider flex items-center gap-3.25 [&_h2]:text-[16px] [&_h2]:[font-weight:550] [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere">
          <ProviderIcon
            name={provider.definition.name}
            url={providerDisplayUrl(provider.definition)}
            large
          />
          <h2>{account.label || "Unnamed account"}</h2>
        </div>
        <p>
          This deletes the saved credentials from Executor. It does not revoke access at{" "}
          {provider.definition.name}.
        </p>
        <section>
          <SectionHeading>
            Affected apps <span className="muted text-muted-foreground">{apps.length}</span>
          </SectionHeading>
          <AccountApps apps={apps} />
          {impact ??
            (apps.length > 0 && (
              <p className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
                These apps will need an account selected before they can run.
              </p>
            ))}
        </section>
        {error && <Failure cause={error} />}
        <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px]">
          <Button
            variant="destructive"
            loading={pending}
            onClick={async () => {
              if (pending) return;
              setPending(true);
              setError(undefined);
              const exit = await disconnect();
              setPending(false);
              if (Exit.isFailure(exit)) {
                setError(exit.cause);
                return;
              }
              onDisconnected();
            }}
          >
            {submitLabel}
          </Button>
          {cancel}
        </div>
      </div>
    </>
  );
}

/** Account selections are edited on the app itself. */
export function AccountApps({ apps }: { readonly apps: readonly App[] }) {
  const { AppLink } = useDashboard();
  return apps.length === 0 ? (
    <EmptyState size="compact" heading="h3" title="No connected apps">
      No apps use this account.
    </EmptyState>
  ) : (
    <div className="account-apps flex flex-col [&_>_a]:flex [&_>_a]:items-center [&_>_a]:justify-between [&_>_a]:gap-3 [&_>_a]:py-[13px] [&_>_a]:px-0 [&_>_a]:text-[14px] [&_>_a_+_a]:border-t [&_>_a_+_a]:border-t-border [&_>_a_>_span]:wrap-anywhere [&_>_a_>_span]:min-w-0 [&_>_a_>_svg]:shrink-0 [&_>_a_>_svg]:text-muted-foreground">
      {apps.map((app) => (
        <AppLink key={app.id} app={app.id} view="accounts">
          <span>{app.name}</span>
          <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} aria-hidden size={14} />
        </AppLink>
      ))}
    </div>
  );
}
