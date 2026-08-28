import type { Owner } from "./ids";

export const AUDIT_EVENT_ACTIONS = ["created", "updated", "removed"] as const;
export type AuditEventAction = (typeof AUDIT_EVENT_ACTIONS)[number];

export const AUDIT_RESOURCE_TYPES = ["connection", "integration", "oauth_client"] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/** A durable, tenant-scoped record of a user-intent configuration mutation.
 * Credential values and provider item ids are deliberately never recorded. */
export interface AdminAuditEvent {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: AuditEventAction;
  readonly resourceType: AuditResourceType;
  readonly resourceOwner: Owner | null;
  /** Parent namespace for a resource. Connections use their integration slug. */
  readonly resourceParent: string | null;
  /** The resource's own stable identifier (connection name, integration slug,
   *  or OAuth-client slug). */
  readonly resourceId: string;
  readonly createdAt: Date;
}

export interface AdminListAuditEventsOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly actorId?: string;
  readonly action?: AuditEventAction;
  readonly resourceType?: AuditResourceType;
  readonly resourceOwner?: Owner;
}

export interface AuditEventInput {
  readonly action: AuditEventAction;
  readonly resourceType: AuditResourceType;
  readonly resourceOwner?: Owner | null;
  readonly resourceParent?: string | null;
  readonly resourceId: string;
}
