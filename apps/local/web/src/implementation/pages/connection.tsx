/**
 * One connection's page (EXE-2 prototype): its name, how to connect an agent, and which apps it
 * reaches, edited in place. Replaces the separate detail view and editor. `new` creates one.
 */
import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  ConnectIcon,
  Copy01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { AppId, Profile } from "@executor-js/sdk";
import { ConnectionId, type ConnectionView } from "@executor-js/mcp-auth/connections";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@executor-js/ui/components/dropdown-menu";
import { PageFrame } from "@executor-js/ui/dashboard/page";
import { useQuery } from "@executor-js/ui/dashboard/context";
import {
  accountOption,
  appChoices,
  ConnectionAppRow,
  initialSelection,
  selectionIssue,
  type AppChoices,
} from "@executor-js/ui/dashboard/connection-app-picker";
import { ConnectionToolPicker } from "@executor-js/ui/dashboard/connection-tool-picker";
import { useIncrementalList } from "@executor-js/ui/dashboard/incremental-list";
import { AssignAccount, SearchInput } from "@executor-js/ui/dashboard/scoped-connections";
import {
  connectionInput,
  type ConnectionApp,
  type ConnectionDraft,
  type ConnectionTarget,
} from "@executor-js/ui/contracts/scoped-connections";
import type { Inventory } from "@executor-js/ui/contracts/dashboard";
import { cn } from "@executor-js/ui/lib/utils";
import { overviewAtom, toolListAtom } from "../../contracts/api.ts";
import {
  mcpConnectionsAtom,
  revokeMcpConnectionAtom,
  saveMcpConnectionAtom,
} from "../../contracts/mcp-connections.ts";
import { Failure, LoadingRows } from "../components/common.tsx";
import { ConnectDialog } from "./connections.tsx";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const choicesFor = (inventory: Inventory): ReadonlyMap<AppId, AppChoices> => {
  const profiles = new Map<AppId, Profile[]>();
  for (const profile of inventory.profiles) {
    const list = profiles.get(profile.app);
    if (list === undefined) profiles.set(profile.app, [profile]);
    else list.push(profile);
  }
  return new Map(
    inventory.apps.map((app) => [
      app.id,
      appChoices(app, profiles.get(app.id) ?? [], inventory.accounts),
    ]),
  );
};

/** A stored connection as an editable draft, keeping removed apps and profiles visible. */
const draftFrom = (
  connection: ConnectionView,
  choices: ReadonlyMap<AppId, AppChoices>,
): ConnectionDraft => ({
  id: connection.id,
  name: connection.name,
  apps: connection.policy.apps.map((item): ConnectionApp => {
    const choice = choices.get(item.app);
    return {
      id: item.app,
      name: choice?.app.name ?? "Unavailable app",
      tools: item.tools,
      ...(item.events === undefined ? {} : { events: item.events }),
      targets: item.runsAs.map((target): ConnectionTarget => {
        if (target.kind === "app") return target;
        const option = choice?.options.find(
          (candidate) => candidate.target.kind === "profile" && candidate.target.id === target.id,
        );
        return option?.target ?? { kind: "profile", id: target.id, label: "Profile unavailable" };
      }),
    };
  }),
});

export function ConnectionPage({ connectionId }: { readonly connectionId: string }) {
  const inventory = useQuery(overviewAtom);
  const connections = useQuery(mcpConnectionsAtom);
  if (Option.isNone(inventory.data) || Option.isNone(connections.data))
    return (
      <PageFrame>
        <LoadingRows count={5} />
      </PageFrame>
    );
  const choices = choicesFor(inventory.data.value);
  if (connectionId === "new")
    return (
      <ConnectionForm
        key="new"
        choices={choices}
        accounts={inventory.data.value.accounts}
        stored={undefined}
        initial={{ id: ConnectionId.make(crypto.randomUUID()), name: "", apps: [] }}
      />
    );
  const stored = connections.data.value.find((item) => item.id === connectionId);
  if (stored === undefined)
    return (
      <PageFrame>
        <BackLink />
        <h1 className="text-[22px] font-semibold tracking-[-0.035em]">Connection unavailable</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          It was revoked or no longer exists.
        </p>
      </PageFrame>
    );
  return (
    <ConnectionForm
      key={`${stored.id}:${stored.name}:${JSON.stringify(stored.policy)}`}
      choices={choices}
      accounts={inventory.data.value.accounts}
      stored={stored}
      initial={draftFrom(stored, choices)}
    />
  );
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" className="mb-5 -ml-2 text-muted-foreground" asChild>
      <Link to="/connections">
        <HugeiconsIcon icon={ArrowLeft02Icon} size={15} />
        Connections
      </Link>
    </Button>
  );
}

function ConnectionForm({
  choices,
  accounts,
  stored,
  initial,
}: {
  readonly choices: ReadonlyMap<AppId, AppChoices>;
  readonly accounts: Inventory["accounts"];
  /** Undefined while creating. */
  readonly stored: ConnectionView | undefined;
  readonly initial: ConnectionDraft;
}) {
  const navigate = useNavigate();
  const submit = useAtomSet(saveMcpConnectionAtom, { mode: "promiseExit" });
  const saving = useAtomValue(saveMcpConnectionAtom);
  const [draft, setDraft] = useState(initial);
  const [expanded, setExpanded] = useState<AppId>();
  const [connecting, setConnecting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  const [needsSetupOnly, setNeedsSetupOnly] = useState(false);
  const query = useDeferredValue(search.trim().toLowerCase());
  const nameInput = useRef<HTMLInputElement>(null);
  const renaming = useRef(false);
  // Included apps stay on top in a fixed order so rows never jump while you toggle them.
  const [pinned] = useState(() => new Set(initial.apps.map((app) => app.id)));
  const ordered = useMemo(
    () =>
      [...choices.values()].toSorted(
        (a, b) =>
          Number(pinned.has(b.app.id)) - Number(pinned.has(a.app.id)) ||
          a.app.name.localeCompare(b.app.name),
      ),
    [choices, pinned],
  );
  const selections = new Map(draft.apps.map((app) => [app.id, app]));
  const unavailable = draft.apps.filter((app) => !choices.has(app.id));
  const attention = new Set(
    draft.apps.flatMap((selection) => {
      const choice = choices.get(selection.id);
      return choice !== undefined && selectionIssue(choice, selection) !== undefined
        ? [selection.id]
        : [];
    }),
  );
  const blocked = attention.size + unavailable.length;
  const visible = ordered.filter(
    (choice) =>
      (!needsSetupOnly || attention.has(choice.app.id)) &&
      (query === "" || choice.app.name.toLowerCase().includes(query)),
  );
  const included = visible.filter((choice) => pinned.has(choice.app.id));
  const others = visible.filter((choice) => !pinned.has(choice.app.id));
  const { count, sentinel } = useIncrementalList(others.length, `${query}:${needsSetupOnly}`);
  const addable = visible.filter((choice) => !selections.has(choice.app.id));
  const unassigned = draft.apps.filter(
    (app) => app.targets.length === 0 && (choices.get(app.id)?.options.length ?? 0) > 0,
  );
  const input = connectionInput(draft);
  const creating = stored === undefined;
  const dirty = creating || JSON.stringify(input) !== JSON.stringify(connectionInput(initial));
  const valid =
    input !== undefined && input.name.length > 0 && draft.apps.length > 0 && blocked === 0;
  const setSelection = (id: AppId, next: ConnectionApp | undefined) =>
    setDraft((previous) => ({
      ...previous,
      apps:
        next === undefined
          ? previous.apps.filter((app) => app.id !== id)
          : previous.apps.some((app) => app.id === id)
            ? previous.apps.map((app) => (app.id === id ? next : app))
            : [...previous.apps, next],
    }));
  const renderRow = (choice: AppChoices) => (
    <ConnectionAppRow
      key={choice.app.id}
      choices={choice}
      selection={selections.get(choice.app.id)}
      expanded={expanded === choice.app.id}
      onExpandedChange={(open) => setExpanded(open ? choice.app.id : undefined)}
      onChange={(next) => setSelection(choice.app.id, next)}
      renderConnectAccount={(app) => (
        <Button type="button" variant="ghost" size="sm" className="text-xs" asChild>
          <Link to="/apps/$appId/setup" params={{ appId: app.id }}>
            Connect account
          </Link>
        </Button>
      )}
      renderTools={({ app, profile, names, onChange }) => (
        <ConnectionToolPicker
          query={toolListAtom({
            app: app.id,
            profile: profile?.id,
            revision: profile?.revision,
            deployment: app.activeDeployment,
          })}
          Failure={Failure}
          names={names}
          onChange={onChange}
        />
      )}
    />
  );
  return (
    <PageFrame>
      <form
        className="max-w-220"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || saving.waiting) return;
          const saved = await submit({ existing: !creating, input });
          if (Exit.isSuccess(saved) && creating)
            void navigate({
              to: "/connections/$connectionId",
              params: { connectionId: saved.value.id },
            });
        }}
      >
        <BackLink />
        <header className="flex items-start justify-between gap-4 max-[600px]:flex-col">
          <div className="min-w-0 flex-1">
            <input
              ref={nameInput}
              aria-label="Connection name"
              required
              maxLength={80}
              autoFocus={creating}
              placeholder="Name this connection"
              value={draft.name}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, name: event.target.value }))
              }
              className="-ml-2 w-full max-w-120 rounded-md border border-transparent bg-transparent px-2 py-0.5 text-[22px] font-semibold tracking-[-0.035em] outline-none placeholder:text-muted-foreground/60 hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
            <p className="mt-1 text-[13px] text-muted-foreground">
              {creating
                ? "Turn on the apps this agent needs. It can't see anything else."
                : "Agents using this connection see only the apps turned on below. Changes apply right away."}
            </p>
          </div>
          {stored !== undefined && (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => setConnecting(true)}>
                <HugeiconsIcon icon={ConnectIcon} strokeWidth={2} aria-hidden />
                Connect
              </Button>
              <DropdownMenu onOpenChange={(open) => !open && setCopied(false)}>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" aria-label="More actions">
                    <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={6}
                  collisionPadding={16}
                  className="w-52 p-1.5"
                  onCloseAutoFocus={(event) => {
                    // Rename moves focus to the title instead of back to the menu button.
                    if (!renaming.current) return;
                    renaming.current = false;
                    event.preventDefault();
                    nameInput.current?.select();
                  }}
                >
                  <DropdownMenuItem
                    className="gap-2.5 py-2"
                    onSelect={(event) => {
                      event.preventDefault();
                      void navigator.clipboard.writeText(stored.url).then(() => setCopied(true));
                    }}
                  >
                    <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
                    {copied ? "Copied" : "Copy MCP URL"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="gap-2.5 py-2"
                    onSelect={() => {
                      renaming.current = true;
                    }}
                  >
                    <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    className="gap-2.5 py-2"
                    onSelect={() => setRevoking(true)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    Revoke connection
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </header>

        {unavailable.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 px-4 py-3 text-[13px]">
            <span>
              {plural(unavailable.length, "app")} in this connection{" "}
              {unavailable.length === 1 ? "no longer exists" : "no longer exist"}:{" "}
              {unavailable.map((app) => app.name).join(", ")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((previous) => ({
                  ...previous,
                  apps: previous.apps.filter((app) => choices.has(app.id)),
                }))
              }
            >
              Remove
            </Button>
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-2">
          <SearchInput
            label="Search apps"
            placeholder={`Search ${plural(choices.size, "app")}…`}
            value={search}
            onChange={setSearch}
          />
          {query !== "" && addable.length > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft((previous) => ({
                  ...previous,
                  apps: [...previous.apps, ...addable.map(initialSelection)],
                }))
              }
            >
              Turn on {plural(addable.length, "match", "matches")}
            </Button>
          )}
          {unassigned.length > 0 && (
            <AssignAccount
              apps={unassigned}
              byId={choices}
              accounts={accounts}
              onAssign={(account) =>
                setDraft((previous) => ({
                  ...previous,
                  apps: previous.apps.map((app) => {
                    const choice = choices.get(app.id);
                    const option =
                      choice === undefined ? undefined : accountOption(choice, account);
                    return app.targets.length === 0 && option !== undefined
                      ? { ...app, targets: [option.target] }
                      : app;
                  }),
                }))
              }
            />
          )}
        </div>
        {needsSetupOnly && (
          <p className="mt-3 text-xs text-muted-foreground">
            Showing apps that need setup.{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => setNeedsSetupOnly(false)}
            >
              Show all
            </button>
          </p>
        )}

        {included.length > 0 && (
          <AppSection
            title="Can use"
            count={draft.apps.filter((app) => pinned.has(app.id)).length}
            hint={undefined}
          >
            {included.map(renderRow)}
          </AppSection>
        )}
        {others.length > 0 && (
          <AppSection
            title={pinned.size > 0 ? "Other apps" : "Apps"}
            count={undefined}
            hint={
              pinned.size > 0 && !others.some((choice) => selections.has(choice.app.id))
                ? "Turn one on to give this agent access."
                : undefined
            }
          >
            {others.slice(0, count).map(renderRow)}
          </AppSection>
        )}
        {sentinel}
        {visible.length === 0 && (
          <p className="mt-8 rounded-lg border px-4 py-10 text-center text-[13px] text-muted-foreground">
            {query !== "" ? "No apps match your search." : "Every app that's on is ready."}
          </p>
        )}

        <div
          className={cn(
            "sticky bottom-0 z-10 mt-6 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-4",
            !dirty && "invisible",
          )}
        >
          <p className="text-xs text-muted-foreground">
            {draft.apps.length === 0 ? (
              "No apps turned on"
            ) : blocked > 0 ? (
              <button
                type="button"
                className="text-amber-600 underline underline-offset-2 dark:text-amber-400"
                onClick={() => {
                  setSearch("");
                  setNeedsSetupOnly(true);
                }}
              >
                {plural(blocked, "app")} {blocked === 1 ? "needs" : "need"} setup before saving
              </button>
            ) : creating ? (
              `${plural(draft.apps.length, "app")} turned on`
            ) : (
              "Unsaved changes"
            )}
          </p>
          <div className="flex gap-2">
            {creating ? (
              <Button type="button" variant="outline" asChild>
                <Link to="/connections">Cancel</Link>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={saving.waiting}
                onClick={() => setDraft(initial)}
              >
                Discard
              </Button>
            )}
            <Button type="submit" disabled={!valid || saving.waiting} loading={saving.waiting}>
              {creating ? "Create connection" : "Save changes"}
            </Button>
          </div>
          {AsyncResult.isFailure(saving) && (
            <div className="w-full">
              <Failure cause={saving.cause} />
            </div>
          )}
        </div>
      </form>
      {stored !== undefined && (
        <>
          <ConnectDialog
            target={
              connecting
                ? {
                    name: stored.name,
                    url: stored.url,
                    apps: initial.apps.map((app) => app.name),
                  }
                : undefined
            }
            onClose={() => setConnecting(false)}
          />
          <RevokeDialog
            connection={revoking ? stored : undefined}
            onClose={() => setRevoking(false)}
            onRevoked={() => void navigate({ to: "/connections" })}
          />
        </>
      )}
    </PageFrame>
  );
}

function AppSection({
  title,
  count,
  hint,
  children,
}: {
  readonly title: string;
  readonly count: number | undefined;
  readonly hint: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-8">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {count !== undefined && (
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        )}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="divide-y overflow-hidden rounded-lg border">{children}</div>
    </section>
  );
}

function RevokeDialog({
  connection,
  onClose,
  onRevoked,
}: {
  readonly connection: ConnectionView | undefined;
  readonly onClose: () => void;
  readonly onRevoked: () => void;
}) {
  const submit = useAtomSet(revokeMcpConnectionAtom, { mode: "promiseExit" });
  const state = useAtomValue(revokeMcpConnectionAtom);
  return (
    <Dialog
      open={connection !== undefined}
      onOpenChange={(open) => !open && !state.waiting && onClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {connection?.name}?</DialogTitle>
          <DialogDescription>
            Agents using this connection lose access immediately. Its URL stops working.
          </DialogDescription>
        </DialogHeader>
        {AsyncResult.isFailure(state) && <Failure cause={state.cause} />}
        <DialogFooter>
          <Button variant="outline" disabled={state.waiting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={state.waiting}
            disabled={state.waiting}
            onClick={async () => {
              if (connection === undefined) return;
              const result = await submit(connection.id);
              if (Exit.isSuccess(result)) onRevoked();
            }}
          >
            Revoke connection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
