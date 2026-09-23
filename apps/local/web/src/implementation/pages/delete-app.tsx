import type { DashboardError } from "../../contracts/errors.ts";
import { Exit } from "effect";
import { QueryView } from "@executor-js/ui/dashboard/context";
import type { DashboardApp } from "@executor-js/local-server/contracts";
import { useAtomSet } from "@effect/atom-react";
import type { AppId } from "@executor-js/sdk";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import type { Cause } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { appAtom } from "../../contracts/api.ts";
import { deleteAppAtom } from "../../contracts/onboarding.ts";
import { Empty, Failure, LoadingRows, ProviderIcon } from "../components/common.tsx";
import { Button } from "@executor-js/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";

/** Confirm a specific app on its own page; deletion never includes saved account credentials. */
export function DeleteAppPage({ id }: { readonly id: AppId }) {
  return (
    <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <Link
        className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        to="/apps/$appId"
        params={{ appId: id }}
        search={{ view: "settings" }}
      >
        <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} aria-hidden size={14} />
        Settings
      </Link>
      <QueryView key={id} query={appAtom(id)} Failure={Failure} pending={<LoadingRows />}>
        {(data) => <DeleteAppConfirmation id={id} data={data} />}
      </QueryView>
    </div>
  );
}

function DeleteAppConfirmation({ id, data }: { readonly id: AppId; readonly data: DashboardApp }) {
  const navigate = useNavigate();
  const remove = useAtomSet(deleteAppAtom(id), { mode: "promiseExit" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Cause.Cause<DashboardError>>();
  const { app, canDelete } = data;
  if (!canDelete)
    return (
      <Empty title="Managed by Executor">
        This app is part of the local server.{" "}
        <Link to="/apps/$appId" params={{ appId: id }} search={{ view: "settings" }}>
          Return to settings
        </Link>
      </Empty>
    );
  const provider = Object.values(app.requirements.accounts)[0]?.definition;
  const confirm = () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    void remove().then((exit) => {
      setPending(false);
      if (Exit.isFailure(exit)) {
        setError(exit.cause);
        return;
      }

      void navigate({ to: "/apps" });
    });
  };
  return (
    <>
      <div className="page-heading gap-4 flex justify-between items-center min-h-12 mb-4.5 [&_p]:text-muted-foreground [&_p]:text-[13px] [&_p]:mt-1.25 [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere max-[740px]:items-start max-[740px]:mb-4.5 max-[740px]:[&_p]:leading-[1.6] max-[740px]:[&_>_[data-slot='button']]:mt-0.25 max-[740px]:[.setup-page_&]:min-h-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Delete app?
        </h1>
      </div>
      <div className="setup-form max-w-145 flex flex-col gap-5.75 pt-2.5 max-[740px]:gap-5.25">
        <div className="setup-provider flex items-center gap-3.25 [&_h2]:text-[16px] [&_h2]:[font-weight:550] [&_>_div]:min-w-0 [&_>_div]:wrap-anywhere">
          <ProviderIcon
            name={provider?.name ?? app.name}
            url={providerDisplayUrl(provider)}
            large
          />
          <h2>{app.name}</h2>
        </div>
        <p>
          This deletes this app and its account selections. Saved accounts and other apps are kept.
        </p>
        {error && <Failure cause={error} />}
        <div className="form-actions flex items-center gap-5 pt-1 text-[13px] [&_a]:text-muted-foreground max-[740px]:[&_>_a]:min-h-11 max-[740px]:[&_>_a]:inline-flex max-[740px]:[&_>_a]:items-center max-[740px]:flex-wrap max-[740px]:gap-[12px_20px]">
          <Button variant="destructive" loading={pending} onClick={confirm}>
            Delete app
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void navigate({
                to: "/apps/$appId",
                params: { appId: id },
                search: { view: "settings" },
              })
            }
          >
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
}
