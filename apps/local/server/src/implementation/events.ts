/** Local event authority: the grant that subscribed must still exist and include the event. */
import { GrantId, grantEventAccess } from "@executor-js/mcp-auth";
import { EventAccessRevoked, type EventDeliveryAuthority } from "@executor-js/sdk/core";
import { Effect, Option } from "effect";
import type { LocalMcpOAuth } from "./mcp-oauth.ts";

/** The administrative key is the instance owner; it is never revoked by a grant change. */
const administrator = "local-administrator";

export const localEventAuthority =
  (oauth: Effect.Effect<LocalMcpOAuth>) =>
  ({ subscription }: EventDeliveryAuthority) =>
    subscription.principal === administrator
      ? Effect.void
      : Effect.gen(function* () {
          const current = yield* (yield* oauth).grant(GrantId.make(subscription.principal));
          if (Option.isNone(current)) return yield* new EventAccessRevoked();
          const access = grantEventAccess(
            current.value.grant.policy,
            subscription.app,
            subscription.event,
          );
          if (access === undefined) return yield* new EventAccessRevoked();
          // A grant limited to some profiles receives only occurrences from their accounts.
          return access;
        });
