import { createFileRoute } from "@tanstack/react-router";
import { DashboardLayout } from "../app.tsx";
import { NotFoundPage } from "../components/not-found.tsx";
/** Generated-tree route for /_dashboard. */
export const Route = createFileRoute("/_dashboard")({
  notFoundComponent: NotFoundPage,
  component: DashboardLayout,
});
