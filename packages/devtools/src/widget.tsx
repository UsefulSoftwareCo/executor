import { LoopbackOrigin } from "@executor-js/utils/url-policy";
/** Shared floating shell; each development server supplies its own capabilities. */
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Input } from "@executor-js/ui/components/input";
import { Button } from "@executor-js/ui/components/button";
import { Effect, Exit, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { Popover } from "radix-ui";
import { useState } from "react";
import { DevtoolsState, DevtoolsSuccess } from "./contracts.ts";

class DevtoolsUnavailable extends Schema.TaggedError<DevtoolsUnavailable>()(
  "DevtoolsUnavailable",
  {},
) {}
const runtime = Atom.runtime(FetchHttpClient.layer);
const stateAtom = Atom.family((organization: string) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const query = new URLSearchParams(organization ? { organization } : {});
        const response = yield* client.get(`/api/devtools?${query}`);
        if (response.status === 404) return null;
        if (response.status !== 200) return yield* new DevtoolsUnavailable();
        return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DevtoolsState)));
      }).pipe(Effect.mapError(() => new DevtoolsUnavailable())),
    )
    .pipe(Atom.refreshOnWindowFocus),
);

type Action =
  | { readonly kind: "account"; readonly organization: string; readonly userId: string }
  | { readonly kind: "pair" };

const actionAtom = runtime.fn((action: Action) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`/api/devtools/${action.kind}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(
          action.kind === "account"
            ? { organization: action.organization, userId: action.userId }
            : {},
        ),
      ),
    );
    if (response.status !== 200) return yield* new DevtoolsUnavailable();
    yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(DevtoolsSuccess)));
  }).pipe(Effect.mapError(() => new DevtoolsUnavailable())),
);

const roles = {
  member: { title: "Member" },
  admin: { title: "Admin" },
  owner: { title: "Owner" },
};
const hosts = { "self-host": "Self-host", cloud: "Cloud", local: "Local" };

function Widget({ organization }: { readonly organization: string }) {
  const state = useAtomValue(stateAtom(organization));
  const refresh = useAtomRefresh(stateAtom(organization));
  const [search, setSearch] = useState("");
  const pending = useAtomValue(actionAtom);
  const submit = useAtomSet(actionAtom, { mode: "promiseExit" });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  if (AsyncResult.isInitial(state) || (AsyncResult.isSuccess(state) && state.value === null))
    return null;
  const capability = AsyncResult.isSuccess(state) ? state.value : null;
  const matchingAccounts =
    capability?.kind === "accounts"
      ? capability.accounts.filter((account) =>
          `${account.name} ${account.email} ${roles[account.role].title}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
        )
      : [];
  const run = async (action: Action) => {
    setError(null);
    setSelected(action.kind === "account" ? action.userId : "pair");
    const result = await submit(action);
    if (Exit.isFailure(result)) {
      setError("Could not change the test session. Check the dev server and try again.");
      refresh();
    } else {
      // Authority changes must discard all cached product data, while preserving the current route.
      window.location.reload();
    }
  };
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) refresh();
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
              <span>
                {capability === null
                  ? "Local development"
                  : `${hosts[capability.host]} · Development`}
              </span>
            </div>
            <Popover.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close dev tools">
                ×
              </Button>
            </Popover.Close>
          </header>
          {AsyncResult.isFailure(state) && (
            <div className="executor-devtools-error text-destructive text-[12px] leading-[1.5] mt-3">
              <p>Could not load dev tools.</p>
              <Button variant="outline" onClick={refresh}>
                Try again
              </Button>
            </div>
          )}
          {capability?.kind === "accounts" && (
            <section>
              <div className="executor-devtools-section-title [&_>_span]:text-[11px] [&_>_span]:text-muted-foreground flex justify-between items-center gap-2 mb-3 [&_h2]:text-[12px] [&_h2]:font-semibold">
                <h2>Switch user · {capability.accounts.length}</h2>
                <span className="truncate" title={capability.organization.name}>
                  {capability.organization.name}
                </span>
              </div>
              <Input
                aria-label="Search organization members"
                placeholder="Search name or email…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="mb-3"
              />
              <div className="executor-devtools-accounts grid gap-1.75 max-h-72 overflow-y-auto">
                {matchingAccounts.map((account) => (
                  <Button
                    key={account.id}
                    variant="outline"
                    className="executor-devtools-account w-full h-auto min-h-19.25 py-[11px] px-[12px] text-left justify-between whitespace-normal [&_>_span:first-child]:flex [&_>_span:first-child]:flex-col [&_>_span:first-child]:gap-0.75 [&_strong]:text-[12px] [&_strong]:font-semibold [&_>_span:first-child_>_span]:text-[11px] [&_>_span:first-child_>_span]:text-muted-foreground [&_>_span:first-child_>_span]:font-normal [&_small]:text-[10px] [&_small]:text-muted-foreground [&_small]:font-normal [&_small]:wrap-anywhere [&[aria-pressed='true']]:border-ring"
                    aria-label={`Impersonate ${account.name}, ${roles[account.role].title}, ${account.email}`}
                    aria-pressed={capability.selected === account.id}
                    disabled={pending.waiting}
                    loading={pending.waiting && selected === account.id}
                    onClick={() =>
                      run({
                        kind: "account",
                        organization: capability.organization.id,
                        userId: account.id,
                      })
                    }
                  >
                    <span>
                      <strong>{account.name}</strong>
                      <span>{roles[account.role].title}</span>
                      <small>{account.email}</small>
                    </span>
                    <span className="executor-devtools-account-state text-[10px] text-muted-foreground">
                      {capability.selected === account.id
                        ? capability.impersonating
                          ? "Impersonating"
                          : "Active"
                        : "→"}
                    </span>
                  </Button>
                ))}
                {matchingAccounts.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    {capability.accounts.length === 0
                      ? "This organization has no members."
                      : "No matching members."}
                  </p>
                )}
              </div>
              <p className="executor-devtools-note mt-3 text-muted-foreground text-[11px] leading-[1.6]">
                Local development only. Impersonate any member for up to one hour with their current
                access.
              </p>
            </section>
          )}
          {capability?.kind === "pairing" && (
            <section>
              <div className="executor-devtools-section-title [&_>_span]:text-[11px] [&_>_span]:text-muted-foreground flex justify-between items-center gap-2 mb-3 [&_h2]:text-[12px] [&_h2]:font-semibold">
                <h2>Browser pairing</h2>
                <span>{capability.paired ? "Paired" : "Not paired"}</span>
              </div>
              <p className="executor-devtools-note mt-3 text-muted-foreground text-[11px] leading-[1.6]">
                Connect this browser to the local dev server without a pairing link.
              </p>
              <Button
                className="executor-devtools-pair w-full mt-3.5"
                variant="outline"
                disabled={pending.waiting || capability.paired}
                loading={pending.waiting}
                onClick={() => run({ kind: "pair" })}
              >
                {capability.paired ? "Browser connected" : "Skip pairing"}
              </Button>
            </section>
          )}
          {error !== null && (
            <p
              className="executor-devtools-error text-destructive text-[12px] leading-[1.5] mt-3"
              role="alert"
            >
              {error}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Discover local development tools without making requests on public product origins. */
export function ExecutorDevtools({
  organization = "",
}: {
  readonly organization?: string | undefined;
}) {
  return Schema.is(LoopbackOrigin)(window.location.origin) ? (
    <Widget key={organization} organization={organization} />
  ) : null;
}
