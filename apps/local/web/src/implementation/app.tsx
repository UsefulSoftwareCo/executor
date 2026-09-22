import type { ReactNode } from "react";
import { DashboardUnauthorized } from "@executor-js/local-server/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Cause, Option, Schema } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  UserCircleIcon,
  LaptopIcon,
  PackageIcon,
  Plug01Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import { overviewAtom } from "../contracts/api.ts";
import { bootstrapAtom, sessionAtom } from "../contracts/connection.ts";
import { Link, Outlet, useMatches } from "@tanstack/react-router";
import { usePairingLinks } from "./connection.ts";
import { cn } from "@executor-js/ui/lib/utils";
import { Button } from "@executor-js/ui/components/button";
import { Failure } from "./components/common.tsx";
import { LocalDashboard } from "./dashboard-bindings.tsx";
import { DashboardShell } from "@executor-js/ui/dashboard/shell";
import { publicDocsBaseUrl } from "@executor-js/ui/contracts/documentation";

/** Finish pairing and session checks before mounting any dashboard data consumers. */
export function AuthenticationGate({
  children,
  loading = <Connect pending />,
}: {
  readonly children: ReactNode;
  readonly loading?: ReactNode;
}) {
  usePairingLinks();
  const bootstrap = useAtomValue(bootstrapAtom);
  if (AsyncResult.isFailure(bootstrap)) return <Connect expired />;
  if (!AsyncResult.isSuccess(bootstrap)) return loading;
  return <SessionGate loading={loading}>{children}</SessionGate>;
}

function SessionGate({
  children,
  loading,
}: {
  readonly children: ReactNode;
  readonly loading: ReactNode;
}) {
  const session = useAtomValue(sessionAtom);
  if (AsyncResult.isFailure(session)) return <Connect unavailable />;
  if (!AsyncResult.isSuccess(session)) return loading;
  return session.value.authenticated ? children : <Connect />;
}

/** Only dashboard pages load inventory and navigation after authentication. */
export function DashboardLayout() {
  return (
    <AuthenticationGate>
      <LocalDashboard>
        <Dashboard />
      </LocalDashboard>
    </AuthenticationGate>
  );
}

function Connect({
  pending = false,
  expired = false,
  unavailable = false,
}: {
  pending?: boolean;
  expired?: boolean;
  unavailable?: boolean;
}) {
  return (
    <div className="connect-page min-h-dvh flex flex-col">
      <div className="connect-brand [&_img]:w-5.25 [&_img]:h-5.25 flex items-center gap-2 py-[24px] px-[30px] font-mono text-[15px] max-[740px]:p-[20px]">
        <img src="/favicon.png" alt="" />
        <span>executor</span>
        <span className="local-label font-sans text-[11px] text-muted-foreground border border-border rounded-[4px] py-[1px] px-[5px] ml-0.5">
          local
        </span>
      </div>
      <div className="connect-form flex flex-col w-[min(360px,_calc(100%_-_40px))] [margin:max(70px,_calc(23dvh_-_60px))_auto_60px] [&_h1]:text-[23px] [&_>_p]:text-[13px] [&_>_p]:text-muted-foreground [&_>_p]:[margin:9px_0_27px] [&_>_p]:leading-[1.7] [&_label]:text-[12px] [&_label]:mb-1.75 [&_label]:font-medium [&_>_button]:mt-3.5 [&_>_.form-error]:text-destructive [&_>_.form-error]:[margin:7px_0_0] [&_>_.form-error]:text-[12px]">
        <div className="connect-icon w-11.5 h-11.5 border border-border rounded-[10px] flex items-center justify-center mb-5.5">
          <HugeiconsIcon icon={LaptopIcon} aria-hidden size={24} strokeWidth={1.4} />
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          {pending
            ? "Connecting to Executor"
            : unavailable
              ? "Server unavailable"
              : "Open Executor locally"}
        </h1>
        <p>
          {pending
            ? "Starting your local session…"
            : unavailable
              ? "Check that your local server is running, then refresh this page."
              : expired
                ? "This connection link has expired or was already used."
                : "Use a connection link from your terminal to sign in. If it opens another tab, return here afterward."}
        </p>
        {!pending && !unavailable && <code>executor pair</code>}
        {unavailable && <Button onClick={() => window.location.reload()}>Retry</Button>}
      </div>
    </div>
  );
}

function Dashboard() {
  const section = useMatches({ select: (matches) => matches.at(-1)?.staticData.section });
  const result = useAtomValue(overviewAtom);
  const refresh = useAtomRefresh(overviewAtom);
  const data = AsyncResult.value(result);
  const error = AsyncResult.isFailure(result) ? Cause.findErrorOption(result.cause) : Option.none();
  if (Option.isSome(error) && Schema.is(DashboardUnauthorized)(error.value))
    return <Connect expired />;
  return (
    <DashboardShell
      docsUrl={publicDocsBaseUrl}
      brand={
        <Link
          to="/apps"
          className="wordmark flex items-center gap-2 h-12 min-w-0 font-mono text-[15px] font-medium max-[740px]:h-11 max-[740px]:shrink-0"
          aria-label="Executor home"
        >
          <span>executor</span>
        </Link>
      }
      navigation={
        <>
          <Link
            to="/connect"
            className={cn(
              section === "connect" &&
                "active [.sidebar_nav_a&]:bg-accent [.sidebar_nav_a&]:text-foreground",
            )}
          >
            <HugeiconsIcon icon={Plug01Icon} strokeWidth={2} aria-hidden size={16} />
            Connect
          </Link>
          <Link
            to="/apps"
            className={cn(
              section === "apps" &&
                "active [.sidebar_nav_a&]:bg-accent [.sidebar_nav_a&]:text-foreground",
            )}
          >
            <HugeiconsIcon icon={PackageIcon} strokeWidth={2} aria-hidden size={16} />
            Apps{Option.isSome(data) && <span>{data.value.apps.length}</span>}
          </Link>
          <Link
            to="/accounts"
            className={cn(
              section === "accounts" &&
                "active [.sidebar_nav_a&]:bg-accent [.sidebar_nav_a&]:text-foreground",
            )}
          >
            <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} aria-hidden size={16} />
            Accounts
            {Option.isSome(data) && <span>{data.value.accounts.length}</span>}
          </Link>
          <Link
            to="/approvals"
            className={cn(
              section === "approvals" &&
                "active [.sidebar_nav_a&]:bg-accent [.sidebar_nav_a&]:text-foreground",
            )}
          >
            <HugeiconsIcon icon={Shield01Icon} strokeWidth={2} aria-hidden size={16} />
            Approvals
          </Link>
        </>
      }
      footer={
        <div className="sidebar-build flex items-center justify-between gap-1.5 py-0 px-[10px] max-[740px]:p-0">
          <span className="sidebar-version text-[10px] opacity-75 max-[740px]:hidden">
            Development
          </span>
        </div>
      }
    >
      {AsyncResult.isFailure(result) && (
        <div className="page-error [padding:16px_24px_0] max-w-315 my-0 mx-auto max-[740px]:[padding:16px_16px_0]">
          <Failure cause={result.cause} retry={refresh} />
        </div>
      )}
      <Outlet />
    </DashboardShell>
  );
}
