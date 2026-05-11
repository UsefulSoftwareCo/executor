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

export function sourceDisplayNameFromUrl(url: string, sourceKind: string): string | null {
  const label = domainLabelFromUrl(url);
  const displayLabel = label ? pascalCaseDomainLabel(label) : null;
  return displayLabel ? `${displayLabel} ${sourceKind}` : null;
}

// ---------------------------------------------------------------------------
// Hook — owns the name + namespace state with namespace auto-derivation
// ---------------------------------------------------------------------------

export interface SourceIdentity {
  /** Display name — the user's override if they've typed one, otherwise the fallback. */
  readonly name: string;
  /** Namespace — the user's override if they've typed one, otherwise slugified from `name`. */
  readonly namespace: string;
  readonly setName: (name: string) => void;
  readonly setNamespace: (namespace: string) => void;
  /** Clears any user overrides so both fields return to deriving from the fallback. */
  readonly reset: () => void;
}

export interface UseSourceIdentityOptions {
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
export function useSourceIdentity(options?: UseSourceIdentityOptions): SourceIdentity {
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

export interface SourceIdentityFieldsProps {
  readonly identity: SourceIdentity;
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

export function SourceIdentityFields({
  identity,
  namePlaceholder = "e.g. Sentry API",
  namespacePlaceholder = "sentry_api",
  nameLabel = "Display Name",
  namespaceHint,
  namespaceReadOnly = false,
}: SourceIdentityFieldsProps) {
  const effectiveNamespaceHint =
    namespaceHint ??
    (namespaceReadOnly
      ? "The namespace is part of the source's identity and cannot be changed."
      : undefined);

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <SourceIdentityFieldRows
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

export function SourceIdentityFieldRows({
  identity,
  namePlaceholder = "e.g. Sentry API",
  namespacePlaceholder = "sentry_api",
  nameLabel = "Display Name",
  namespaceHint,
  namespaceReadOnly = false,
}: SourceIdentityFieldsProps) {
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
