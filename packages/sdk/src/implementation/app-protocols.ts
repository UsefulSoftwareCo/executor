import { Effect, Redacted, Schema } from "effect";
import {
  HostKindMismatch,
  HostOperationNotFound,
  protocol1,
  protocol2,
  protocol3,
  type HostAccounts,
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

const protocol14: AppProtocol = {
  version: 14,
  workerEntry: appBridge,
  nodeEntry: nodeAppEntry(14),
  invocation: (input) => JSON.stringify(input),
  request: (command) => command,
  refuse: () => undefined,
  response: (_command, body) => Effect.succeed(body),
  workflow: (execution) => execution,
  concurrentData: true,
  sealedCredentials: true,
  accounts: (accounts) => accounts,
};

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

const protocol13: AppProtocol = {
  ...protocol14,
  version: 13,
  nodeEntry: nodeAppEntry(13),
  accounts: (accounts) =>
    accounts.user === undefined
      ? { app: slotsWithoutUnderscoredHosts(accounts.app) }
      : {
          app: slotsWithoutUnderscoredHosts(accounts.app),
          user: slotsWithoutUnderscoredHosts(accounts.user),
        },
};

const protocol15: AppProtocol = { ...protocol14, version: 15, nodeEntry: nodeAppEntry(15) };

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
  invocation: <Input extends Pick<HostInvocation, "accounts">>(input: Input) =>
    JSON.stringify({ ...input, accounts: unscopedAccounts(input.accounts) }),
  workflow: (execution: WorkflowExecution): WorkflowExecution => ({
    ...execution,
    resolve: () =>
      execution.resolve().pipe(
        Effect.map((context) => ({
          ...context,
          accounts: Redacted.make(
            unscopedAccounts(Redacted.value(context.accounts)) as unknown as HostAccounts,
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
    command.operation === "migrate"
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
const legacyCommand = (command: HostRequest) =>
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
