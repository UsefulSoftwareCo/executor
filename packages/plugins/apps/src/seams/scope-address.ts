export interface ScopeAddress {
  readonly tenant: string;
  readonly scope: string;
}

export const scopeAddress = (tenant: string, scope: string): ScopeAddress => ({ tenant, scope });

// Tenant-aware keys were introduced before the apps subsystem shipped, so no
// on-disk migration is needed for the older scope-only layout.
export const scopeAddressStorageKey = (address: ScopeAddress): string =>
  `v2-${Buffer.from(JSON.stringify([address.tenant, address.scope]), "utf8").toString("hex")}`;
