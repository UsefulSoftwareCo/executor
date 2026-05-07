import { createFileRoute } from "@tanstack/react-router";
import { SourcesPage } from "@executor-js/react/pages/sources";

export const Route = createFileRoute("/$org/")({
  component: SourcesPage,
});
