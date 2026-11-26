import type { AccountId, AppId } from "@executor-js/sdk";
import type {
  ConnectionApp as StoredConnectionApp,
  ConnectionId,
  ConnectionInput,
  ConnectionView,
} from "@executor-js/mcp-auth/connections";
import type { Atom } from "effect/reactivity";
import type { Query } from "./dashboard.ts";

export type ConnectionTools = StoredConnectionApp["tools"];

export type ConnectionEvents = NonNullable<StoredConnectionApp["events"]>;

export type ConnectionTarget =
  | { readonly kind: "app" }
  | { readonly kind: "account"; readonly id: AccountId; readonly label: string };

export const connectionTargetKey = (target: ConnectionTarget): string =>
  target.kind === "app" ? "app" : `${target.kind}:${target.id}`;

export const connectionTargetLabel = (target: ConnectionTarget): string =>
  target.kind === "app" ? "No account needed" : target.label;

export interface ConnectionApp {
  readonly id: AppId;
  readonly name: string;
  readonly targets: readonly ConnectionTarget[];
  readonly tools: ConnectionTools;
  readonly events?: ConnectionEvents;
}

export const connectionEventsLabel = (events: ConnectionEvents | undefined): string =>
  events === undefined || events.kind === "all"
    ? "All events"
    : events.names.length === 0
      ? "No events"
      : `${events.names.length.toLocaleString("en-US")} ${events.names.length === 1 ? "event" : "events"}`;

export interface ConnectionDraft {
  readonly id: ConnectionId;
  readonly name: string;
  readonly apps: readonly ConnectionApp[];
}

const targetInput = (
  target: ConnectionTarget,
): ConnectionInput["apps"][number]["runsAs"][number] =>
  target.kind === "app" ? target : { kind: "account", id: target.id };

export const defaultConnectionName = (apps: readonly { readonly name: string }[]): string => {
  const [first, second, ...rest] = apps.map((app) => app.name);
  const name =
    first === undefined
      ? "New connection"
      : second === undefined
        ? first
        : rest.length === 0
          ? `${first} and ${second}`
          : `${first}, ${second} and ${rest.length.toLocaleString("en-US")} more`;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
};

export const connectionInput = (draft: ConnectionDraft): ConnectionInput | undefined => {
  const apps: ConnectionInput["apps"][number][] = [];
  for (const app of draft.apps) {
    const [first, ...rest] = app.targets.map(targetInput);
    if (first === undefined) return undefined;
    apps.push({
      app: app.id,
      runsAs: [first, ...rest],
      tools: app.tools,
      ...(app.events === undefined ? {} : { events: app.events }),
    });
  }
  return { id: draft.id, name: draft.name.trim() || defaultConnectionName(draft.apps), apps };
};

export interface ConsentConnection {
  readonly id: ConnectionId;
  readonly name: string;
  readonly apps: readonly string[];
}

export interface ConnectionSave {
  readonly existing: boolean;
  readonly input: ConnectionInput;
}

export interface ScopedConnectionBindings<EL, ES, ER> {
  readonly connections: Query<readonly ConnectionView[], EL>;
  readonly save: Atom.AtomResultFn<ConnectionSave, ConnectionView, ES>;
  readonly revoke: Atom.AtomResultFn<ConnectionId, void, ER>;
}
