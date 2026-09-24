import { UserPicker } from "./users.tsx";
import { stopImpersonatingAtom } from "./auth.ts";
import { LoopbackOrigin } from "@executor-js/utils/url-policy";
/** Shared floating shell; each development server supplies its own capabilities. */
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@executor-js/ui/components/button";
import { Effect, Exit, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { Popover } from "radix-ui";
import { useState, type ReactNode } from "react";
import { DevtoolsState, DevtoolsSuccess, type OperatorIdentity } from "./contracts.ts";

class DevtoolsUnavailable extends Schema.TaggedError<DevtoolsUnavailable>()(
  "DevtoolsUnavailable",
  {},
) {}
const runtime = Atom.runtime(FetchHttpClient.layer);
const stateAtom = runtime
  .atom(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("/api/devtools");
      if (response.status === 404) return null;
      if (response.status !== 200) return yield* new DevtoolsUnavailable();
      return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DevtoolsState)));
    }).pipe(Effect.mapError(() => new DevtoolsUnavailable())),
  )
  .pipe(Atom.refreshOnWindowFocus);

type Action = { readonly kind: "operator" | "pair" };

const actionAtom = runtime.fn((action: Action) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`/api/devtools/${action.kind}`).pipe(
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    if (response.status !== 200) return yield* new DevtoolsUnavailable();
    yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DevtoolsSuccess)));
  }).pipe(Effect.mapError(() => new DevtoolsUnavailable())),
);

const hosts = { "self-host": "Self-host", cloud: "Cloud", local: "Local" };

function Widget({
  onSessionChange,
  identity,
}: {
  readonly onSessionChange?: (() => void) | undefined;
  readonly identity?: OperatorIdentity | null | undefined;
}) {
  const state = useAtomValue(stateAtom);
  const refresh = useAtomRefresh(stateAtom);
  const pending = useAtomValue(actionAtom);
  const submit = useAtomSet(actionAtom, { mode: "promiseExit" });
  const [error, setError] = useState<string | null>(null);
  const capability = AsyncResult.isSuccess(state) ? state.value : null;
  const run = async (action: Action) => {
    setError(null);
    const result = await submit(action);
    if (Exit.isFailure(result)) {
      setError("Could not enable dev tools. Check the dev server and try again.");
      refresh();
    } else {
      onSessionChange?.();
      window.location.reload();
    }
  };
  if (onSessionChange)
    return (
      <HostedTools
        onSessionChange={onSessionChange}
        identity={identity}
        development={capability?.kind === "operator" ? () => run({ kind: "operator" }) : undefined}
        pending={pending.waiting}
        error={error}
      />
    );
  if (!capability) return null;
  return (
    <DevtoolsShell subtitle={`${hosts[capability.host]} · Development`} onOpen={refresh}>
      {capability.kind === "pairing" && (
        <>
          <h2 className="mb-3 text-sm font-semibold">Browser pairing</h2>
          <Button
            className="w-full"
            disabled={pending.waiting || capability.paired}
            loading={pending.waiting}
            onClick={() => run({ kind: "pair" })}
          >
            {capability.paired ? "Browser connected" : "Skip pairing"}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </DevtoolsShell>
  );
}

function HostedTools({
  development,
  identity,
  onSessionChange,
  pending = false,
  error,
}: {
  readonly onSessionChange: () => void;
  readonly identity?: OperatorIdentity | null | undefined;
  readonly development?: (() => Promise<void>) | undefined;
  readonly pending?: boolean;
  readonly error?: string | null;
}) {
  const stop = useAtomSet(stopImpersonatingAtom, { mode: "promiseExit" });
  const stopping = useAtomValue(stopImpersonatingAtom);
  const [failure, setFailure] = useState<string | null>(null);
  if (identity?.session?.impersonatedBy)
    return (
      <DevtoolsShell subtitle="Impersonating" persistent>
        <p className="text-xs font-semibold text-amber-600">Impersonating</p>
        <p className="mt-1 truncate text-sm font-medium">{identity.user.name}</p>
        <p className="truncate text-xs text-muted-foreground">{identity.user.email}</p>
        <Button
          className="mt-3 w-full"
          disabled={stopping.waiting}
          loading={stopping.waiting}
          onClick={async () => {
            setFailure(null);
            const result = await stop();
            if (Exit.isFailure(result))
              setFailure("Could not restore your session. Try again or sign in again.");
            else {
              onSessionChange();
              window.location.assign("/");
            }
          }}
        >
          Return to my account
        </Button>
        {failure && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {failure}
          </p>
        )}
      </DevtoolsShell>
    );
  if (identity?.user.role?.split(",").includes("admin"))
    return (
      <DevtoolsShell subtitle={window.location.hostname}>
        <UserPicker currentUser={identity.user.id} onSessionChange={onSessionChange} />
      </DevtoolsShell>
    );
  if (!development) return null;
  return (
    <DevtoolsShell subtitle="Local development">
      <p className="mb-3 text-sm text-muted-foreground">
        Sign in as the local developer to impersonate users.
      </p>
      <Button className="w-full" disabled={pending} loading={pending} onClick={development}>
        Enable dev tools
      </Button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </DevtoolsShell>
  );
}

/** One floating shell for development controls and authorized cloud operations. */
function DevtoolsShell({
  children,
  subtitle,
  onOpen,
  persistent = false,
}: {
  readonly children: ReactNode;
  readonly subtitle: string;
  readonly onOpen?: () => void;
  readonly persistent?: boolean;
}) {
  if (persistent)
    return (
      <aside
        aria-label="Executor dev tools"
        className="fixed right-4 bottom-4 z-80 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-amber-500 bg-background p-4 text-foreground shadow-xl"
      >
        <h2 className="mb-3 text-sm font-semibold">Executor dev tools</h2>
        {children}
      </aside>
    );
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <Popover.Trigger asChild>
        <Button
          variant="outline"
          className="executor-devtools-trigger fixed right-[max(18px,_env(safe-area-inset-right))] bottom-[max(18px,_env(safe-area-inset-bottom))] z-80 w-10.5 h-10.5 p-[9px] rounded-[50%] bg-background [box-shadow:0_4px_16px_#0003] [&_img]:w-6 [&_img]:h-6 [&_img]:rounded-[50%]"
          aria-label="Open Executor dev tools"
          title="Executor dev tools"
        >
          <img src="/favicon.png" alt="" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="executor-devtools-panel z-81 w-[min(350px,_calc(100vw_-_32px))] max-h-[min(600px,_var(--radix-popover-content-available-height))] overflow-auto p-[18px] border border-border rounded-[14px] bg-background text-foreground [box-shadow:0_12px_48px_#0004] [font-family:inherit]"
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={16}
          aria-label="Executor dev tools"
        >
          <header className="executor-devtools-heading flex justify-between items-start gap-4 pb-4 mb-4 border-b border-b-border [&_>_div]:flex [&_>_div]:flex-col [&_>_div]:gap-1.25 [&_strong]:text-[14px] [&_strong]:font-semibold [&_span]:text-[11px] [&_span]:text-muted-foreground">
            <div>
              <strong>Executor dev tools</strong>
              <span>{subtitle}</span>
            </div>
            <Popover.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close dev tools">
                ×
              </Button>
            </Popover.Close>
          </header>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Hosted environments use one Better Auth flow; local-only hosts keep browser pairing. */
export function ExecutorDevtools({
  onSessionChange,
  identity,
}: {
  readonly onSessionChange?: (() => void) | undefined;
  readonly identity?: OperatorIdentity | null | undefined;
}) {
  if (Schema.is(LoopbackOrigin)(window.location.origin))
    return <Widget onSessionChange={onSessionChange} identity={identity} />;
  return onSessionChange ? (
    <HostedTools onSessionChange={onSessionChange} identity={identity} />
  ) : null;
}
