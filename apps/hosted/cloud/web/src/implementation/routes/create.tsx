import { createFileRoute } from "@tanstack/react-router";
import { CreateTeamPage } from "../components/team-setup.tsx";

/** First-team setup renders outside the dashboard and redirects resolved memberships. */
export const Route = createFileRoute("/create")({
  codeSplitGroupings: [],
  component: CreateTeamPage,
});
