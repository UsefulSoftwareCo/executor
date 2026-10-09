import { useState, type ComponentType } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { GrantId } from "@executor-js/mcp-auth";
import type { ConnectedAgent, ConnectedAgentAccess } from "@executor-js/mcp-auth/agents";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/dialog.tsx";
import { LocalTime, RelativeTime, shortMoment } from "../components/local-time.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { QueryView } from "./context.tsx";

const agentName = (agent: ConnectedAgent) => agent.name?.trim() || "Unnamed MCP client";

const accessLabel = (access: ConnectedAgentAccess) => {
  switch (access.kind) {
    case "all":
      return "Every app";
    case "tools":
      return `Selected tools in ${access.apps} ${access.apps === 1 ? "app" : "apps"}`;
    case "connection":
      return `Scoped connection: ${access.name}`;
    case "api":
      return "Executor API";
  }
};

/**
 * Agents the current user authorized over OAuth. Each row is one grant; revoking it ends the
 * agent's access at once and it must sign in again to reconnect. Only agents that can still reach
 * Executor are listed, most recently used first.
 */
export function ConnectedAgents<E, EL extends E, ER extends E>({
  query,
  revoke,
  Failure,
}: {
  readonly query: Query<readonly ConnectedAgent[], EL>;
  readonly revoke: Atom.AtomResultFn<GrantId, void, ER>;
  /** Renders list and revocation failures. */
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const [revoking, setRevoking] = useState<ConnectedAgent>();
  const submit = useAtomSet(revoke, { mode: "promiseExit" });
  const state = useAtomValue(revoke);
  return (
    <section aria-label="Connected agents" className="mt-10">
      <div className="mb-2 flex h-6 items-center">
        <h2 className="text-xs font-medium text-muted-foreground">Connected agents</h2>
      </div>
      <QueryView<readonly ConnectedAgent[], E>
        query={query}
        Failure={Failure}
        pending={<ConnectedAgentsSkeleton />}
      >
        {(agents) =>
          agents.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No agent is connected. Agents that sign in with the MCP URL appear here.
            </p>
          ) : (
            <ul className="divide-y border-y">
              {agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onRevoke={setRevoking} />
              ))}
            </ul>
          )
        }
      </QueryView>
      <Dialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open && !state.waiting) setRevoking(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking === undefined ? "" : agentName(revoking)}?</DialogTitle>
            <DialogDescription>
              This agent loses access immediately. To use Executor again, it must sign in and be
              approved again.
            </DialogDescription>
          </DialogHeader>
          {AsyncResult.isFailure(state) && <Failure cause={state.cause} />}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={state.waiting}
              onClick={() => setRevoking(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={state.waiting}
              disabled={state.waiting}
              onClick={async () => {
                if (revoking === undefined) return;
                if (Exit.isSuccess(await submit(revoking.id))) setRevoking(undefined);
              }}
            >
              Revoke agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AgentRow({
  agent,
  onRevoke,
}: {
  readonly agent: ConnectedAgent;
  readonly onRevoke: (agent: ConnectedAgent) => void;
}) {
  return (
    <li className="flex items-center gap-4 px-1 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{agentName(agent)}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {accessLabel(agent.access)}
          {agent.lastActiveAt !== null && (
            <>
              {" · Last used "}
              <RelativeTime value={agent.lastActiveAt} />
            </>
          )}
          {" · Connected "}
          <LocalTime value={agent.connectedAt} options={shortMoment} />
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => onRevoke(agent)}>
        Revoke<span className="sr-only"> {agentName(agent)}</span>
      </Button>
    </li>
  );
}

/** Matches one row of the loaded list so loading does not reflow the page. */
function ConnectedAgentsSkeleton() {
  return (
    <div role="status" aria-label="Loading connected agents" className="divide-y border-y">
      <div aria-hidden className="flex items-center gap-4 px-1 py-3">
        <div className="min-w-0 flex-1 space-y-2 py-px">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-2.5 w-64 max-w-[70%]" />
        </div>
        <Skeleton className="h-8 w-16" />
      </div>
      <span className="sr-only">Loading connected agents…</span>
    </div>
  );
}
