import type { Integration } from "@executor-js/sdk/shared";

// ---------------------------------------------------------------------------
// Integration grid grouping — a provider whose plugin fans out into several
// per-service integrations (Google → Calendar, Gmail, Drive; Microsoft → Mail,
// Calendar, Teams) can leave the catalog with 6-12 flat sibling rows. Those
// families collapse under a single provider umbrella; every other integration
// stays exactly where it was.
// ---------------------------------------------------------------------------

/** Plugin kinds whose integrations are collapsed under a provider umbrella.
 *  These are the multi-service provider plugins: one plugin owns many
 *  per-service integrations that share a provider identity. */
export const MULTI_SERVICE_FAMILIES: ReadonlySet<string> = new Set(["google", "microsoft"]);

/** Human label for a family umbrella, keyed by plugin kind. Falls back to a
 *  title-cased kind so a new family is never unlabeled. */
const FAMILY_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

export const familyLabel = (kind: string): string =>
  FAMILY_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);

export const isMultiServiceFamily = (kind: string): boolean => MULTI_SERVICE_FAMILIES.has(kind);

/** A run of integrations sharing a provider family, rendered under one umbrella
 *  header. Only families with more than one member group; a lone family member
 *  renders flat (see `groupIntegrations`). */
export interface IntegrationFamilyGroup {
  readonly type: "group";
  readonly kind: string;
  readonly label: string;
  readonly members: readonly Integration[];
}

export interface IntegrationSingle {
  readonly type: "single";
  readonly integration: Integration;
}

export type IntegrationGridItem = IntegrationFamilyGroup | IntegrationSingle;

/**
 * Partition the flat integration list into an ordered mix of family groups and
 * standalone integrations. Ordering is stable: a group appears where its FIRST
 * member would have appeared in the original list, and non-family integrations
 * keep their original position relative to it. A family with a single member is
 * emitted as a standalone integration (a one-item umbrella adds chrome without
 * grouping anything).
 */
export function groupIntegrations(
  integrations: readonly Integration[],
): readonly IntegrationGridItem[] {
  // First pass: count members per family so singletons can be rendered flat.
  const familyCounts = new Map<string, number>();
  for (const integration of integrations) {
    if (isMultiServiceFamily(integration.kind)) {
      familyCounts.set(integration.kind, (familyCounts.get(integration.kind) ?? 0) + 1);
    }
  }

  const items: IntegrationGridItem[] = [];
  const groupIndexByKind = new Map<string, number>();

  for (const integration of integrations) {
    const grouped =
      isMultiServiceFamily(integration.kind) && (familyCounts.get(integration.kind) ?? 0) > 1;

    if (!grouped) {
      items.push({ type: "single", integration });
      continue;
    }

    const existing = groupIndexByKind.get(integration.kind);
    if (existing === undefined) {
      groupIndexByKind.set(integration.kind, items.length);
      items.push({
        type: "group",
        kind: integration.kind,
        label: familyLabel(integration.kind),
        members: [integration],
      });
    } else {
      const group = items[existing] as IntegrationFamilyGroup;
      items[existing] = { ...group, members: [...group.members, integration] };
    }
  }

  return items;
}
