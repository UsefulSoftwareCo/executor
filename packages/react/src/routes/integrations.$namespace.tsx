import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";

import { IntegrationDetailPage } from "../pages/integration-detail";
import type { IntegrationDetailSearchTab } from "../lib/integration-detail-tabs";

// `addAccount=1` opens the add-connection flow on arrival. It is declared here
// (rather than only read off `window.location`) because unlisted keys do not
// survive validation: a CLIENT-SIDE navigation carrying the handoff — the
// `/connect/<slug>` deep link — would otherwise have it stripped before the
// page could see it. The richer handoff fields stay URL-only; they arrive on
// full page loads from agent-generated links.
//
// Typed as unknown and coerced, not as a literal, for two reasons. A URL flag
// must never hard-fail a page: a hand-edited `?addAccount=banana` should be
// ignored, not rendered as a validation error. And the router's search
// serializer quotes a string "1" (`addAccount=%221%22`) while leaving the
// number 1 bare, so accepting both is what keeps ONE canonical URL —
// `?addAccount=1` — shared by deep links and agent-generated handoff links.
const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    tab: Schema.optional(Schema.Literals(["accounts", "source", "tools"])),
    addAccount: Schema.optional(Schema.Unknown),
    tool: Schema.optional(Schema.String),
  }),
);

/** The truthy spellings of the `addAccount` URL flag. */
export const isAddAccountRequested = (value: unknown): boolean =>
  value === 1 || value === "1" || value === true;

export const Route = createFileRoute("/{-$orgSlug}/integrations/$namespace")({
  validateSearch: SearchParams,
  component: () => {
    const { namespace } = Route.useParams();
    const { tab, addAccount, tool } = Route.useSearch();
    return (
      <IntegrationDetailPage
        namespace={namespace}
        tab={tab as IntegrationDetailSearchTab | undefined}
        tool={tool}
        addAccount={isAddAccountRequested(addAccount)}
      />
    );
  },
});
