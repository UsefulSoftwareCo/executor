/**
 * Connection binding for artifacts — dependency injection instead of a pinned
 * account.
 *
 * A codemode address is five segments:
 * `tools.<integration>.<org|user>.<connection>.<tool>`. That is the right shape
 * for `execute`, where the model is discovering what exists and has to say
 * exactly which row it means. It is the wrong shape for a SAVED artifact: the
 * middle two segments are the author's own connection identity, and freezing
 * them into stored source means the artifact can only ever run as its author.
 * Share it and every `.user.` path resolves against the viewer's subject
 * instead, so the row is invisible and the call fails per-query.
 *
 * So artifact code names an integration ROLE, never a connection:
 *
 *     tools.vercel.domains.getDomains            // the sole vercel role
 *     tools.linear("prod").issues.list           // one of several linear roles
 *     tools.linear("staging").issues.list
 *
 * and the connection arrives at invoke time. `create-artifact` extracts the
 * roles the code actually uses, resolves each to one of the AUTHOR's
 * connections, and persists the result on the artifact row; `execute-action`
 * turns role + stored binding back into the five-segment address immediately
 * before executing. The model-facing address loses two segments and gains
 * portability: rebinding a shared artifact later is a row update, not a rewrite.
 *
 * This is the same model the custom-tools (apps) plugin already uses
 * (`resolveIntegrationBindings` in `@executor-js/plugin-apps`): a tool declares
 * integrations as fields, the caller supplies connections, and the error names
 * the candidates when it can't choose. The vocabulary is deliberately shared —
 * "role", "binding", "choose one of ...".
 *
 * Everything above `resolveArtifactBindings` is pure and string-only, so the
 * grammar can be tested without a store, an executor or a server.
 */

import {
  ConnectionName,
  IntegrationSlug,
  type ArtifactBinding,
  type ArtifactBindings,
  type Owner,
} from "@executor-js/sdk";
import { Option, Schema } from "effect";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** One integration slot an artifact's code depends on. The `role` is the key
 *  bindings are stored under: a model-chosen label for the explicit form, or
 *  the integration slug itself for the implicit single-account form. */
export interface ArtifactRole {
  readonly role: string;
  readonly integration: string;
}

/** What a caller's connection looks like to this module — the projection of
 *  `Connection` that binding needs. Structural, so `executor.connections.list`
 *  satisfies it directly. */
export interface BindableConnection {
  readonly integration: string;
  readonly owner: Owner;
  readonly name: string;
}

/**
 * Roots under `tools` that are not integrations and therefore never bind.
 *
 * `tools.search(...)`, `tools.describe.tool(...)` and
 * `tools.executor.coreTools.*` are executor's own system tools; they resolve
 * without a connection and are the same for every viewer, so they pass through
 * both extraction and resolution untouched.
 */
export const RESERVED_TOOL_ROOTS: ReadonlySet<string> = new Set(["search", "describe", "executor"]);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Blanks line and block comments, preserving length and newlines.
 *
 * Only comments — NOT string literals. The role in `tools.linear("prod")` *is*
 * a string literal, so blanking those would erase the very thing being read.
 * Commented-out code is the realistic false-positive source (a model leaving
 * `// tools.github.issues.list` behind would otherwise acquire a github role it
 * never calls); a `tools.` path inside a live string literal is not something
 * generators write, and binding one extra role is a visible, explainable error
 * rather than a silent wrong answer.
 */
const withCommentsBlanked = (code: string): string =>
  code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, " "));

/**
 * A `tools.<root>` or `tools["root"]` reference, with the optional role call
 * that follows it.
 *
 * The role is captured from either quote flavour. Anything else after the root
 * — property access, a call with an object — is left to the caller's own path
 * handling; extraction only cares which integration slot is being reached.
 */
const JSON_STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"`;
const TOOL_ROOT = String.raw`(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(${JSON_STRING_LITERAL})\s*\])`;
const TOOLS_REFERENCE = new RegExp(
  String.raw`(?<![.\w$])tools\s*${TOOL_ROOT}\s*(?:\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\))?`,
  "g",
);
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

const integrationFromMatch = (match: RegExpMatchArray | RegExpExecArray): string | null => {
  const identifier = match[1];
  if (identifier !== undefined) return identifier;
  const serialized = match[2];
  if (serialized === undefined) return null;
  const decoded = decodeJsonString(serialized);
  return Option.isSome(decoded) && decoded.value.length > 0 ? decoded.value : null;
};

const formatToolRoot = (integration: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(integration) ? `.${integration}` : `[${JSON.stringify(integration)}]`;

/**
 * An old-style address: a tier literal in the segment right after the
 * integration, i.e. `tools.<integration>.user.` / `tools.<integration>.org.`.
 *
 * Scoped to exactly those two literals in exactly that position. A tool whose
 * own first path segment is literally `user` or `org` would be caught by this
 * (`tools.acme.user.profile.get`), which is the accepted false-positive
 * surface: the two words are reserved by the address grammar itself, the shape
 * is vanishingly rare, and the error says precisely what to write instead.
 */
const OLD_STYLE_TIER_SEGMENT = new RegExp(
  String.raw`(?<![.\w$])tools\s*${TOOL_ROOT}\s*\.\s*(user|org)\s*\.`,
);

/** The message a five-segment path in artifact code is refused with. */
export const oldStyleAddressRejection = (code: string): string | null => {
  const match = OLD_STYLE_TIER_SEGMENT.exec(withCommentsBlanked(code));
  if (!match) return null;
  const integration = integrationFromMatch(match);
  const tier = match[3];
  if (integration === null || tier === undefined) return null;
  const root = formatToolRoot(integration);
  return [
    `Artifact code must not name a connection: \`tools${root}.${tier}.…\` pins this artifact to one account.`,
    `Address the integration only — \`tools${root}.<tool>(args)\` — and the server binds it to your connection when the artifact runs.`,
    `Discovery through \`execute\` still uses the full \`tools${root}.${tier}.<connection>.<tool>\` address; only saved artifact code drops the middle segments.`,
    `If this artifact needs two accounts of the same integration, tag each one with a role — \`tools${root}("prod").<tool>(args)\` — and pass \`connections: { "prod": "${integration}.${tier}.<connection>" }\` to create-artifact.`,
  ].join(" ");
};

/**
 * The integration roles an artifact's code depends on, in first-use order.
 *
 * `tools.vercel.…` contributes the implicit role `"vercel"` — the single
 * account case, where the integration slug names its own sole slot.
 * `tools.linear("prod").…` contributes the explicit role `"prod"`. Reserved
 * system roots contribute nothing. Repeat references collapse.
 */
export const extractArtifactRoles = (code: string): readonly ArtifactRole[] => {
  const scannable = withCommentsBlanked(code);
  const found = new Map<string, ArtifactRole>();
  for (const match of scannable.matchAll(TOOLS_REFERENCE)) {
    const integration = integrationFromMatch(match);
    if (integration === null || RESERVED_TOOL_ROOTS.has(integration)) continue;
    const role = match[3] ?? match[4] ?? integration;
    if (role.length === 0) continue;
    if (!found.has(role)) found.set(role, { role, integration });
  }
  return [...found.values()];
};

// ---------------------------------------------------------------------------
// Resolution at create time
// ---------------------------------------------------------------------------

/** `tools.linear.org.linearProd` or the bare `linear.org.linearProd` — both are
 *  accepted, because `connections.list` reports the prefixed form and the
 *  create-artifact contract documents the bare one. */
const parseConnectionAddress = (address: string): ArtifactBinding | null => {
  const trimmed = address.trim();
  const body = trimmed.startsWith("tools.") ? trimmed.slice("tools.".length) : trimmed;
  const [integration, owner, connection, ...rest] = body.split(".");
  if (rest.length > 0) return null;
  if (integration === undefined || integration.length === 0) return null;
  if (owner !== "user" && owner !== "org") return null;
  if (connection === undefined || connection.length === 0) return null;
  return {
    integration: IntegrationSlug.make(integration),
    owner,
    connection: ConnectionName.make(connection),
  };
};

const bindingAddress = (binding: ArtifactBinding): string =>
  `${binding.integration}.${binding.owner}.${binding.connection}`;

/** The `<integration>.<tier>.<connection>` triple, which is what `connections`
 *  takes and what every candidate list prints. */
const connectionAddress = (connection: BindableConnection | undefined): string =>
  connection === undefined
    ? ""
    : `${connection.integration}.${connection.owner}.${connection.name}`;

const candidateList = (connections: readonly BindableConnection[]): string =>
  connections.map(connectionAddress).join(", ");

/** Resolution either produces the bindings to persist, or a message for the
 *  model explaining what to pass. Never a defect: every failure here is
 *  something the model can act on. */
export type BindingResolution =
  | { readonly ok: true; readonly bindings: ArtifactBindings }
  | { readonly ok: false; readonly message: string };

/**
 * Bind every role the code uses to one of the author's connections.
 *
 * - A role named in `connections` takes that connection, once it is confirmed
 *   to exist and to belong to the role's integration.
 * - A role left out is inferred: exactly one connection for that integration
 *   binds silently (the overwhelmingly common single-account case), none or
 *   several is an error naming the candidates.
 * - A `connections` key that matches no role in the code is an error, because
 *   it means the model believes it wrote something it didn't.
 *
 * `available` is the author's full connection inventory across both tiers —
 * the scoped executor has already narrowed it to what this caller may see, so
 * inference can never bind a connection the author couldn't call themselves.
 */
export const resolveArtifactBindings = (input: {
  readonly roles: readonly ArtifactRole[];
  readonly connections?: Readonly<Record<string, string>> | undefined;
  readonly available: readonly BindableConnection[];
}): BindingResolution => {
  const supplied = input.connections ?? {};
  const byRole = new Map(input.roles.map((role) => [role.role, role]));

  // Two roles of different integrations cannot share a name: `bindings` is
  // keyed by role alone, so the collision would silently drop one of them.
  const integrationByRole = new Map<string, string>();
  for (const role of input.roles) {
    const seen = integrationByRole.get(role.role);
    if (seen !== undefined && seen !== role.integration) {
      return {
        ok: false,
        message: [
          `The role "${role.role}" is used for two different integrations (${seen} and ${role.integration}).`,
          "Each role names one connection, so give them distinct names —",
          `for example \`tools.${seen}("${seen}${role.role}")\` and \`tools.${role.integration}("${role.integration}${role.role}")\`.`,
        ].join(" "),
      };
    }
    integrationByRole.set(role.role, role.integration);
  }

  for (const role of Object.keys(supplied)) {
    if (byRole.has(role)) continue;
    const known = [...byRole.keys()];
    return {
      ok: false,
      message: [
        `connections names the role "${role}", but the code never uses it.`,
        known.length > 0
          ? `The roles this artifact uses are ${known.map((name) => `"${name}"`).join(", ")}.`
          : "The code makes no integration calls at all.",
        'A role is either the integration slug (`tools.linear.…` -> "linear") or the string passed to it (`tools.linear("prod").…` -> "prod").',
      ].join(" "),
    };
  }

  const bindings: Record<string, ArtifactBinding> = {};
  for (const { role, integration } of input.roles) {
    const requested = supplied[role];
    if (requested !== undefined) {
      const parsed = parseConnectionAddress(requested);
      if (!parsed) {
        return {
          ok: false,
          message: [
            `connections["${role}"] is not a connection address: "${requested}".`,
            "Use the `<integration>.<user|org>.<connection>` triple from `tools.executor.coreTools.connections.list({})`,",
            'for example "linear.org.linearProd".',
          ].join(" "),
        };
      }
      const match = input.available.find(
        (connection) =>
          connection.integration === parsed.integration &&
          connection.owner === parsed.owner &&
          connection.name === parsed.connection,
      );
      if (!match) {
        const candidates = input.available.filter(
          (connection) => connection.integration === integration,
        );
        return {
          ok: false,
          message: [
            `No connection "${bindingAddress(parsed)}" for role "${role}".`,
            candidates.length > 0
              ? `Choose one of ${candidateList(candidates)}.`
              : `You have no ${integration} connection; connect one first.`,
          ].join(" "),
        };
      }
      if (match.integration !== integration) {
        return {
          ok: false,
          message: [
            `Role "${role}" is used as \`tools.${integration}(…)\`, but connections["${role}"] is a ${match.integration} connection.`,
            "A role's connection must belong to the integration the code calls it on.",
          ].join(" "),
        };
      }
      bindings[role] = {
        integration: IntegrationSlug.make(integration),
        owner: match.owner,
        connection: ConnectionName.make(match.name),
      };
      continue;
    }

    const candidates = input.available.filter(
      (connection) => connection.integration === integration,
    );
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only) {
      bindings[role] = {
        integration: IntegrationSlug.make(integration),
        owner: only.owner,
        connection: ConnectionName.make(only.name),
      };
      continue;
    }
    if (candidates.length === 0) {
      return {
        ok: false,
        message: [
          `No ${integration} connection to bind role "${role}" to.`,
          `Connect ${integration} first, then create the artifact again.`,
        ].join(" "),
      };
    }
    const [first] = candidates;
    return {
      ok: false,
      message: [
        `Role "${role}" is ambiguous: you have ${candidates.length} ${integration} connections — ${candidateList(candidates)}.`,
        `Pass connections to create-artifact to choose, e.g. connections: { "${role}": "${connectionAddress(first)}" }.`,
        "To use several of them in one artifact, tag each call site with its own role —",
        `\`tools.${integration}("prod")\` / \`tools.${integration}("staging")\` — and name every role in connections.`,
      ].join(" "),
    };
  }

  return { ok: true, bindings };
};

// ---------------------------------------------------------------------------
// Resolution at execute time
// ---------------------------------------------------------------------------

/** A five-segment address, i.e. one that already carries its own tier and
 *  connection. Used only by the grandfather path below. */
const isFullAddressPath = (path: readonly string[]): boolean =>
  path.length >= 4 && (path[1] === "user" || path[1] === "org");

export type CallAddressResolution =
  | { readonly ok: true; readonly path: readonly string[] }
  | {
      readonly ok: false;
      readonly error: "binding_unresolved";
      readonly role: string;
      readonly integration: string;
      readonly message: string;
    };

/**
 * Turn one artifact-shaped call into the address the executor runs.
 *
 * `["vercel","domains","getDomains"]` with role `undefined` and a binding for
 * `"vercel"` becomes `["vercel","user","personalVercel","domains","getDomains"]`.
 * `["linear","issues","list"]` with role `"prod"` looks the binding up under
 * `"prod"` instead.
 *
 * Two paths deliberately bypass binding:
 *
 *  - **System tools.** `tools.search`, `tools.describe.*` and
 *    `tools.executor.*` name no integration and need no connection.
 *  - **Grandfathering.** Artifacts written before this contract stored
 *    five-segment paths and have `bindings: null`. Rather than migrate dev-only
 *    rows or leave them broken, a call whose path is already a well-formed
 *    address, from an artifact that has no bindings at all, executes as written.
 *    The condition is deliberately narrow: any artifact WITH bindings resolves
 *    through them, so a new artifact can never smuggle a literal connection
 *    through this door.
 */
export const resolveCallAddress = (input: {
  readonly path: readonly string[];
  readonly role?: string | undefined;
  readonly bindings: ArtifactBindings | null;
}): CallAddressResolution => {
  const [root, ...rest] = input.path;
  if (root === undefined) {
    return {
      ok: false,
      error: "binding_unresolved",
      role: "",
      integration: "",
      message: "This artifact made a tool call with no path.",
    };
  }

  if (input.role === undefined && RESERVED_TOOL_ROOTS.has(root)) {
    return { ok: true, path: input.path };
  }

  const role = input.role ?? root;
  const binding = input.bindings?.[role];
  if (binding) {
    return { ok: true, path: [binding.integration, binding.owner, binding.connection, ...rest] };
  }

  if (input.role === undefined && input.bindings === null && isFullAddressPath(input.path)) {
    return { ok: true, path: input.path };
  }

  const known = Object.keys(input.bindings ?? {});
  return {
    ok: false,
    error: "binding_unresolved",
    role,
    integration: root,
    message: [
      `This artifact has no connection bound for the role "${role}" (${root}).`,
      known.length > 0
        ? `It is bound for ${known.map((name) => `"${name}"`).join(", ")}.`
        : "It has no connection bindings at all.",
      "The connection may have been renamed or deleted since the artifact was saved — recreate it, or reconnect the integration.",
    ].join(" "),
  };
};
