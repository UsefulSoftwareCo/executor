import { Effect, Redacted, Schema } from "effect";
import {
  HostKindMismatch,
  HostOperationNotFound,
  protocol1,
  protocol2,
  protocol3,
  type HostAccounts,
  type HostAccount,
  type HostAccountSlots,
  type HostInvocation,
  type HostRequest,
  type ResolvedAccount,
  type ResolvedAccounts,
  type ResolvedAccountSlots,
  type WorkflowExecution,
} from "apps/contracts";
import type { SourceTextFile as SourceFile } from "../contracts/source.ts";
import { RuntimeProtocolUnsupported } from "../contracts/runtime.ts";
import { appBridge, nodeAppEntry } from "./worker-bridge.ts";

export interface AppProtocol {
  readonly version: number;
  readonly workerEntry: string;
  readonly nodeEntry: (files: readonly SourceFile[]) => string;
  readonly invocation: (input: HostInvocation) => string;
  readonly request: (command: HostRequest) => unknown;
  readonly refuse: (command: HostRequest) => unknown;
  readonly response: (command: HostRequest, body: unknown) => Effect.Effect<unknown>;
  readonly workflow: (execution: WorkflowExecution) => WorkflowExecution;
  readonly concurrentData: boolean;
  readonly sealedCredentials: boolean;
  readonly accounts: (accounts: ResolvedAccounts) => ResolvedAccounts;
}

const underscored = (host: string) => host.includes("_");

const withoutUnderscoredHosts = (account: ResolvedAccount): ResolvedAccount => {
  const hosts = account.provider.hosts;
  return hosts?.some(underscored) === true
    ? { ...account, provider: { ...account.provider, hosts: hosts.filter((h) => !underscored(h)) } }
    : account;
};

const slotsWithoutUnderscoredHosts = (slots: ResolvedAccountSlots): ResolvedAccountSlots =>
  Object.fromEntries(
    Object.entries(slots).map(([slot, selected]) => [
      slot,
      "provider" in selected
        ? withoutUnderscoredHosts(selected)
        : selected.map(withoutUnderscoredHosts),
    ]),
  );

const withoutInteractiveAccount = (account: HostAccount): HostAccount => ({
  ...account,
  provider: {
    ...account.provider,
    auth: Object.fromEntries(
      Object.entries(account.provider.auth).filter(([, method]) => method.type !== "interactive"),
    ),
  },
});
const withoutInteractiveAccounts = (accounts: HostAccounts): HostAccounts => {
  const strip = (slots: HostAccountSlots): HostAccountSlots =>
    Object.fromEntries(
      Object.entries(slots).map(([slot, selected]) => [
        slot,
        "id" in selected
          ? withoutInteractiveAccount(selected)
          : selected.map(withoutInteractiveAccount),
      ]),
    );
  return {
    app: strip(accounts.app),
    ...(accounts.user === undefined ? {} : { user: strip(accounts.user) }),
  };
};

const withoutCaller = ({ caller: _caller, ...input }: HostInvocation) => input;

const protocol14: AppProtocol = {
  version: 14,
  workerEntry: appBridge,
  nodeEntry: nodeAppEntry(14),
  invocation: (input) =>
    JSON.stringify({ ...input, accounts: withoutInteractiveAccounts(input.accounts) }),
  request: (command) => command,
  refuse: (command) =>
    command.operation === "connect"
      ? Schema.encodeSync(HostOperationNotFound)(new HostOperationNotFound())
      : undefined,
  response: (_command, body) => Effect.succeed(body),
  workflow: (execution) => ({
    ...execution,
    resolve: () =>
      execution.resolve().pipe(
        Effect.map((context) => ({
          ...context,
          accounts: Redacted.make(withoutInteractiveAccounts(Redacted.value(context.accounts))),
        })),
      ),
  }),
  concurrentData: true,
  sealedCredentials: true,
  accounts: (accounts) => withoutInteractiveAccounts(accounts),
};

const protocol15: AppProtocol = {
  ...protocol14,
  version: 15,
  nodeEntry: nodeAppEntry(15),
  invocation: (input) => JSON.stringify(input),
  refuse: () => undefined,
  workflow: (execution) => execution,
  accounts: (accounts) => accounts,
};

const protocol13Accounts = (accounts: ResolvedAccounts): ResolvedAccounts => {
  const filtered = withoutInteractiveAccounts(accounts);
  return filtered.user === undefined
    ? { app: slotsWithoutUnderscoredHosts(filtered.app) }
    : {
        app: slotsWithoutUnderscoredHosts(filtered.app),
        user: slotsWithoutUnderscoredHosts(filtered.user),
      };
};

const protocol13: AppProtocol = {
  ...protocol14,
  version: 13,
  nodeEntry: nodeAppEntry(13),
  invocation: (input) =>
    JSON.stringify({
      ...withoutCaller(input),
      accounts: protocol13Accounts(input.accounts),
    }),
  workflow: (execution) => ({
    ...execution,
    resolve: () =>
      execution.resolve().pipe(
        Effect.map((context) => ({
          ...context,
          accounts: Redacted.make(protocol13Accounts(Redacted.value(context.accounts))),
        })),
      ),
  }),
  accounts: protocol13Accounts,
};

const unscopedAccounts = <Slots>(accounts: {
  readonly app: Slots;
  readonly user?: Slots;
}): Slots | Record<string, never> => accounts.user ?? {};

const RequirementsReply = Schema.Struct({
  ok: Schema.Literal(true),
  value: Schema.Struct({ accounts: Schema.Unknown }),
});

const scopedRequirements = (command: HostRequest, body: unknown) =>
  command.operation === "requirements" && Schema.is(RequirementsReply)(body)
    ? { ...body, value: { ...body.value, accounts: { app: {}, user: body.value.accounts } } }
    : body;

const unscoped = {
  invocation: (input: HostInvocation) =>
    JSON.stringify({
      ...withoutCaller(input),
      accounts: unscopedAccounts(protocol13Accounts(input.accounts)),
    }),
  workflow: (execution: WorkflowExecution): WorkflowExecution => ({
    ...execution,
    resolve: () =>
      execution.resolve().pipe(
        Effect.map((context) => ({
          ...context,
          accounts: Redacted.make(
            unscopedAccounts(
              protocol13Accounts(Redacted.value(context.accounts)),
            ) as unknown as HostAccounts,
          ),
        })),
      ),
  }),
};

const protocol12: AppProtocol = {
  ...protocol13,
  version: 12,
  nodeEntry: nodeAppEntry(12),
  invocation: unscoped.invocation,
  response: (command, body) => Effect.succeed(scopedRequirements(command, body)),
  workflow: unscoped.workflow,
};

const protocol11: AppProtocol = {
  ...protocol12,
  version: 11,
  nodeEntry: nodeAppEntry(11),
};

const protocol10: AppProtocol = { ...protocol11, version: 10, nodeEntry: nodeAppEntry(10) };

const protocol9: AppProtocol = {
  ...protocol10,
  version: 9,
  nodeEntry: nodeAppEntry(9),
  refuse: (command) =>
    command.operation === "migrate" || command.operation === "connect"
      ? Schema.encodeSync(HostOperationNotFound)(new HostOperationNotFound())
      : undefined,
  concurrentData: false,
};

const protocol8: AppProtocol = { ...protocol9, version: 8, nodeEntry: nodeAppEntry(8) };

const protocol7: AppProtocol = { ...protocol8, version: 7, nodeEntry: nodeAppEntry(7) };

const protocol6: AppProtocol = {
  ...protocol7,
  version: 6,
  nodeEntry: nodeAppEntry(6),
  sealedCredentials: false,
};

const protocol5: AppProtocol = { ...protocol6, version: 5, nodeEntry: nodeAppEntry(5) };

const protocol4: AppProtocol = { ...protocol5, version: 4, nodeEntry: nodeAppEntry(4) };

const legacyProtocols = { 1: protocol1, 2: protocol2, 3: protocol3 } as const;
type LegacyVersion = keyof typeof legacyProtocols;

const prefixKind = (tool: string) =>
  tool.startsWith("queries.") ? "query" : tool.startsWith("mutations.") ? "mutation" : undefined;
const legacyCommand = (command: HostRequest): HostRequest =>
  command.operation === "call"
    ? { operation: "call", tool: command.tool, input: command.input }
    : command;
const legacyProtocol = (version: LegacyVersion): AppProtocol => {
  const { tools, toolSummaries } = legacyProtocols[version].schemas;
  const listed = Schema.Struct({ ok: Schema.Literal(true), value: tools });
  const summarized = Schema.Struct({ ok: Schema.Literal(true), value: toolSummaries });
  return {
    version,
    workerEntry: appBridge,
    nodeEntry: nodeAppEntry(version),
    invocation: (input) => unscoped.invocation({ ...input, command: legacyCommand(input.command) }),
    request: legacyCommand,
    refuse: (command) => {
      if (command.operation === "connect")
        return Schema.encodeSync(HostOperationNotFound)(new HostOperationNotFound());
      if (command.operation !== "call" || command.kind === undefined) return undefined;
      const actual = prefixKind(command.tool);
      return actual === undefined || actual === command.kind
        ? undefined
        : Schema.encodeSync(HostKindMismatch)(
            new HostKindMismatch({ tool: command.tool, requested: command.kind, actual }),
          );
    },
    response: (command, body) =>
      Effect.succeed(
        command.operation === "inspect" &&
          Schema.is(command.detail === "summary" ? summarized : listed)(body)
          ? { ...body, value: { tools: body.value, routers: [] } }
          : scopedRequirements(command, body),
      ),
    workflow: (execution) => ({
      ...unscoped.workflow(execution),
      invoke: (input) =>
        execution.invoke({
          ...input,
          name: `${input.kind === "query" ? "queries" : "mutations"}.${input.name}`,
        }),
    }),
    concurrentData: false,
    sealedCredentials: false,
    accounts: protocol13.accounts,
  };
};

const protocols: ReadonlyMap<number, AppProtocol> = new Map(
  [
    legacyProtocol(1),
    legacyProtocol(2),
    legacyProtocol(3),
    protocol4,
    protocol5,
    protocol6,
    protocol7,
    protocol8,
    protocol9,
    protocol10,
    protocol11,
    protocol12,
    protocol13,
    protocol14,
    protocol15,
  ].map((protocol) => [protocol.version, protocol]),
);

export const supportedProtocols: readonly number[] = [...protocols.keys()];

export const appProtocol = (
  version: number,
): Effect.Effect<AppProtocol, RuntimeProtocolUnsupported> => {
  const protocol = protocols.get(version);
  return protocol === undefined
    ? Effect.fail(
        new RuntimeProtocolUnsupported({ protocol: version, supported: supportedProtocols }),
      )
    : Effect.succeed(protocol);
};

export const interactiveProtocolAdditions = [
  {
    message: "request",
    path: "operation=connect",
    since: 15,
    gate: "appProtocol.refuse rejects connect for protocols before 15",
  },
];
export const interactiveProtocolAdaptations = [
  { message: "invocation", protocols: [13, 14], adapter: "protocol-specific invocation" },
  { message: "accounts", protocols: [13, 14], adapter: "withoutInteractiveAccounts" },
];
