import { createFileRoute } from "@tanstack/react-router";
import { NotFoundPage } from "../components/not-found.tsx";
export const Route = createFileRoute("/_dashboard/_inventory/$")({
  component: NotFoundPage,
});
