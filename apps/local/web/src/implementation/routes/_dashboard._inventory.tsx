import { createFileRoute } from "@tanstack/react-router";
import { InventoryLayout } from "../inventory.tsx";
export const Route = createFileRoute("/_dashboard/_inventory")({
  component: InventoryLayout,
});
