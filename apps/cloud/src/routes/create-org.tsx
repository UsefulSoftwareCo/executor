import { createFileRoute } from "@tanstack/react-router";
import { CreateOrgPage } from "../web/pages/create-org";

export const Route = createFileRoute("/create-org")({
  component: CreateOrgPage,
});
