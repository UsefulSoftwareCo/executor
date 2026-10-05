/**
 * Host protocol adapters. A build records the protocol its `apps` framework speaks; the host runs
 * it only through that protocol's adapter. Each adapter owns the generated entry compiled into its
 * builds and converts between the host's current model and that protocol's messages. The current
 * protocol's adapter is the identity. A new protocol adds an adapter here; older ones stay.
 */
import { Effect, Schema } from "effect";
import {
  HostKindMismatch,
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
}

/** Protocol 8 is the host's current protocol, so its messages need no conversion. */
const protocol8: AppProtocol = {
  version: 8,
  workerEntry: appBridge,
  nodeEntry: nodeAppEntry(8),
  invocation: (input) => JSON.stringify(input),
  request: (command) => command,
  refuse: () => undefined,
  response: (_command, body) => Effect.succeed(body),
  workflow: (execution) => execution,
};

/** Protocol 7 replies lack optional MCP fallback diagnostics. */
const protocol7: AppProtocol = { ...protocol8, version: 7, nodeEntry: nodeAppEntry(7) };

/**
 * Protocol 6 is protocol 7 without credential hosts or field exposure. Its providers never declare
 * hosts, so the host sends them real values unless an account was connected with hosts, and every
 * message and reply is unchanged.
 */
const protocol6: AppProtocol = { ...protocol7, version: 6, nodeEntry: nodeAppEntry(6) };

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
