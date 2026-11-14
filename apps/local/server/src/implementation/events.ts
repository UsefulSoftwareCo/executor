/**
 * Local event authority: the grant that subscribed must still exist and include the event. A
 * subscription to a selection of several events or apps drops an occurrence the grant does not
 * include, and continues for the others.
 */
import { GrantId, grantEventAccess } from "@executor-js/mcp-auth";
import {
  EventAccessRevoked,
  EventNotVisible,
  type EventDeliveryAuthority,
} from "@executor-js/sdk/core";
import { Effect, Option } from "effect";
import type { LocalMcpOAuth } from "./mcp-oauth.ts";

/** The administrative key is the instance owner; it is never revoked by a grant change. */
const administrator = "local-administrator";

export const localEventAuthority =
  (oauth: Effect.Effect<LocalMcpOAuth>) =>
  ({ subscription, app, event }: EventDeliveryAuthority) =>
    subscription.principal === administrator
      ? Effect.void
      : Effect.gen(function* () {
          const current = yield* (yield* oauth).grant(GrantId.make(subscription.principal));
          if (Option.isNone(current)) return yield* new EventAccessRevoked();
          const access = grantEventAccess(current.value.grant.policy, app, event);
          if (access === undefined)
            return yield* subscription.app === null || subscription.event === null
              ? new EventNotVisible()
              : new EventAccessRevoked();
          // A grant limited to some accounts receives only occurrences from those accounts.
          return access;
        });
