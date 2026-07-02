import type { IntegrationSlug } from "@executor-js/sdk/shared";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { integrationsOptimisticAtom } from "@executor-js/react/api/atoms";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { GraphqlClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms — v2 is integration-centric. The graphql HTTP surface exposes
// only the catalog integration (`getIntegration` → its stored config, which
// carries the `authenticationTemplate[]`). Connections are created through the
// core API (`createConnection` / `oauth.start`), not through this plugin's
// surface.
// ---------------------------------------------------------------------------

export const graphqlIntegrationConfigAtom = (slug: IntegrationSlug) =>
  GraphqlClient.query("graphql", "getIntegration", {
    params: { slug: String(slug) },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

// The full opaque config (including `authenticationTemplate`), used by the
// configure UX to render existing auth methods and add custom ones.
export const graphqlConfigAtom = (slug: IntegrationSlug) =>
  GraphqlClient.query("graphql", "getConfig", {
    params: { slug: String(slug) },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const addGraphqlIntegration = GraphqlClient.mutation("graphql", "addIntegration");

// Merge-append custom auth methods onto an integration's `authenticationTemplate`.
export const graphqlConfigure = GraphqlClient.mutation("graphql", "configure");

// Optimistically slot a pending row into the shared integration catalog so the
// integrations list reflects the new GraphQL integration before the server
// round-trips. The reducer mirrors the catalog `Integration` shape.
export const addGraphqlIntegrationOptimistic = integrationsOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (
      current,
      arg: {
        readonly payload: {
          readonly endpoint: string;
          readonly slug?: string;
          readonly name?: string;
        };
      },
    ) =>
      AsyncResult.map(current, (rows) => {
        const slug = (arg.payload.slug ??
          `pending-${Math.random().toString(36).slice(2)}`) as IntegrationSlug;
        const integration = {
          slug,
          kind: "graphql",
          name: arg.payload.name ?? arg.payload.endpoint,
          description: arg.payload.name ?? arg.payload.endpoint,
          canRemove: false,
          canRefresh: false,
          authMethods: [],
        };
        return [integration, ...rows.filter((row) => row.slug !== slug)].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      }),
    fn: addGraphqlIntegration,
  }),
);
