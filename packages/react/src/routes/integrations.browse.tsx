import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";

import { IntegrationBrowsePage } from "../pages/integration-browse";

const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({ onboarding: Schema.optional(Schema.Unknown) }),
);

const isOnboardingRequested = (value: unknown): boolean =>
  value === 1 || value === "1" || value === true;

export const Route = createFileRoute("/{-$orgSlug}/integrations/browse")({
  validateSearch: SearchParams,
  component: () => {
    const { onboarding } = Route.useSearch();
    return <IntegrationBrowsePage onboarding={isOnboardingRequested(onboarding)} />;
  },
});
