import { useCallback, useState } from "react";
import { parse } from "tldts";

import { CardStack, CardStackContent, CardStackEntryField } from "../components/card-stack";
import { Input } from "../components/input";
import { normalizeNamespaceInput, slugifyNamespace } from "./namespace";
export { normalizeNamespaceInput, slugifyNamespace } from "./namespace";

/**
 * Derives a display-name candidate from a URL by extracting its apex domain
 * label (e.g. `https://api.shopify.com/graphql` → `"Shopify"`) and
 * title-casing it. Returns `null` if the URL has no parseable domain.
 */
export function displayNameFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const parsed = parse(trimmed);
  const label = parsed.domainWithoutSuffix;
  if (!label) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function domainLabelFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  return parse(trimmed).domainWithoutSuffix ?? null;
}

export function pascalCaseDomainLabel(label: string): string | null {
  const words = label
    .split(/[^a-z0-9]+/i)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return null;
  return words
    .map((word) => {
      const normalized = word.toLowerCase();
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join("");
}

export function integrationDisplayNameFromUrl(url: string, sourceKind: string): string | null {
  const label = domainLabelFromUrl(url);
  const displayLabel = label ? pascalCaseDomainLabel(label) : null;
  return displayLabel ? `${displayLabel} ${sourceKind}` : null;
}

// Package runners whose own name is never the integration name: the meaningful
// token is the package or module they execute, not the runner itself.
const STDIO_RUNNERS = new Set([
  "npx",
  "bunx",
  "pnpm",
  "yarn",
  "npm",
  "uvx",
  "uv",
  "pipx",
  "bun",
  "deno",
  "node",
  "python",
  "python3",
]);

// Subcommands that sit between a runner and its package: `pnpm dlx <pkg>`,
// `npm exec <pkg>`, `uv run <pkg>`, `deno run <spec>`.
const STDIO_RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "run", "x", "--"]);

/**
 * Picks the package/module spec from a stdio launch command: the first
 * positional argument that isn't a runner flag or subcommand, falling back to
 * the command itself when it isn't a generic runner (a server invoked
 * directly). Returns `null` when only a bare runner is present.
 */
export function stdioPackageToken(command: string, args: readonly string[]): string | null {
  for (const raw of args) {
    const arg = raw.trim();
    if (!arg || arg.startsWith("-")) continue; // skip flags like -y, --yes
    if (STDIO_RUNNER_SUBCOMMANDS.has(arg)) continue; // skip dlx / exec / run
    return arg;
  }
  const cmd = command.trim();
  if (!cmd || STDIO_RUNNERS.has(cmd.toLowerCase())) return null;
  return cmd;
}

/**
 * Reduces a package/module spec to human words: drops an npm scope, a version
 * or tag suffix, a path and file extension, and the noise affixes MCP packages
 * conventionally carry (`mcp-server-`, `server-`, `-mcp`), then title-cases.
 * Returns `null` when nothing alphanumeric survives.
 */
export function humanizeStdioToken(token: string): string | null {
  let name = token.trim();
  if (name.startsWith("@")) {
    // Scoped npm package: @modelcontextprotocol/server-github → server-github.
    name = name.split("/").pop() ?? name;
  } else if (/[\\/]/.test(name)) {
    // A filesystem path (node ./build/index.js) → its base filename.
    name = name.split(/[\\/]/).pop() ?? name;
    name = name.replace(/\.[a-z0-9]+$/i, ""); // strip extension
  }
  name = name.replace(/@[^@/]*$/, "") || name; // drop a trailing @version / @tag
  name = name
    .replace(/^mcp[-_]server[-_]/i, "")
    .replace(/^mcp[-_]/i, "")
    .replace(/^server[-_]/i, "")
    .replace(/[-_]mcp[-_]server$/i, "")
    .replace(/[-_]mcp$/i, "")
    .replace(/[-_]server$/i, "");
  const words = name
    .split(/[^a-z0-9]+/i)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

/**
 * Derives a display-name candidate from a stdio launch command by extracting
 * the package/module being run and humanizing it, e.g.
 * `npx -y @modelcontextprotocol/server-github` → `"Github MCP"`,
 * `uvx mcp-server-time` → `"Time MCP"`, `node ./build/index.js` → `"Index MCP"`.
 * Returns `null` when nothing meaningful can be extracted, so callers can fall
 * back to the raw command.
 */
export function integrationDisplayNameFromStdio(
  command: string,
  args: readonly string[],
  sourceKind: string,
): string | null {
  const token = stdioPackageToken(command, args);
  const label = token ? humanizeStdioToken(token) : null;
  return label ? `${label} ${sourceKind}` : null;
}

// ---------------------------------------------------------------------------
// Hook — owns the name + namespace state with namespace auto-derivation
// ---------------------------------------------------------------------------

export interface IntegrationIdentity {
  /** Display name — the user's override if they've typed one, otherwise the fallback. */
  readonly name: string;
  /** Namespace — the user's override if they've typed one, otherwise slugified from `name`. */
  readonly namespace: string;
  readonly setName: (name: string) => void;
  readonly setNamespace: (namespace: string) => void;
  /** Clears any user overrides so both fields return to deriving from the fallback. */
  readonly reset: () => void;
}

export interface UseIntegrationIdentityOptions {
  /**
   * Fallback display name — used when the user hasn't typed one. Pass a
   * value computed from the caller's reactive state (probe result, URL
   * apex domain, template default, etc.) and it'll flow through to `name`
   * automatically.
   */
  readonly fallbackName?: string;
  /** Fallback namespace — defaults to `slugifyNamespace(fallbackName ?? "")`. */
  readonly fallbackNamespace?: string;
}

/**
 * Manages a display name and a derived namespace. Both fields are pure
 * derived state: the user's `setName` / `setNamespace` call stores an
 * override, otherwise the hook returns the caller-supplied fallback
 * (passed fresh on every render). Call `reset()` to drop overrides.
 */
export function useIntegrationIdentity(
  options?: UseIntegrationIdentityOptions,
): IntegrationIdentity {
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [namespaceOverride, setNamespaceOverride] = useState<string | null>(null);

  const fallbackName = options?.fallbackName ?? "";
  const name = nameOverride ?? fallbackName;
  const fallbackNamespace = options?.fallbackNamespace ?? slugifyNamespace(name);
  const namespace = namespaceOverride ?? fallbackNamespace;

  const setName = useCallback((next: string) => {
    setNameOverride(next);
  }, []);

  const setNamespace = useCallback((next: string) => {
    setNamespaceOverride(normalizeNamespaceInput(next));
  }, []);

  const reset = useCallback(() => {
    setNameOverride(null);
    setNamespaceOverride(null);
  }, []);

  return { name, namespace, setName, setNamespace, reset };
}

// ---------------------------------------------------------------------------
// UI — two fields, wrapped in a shared CardStack
// ---------------------------------------------------------------------------

export interface IntegrationIdentityFieldsProps {
  readonly identity: IntegrationIdentity;
  readonly namePlaceholder?: string;
  readonly namespacePlaceholder?: string;
  readonly nameLabel?: string;
  readonly namespaceHint?: string;
  /**
   * When true, the namespace field is rendered disabled — useful on Edit
   * forms, where the namespace is the source's identity and changing it
   * would require a delete + recreate flow.
   */
  readonly namespaceReadOnly?: boolean;
}

export function IntegrationIdentityFields({
  identity,
  namePlaceholder = "e.g. Sentry API",
  namespacePlaceholder = "sentry_api",
  nameLabel = "Display Name",
  namespaceHint,
  namespaceReadOnly = false,
}: IntegrationIdentityFieldsProps) {
  const effectiveNamespaceHint =
    namespaceHint ??
    (namespaceReadOnly
      ? "The namespace is part of the source's identity and cannot be changed."
      : undefined);

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <IntegrationIdentityFieldRows
          identity={identity}
          namePlaceholder={namePlaceholder}
          namespacePlaceholder={namespacePlaceholder}
          nameLabel={nameLabel}
          namespaceHint={effectiveNamespaceHint}
          namespaceReadOnly={namespaceReadOnly}
        />
      </CardStackContent>
    </CardStack>
  );
}

export function IntegrationIdentityFieldRows({
  identity,
  namePlaceholder = "e.g. Sentry API",
  namespacePlaceholder = "sentry_api",
  nameLabel = "Display Name",
  namespaceHint,
  namespaceReadOnly = false,
}: IntegrationIdentityFieldsProps) {
  const effectiveNamespaceHint =
    namespaceHint ??
    (namespaceReadOnly
      ? "The namespace is part of the source's identity and cannot be changed."
      : undefined);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2">
      <CardStackEntryField label={nameLabel}>
        <Input
          value={identity.name}
          onChange={(e) => identity.setName((e.target as HTMLInputElement).value)}
          placeholder={namePlaceholder}
          className="text-sm"
        />
      </CardStackEntryField>
      <CardStackEntryField label="Namespace" hint={effectiveNamespaceHint}>
        <Input
          value={identity.namespace}
          onChange={(e) => identity.setNamespace((e.target as HTMLInputElement).value)}
          placeholder={namespacePlaceholder}
          className="font-mono text-sm"
          disabled={namespaceReadOnly}
        />
      </CardStackEntryField>
    </div>
  );
}
