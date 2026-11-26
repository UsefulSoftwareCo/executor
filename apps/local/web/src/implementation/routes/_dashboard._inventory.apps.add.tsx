import { createFileRoute } from "@tanstack/react-router";
import { CatalogPage } from "../pages/catalog.tsx";
export const Route = createFileRoute("/_dashboard/_inventory/apps/add")({
  staticData: { section: "apps" },
  component: CatalogPage,
});
