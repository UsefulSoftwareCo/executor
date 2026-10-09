/**
 * Host protocol adapters. A build records the protocol its `apps` framework speaks; the host runs
 * it only through that protocol's adapter. Each adapter owns the generated entry compiled into its
 * builds and converts between the host's current model and that protocol's messages. The current
 * protocol's adapter is the identity. A new protocol adds an adapter here; older ones stay.
 */
import { Effect, Schema } from "effect";
import {
  HostKindMismatch,
  HostOperationNotFound,
  protocol1,
  protocol2,
  protocol3,
  type HostInvocation,
  type HostRequest,
  type WorkflowExecution,
} from "apps/contracts";
import type { SourceFile } from "../contracts/deployment.ts";
import { RuntimeProtocolUnsupported } from "../contracts/runtime.ts";
import { appBridge, nodeAppEntry } from "./worker-bridge.ts";

/** One released host protocol, seen from this host. */
export interface AppProtocol {
  readonly version: number;
  /** Server entry retained in this protocol's Worker builds. */
  readonly workerEntry: (files: readonly SourceFile[]) => string;
  /** Entry for the SDK's in-process Node runtime. */
  readonly nodeEntry: (files: readonly SourceFile[]) => string;
  /** Encode an invocation in the host's current model as this protocol's entry body. */
  readonly invocation: (input: HostInvocation) => string;
  /** Encode one current command for a bundle of this protocol. */
  readonly request: (command: HostRequest) => unknown;
  /**
   * The encoded failure for a command that this protocol's bundles would not run as asked.
   * The host fails the command with it and sends nothing to the bundle.
   */
  readonly refuse: (command: HostRequest) => unknown;
  /**
   * Convert a bundle's reply to `command` into the host's current envelope. Transport fields
   * beside the envelope, such as telemetry, pass through unchanged.
   */
  readonly response: (command: HostRequest, body: unknown) => Effect.Effect<unknown>;
  /** Adapt the workflow steps a bundle of this protocol invokes to the host's current model. */
  readonly workflow: (execution: WorkflowExecution) => WorkflowExecution;
  /**
   * Whether this protocol's data calls may run alongside each other. Earlier bundles keep a
   * database transaction open for a whole call, so their facet runs one call at a time.
   */
  readonly concurrentData: boolean;
  /**
   * Whether this protocol's bundles read sealed credential handles for providers that declare
   * hosts. Earlier frameworks know no hosts and read every field as a real value, so sealing
   * would hand them handles as secrets: their accounts leave the runner unsealed, even when the
   * account was connected through a later app that declared hosts.
   */
  readonly sealedCredentials: boolean;
}

/** Protocol 11 is the host's current protocol, so its messages need no conversion. */
const protocol11: AppProtocol = {
  version: 11,
  workerEntry: appBridge,
  nodeEntry: nodeAppEntry(11),
  invocation: (input) => JSON.stringify(input),
  request: (command) => command,
  refuse: () => undefined,
  response: (_command, body) => Effect.succeed(body),
  workflow: (execution) => execution,
  concurrentData: true,
  sealedCredentials: true,
};

/**
 * Protocol 10 is protocol 11 without events. Its requirements declare none and its replies emit
 * none, so every message and reply is unchanged.
 */
const protocol10: AppProtocol = { ...protocol11, version: 10, nodeEntry: nodeAppEntry(10) };

/**
 * Protocol 9 is protocol 10 without app-owned SQL. Its apps never declare `sql`, so the host never
 * sends them `migrate`, and every other message and reply is unchanged. Their document store holds
 * a transaction across a whole call.
 */
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

/**
 * Protocol 8 is protocol 9 without the session an MCP failure's request carried or what a skill
 * source is missing. Its failures are protocol 9 failures without that detail, so every reply is
 * unchanged.
 */
const protocol8: AppProtocol = { ...protocol9, version: 8, nodeEntry: nodeAppEntry(8) };

/**
 * Protocol 7 is protocol 8 without upstream failure detail. Its failures are protocol 8 failures
 * that carry no thrown error fields, provider phase or service error, so every reply is unchanged.
 */
const protocol7: AppProtocol = { ...protocol8, version: 7, nodeEntry: nodeAppEntry(7) };

/**
 * Protocol 6 is protocol 7 without credential hosts or field exposure. Its bundles read every
 * credential field as a real value, so the host never seals their accounts, whichever app the
 * account was connected through. Every message and reply is unchanged.
 */
const protocol6: AppProtocol = {
  ...protocol7,
  version: 6,
  nodeEntry: nodeAppEntry(6),
  sealedCredentials: false,
};

/** Protocol 5 has the same commands; its OAuth declarations lack a metadata URL override. */
const protocol5: AppProtocol = { ...protocol6, version: 5, nodeEntry: nodeAppEntry(5) };

/**
 * Protocol 4 is protocol 5 without account checks. Its builds never declare a slot check, so the
 * host never sends them `account-check`, and every other message and reply is unchanged.
 */
const protocol4: AppProtocol = { ...protocol5, version: 4, nodeEntry: nodeAppEntry(4) };

/** The protocols released before routers and call kinds. */
const legacyProtocols = { 1: protocol1, 2: protocol2, 3: protocol3 } as const;
type LegacyVersion = keyof typeof legacyProtocols;

/**
 * Protocols 1, 2 and 3 predate routers and call kinds and share one adapter, parameterized by
 * version. Their tools are named `queries.<name>` and `mutations.<name>`, and those names are kept:
 * they are what saved grants, approvals and schedules refer to.
 *
 * Their calls carry no kind: the bundle derives it from the tool's prefix. The host still chooses
 * storage from the caller's kind, so a call whose kind disagrees with its prefix fails here
 * instead of running in the wrong mode. Inspection answers with a plain list of tools, which
 * becomes a catalog without routers. Workflow steps name an operation within its kind's catalog,
 * so the host prefixes the name to get the tool.
 *
 * What each added over the one before needs no conversion. Protocol 2's skill catalog reply may
 * say whether its loader read through the app cache; protocol 1 never does, which reads as a
 * loader that did not. Protocol 3's failures may carry the app's error detail; earlier failures
 * are the same failures without it, and earlier bundles ignore the detail in workflow step replies.
 */
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
    invocation: (input) => JSON.stringify({ ...input, command: legacyCommand(input.command) }),
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
          : body,
      ),
    workflow: (execution) => ({
      ...execution,
      invoke: (input) =>
        execution.invoke({
          ...input,
          name: `${input.kind === "query" ? "queries" : "mutations"}.${input.name}`,
        }),
    }),
    concurrentData: false,
    sealedCredentials: false,
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
  ].map((protocol) => [protocol.version, protocol]),
);

/** Protocols this host builds and runs. */
export const supportedProtocols: readonly number[] = [...protocols.keys()];

/** Select the adapter for a framework or retained build, before compiling or loading any code. */
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
