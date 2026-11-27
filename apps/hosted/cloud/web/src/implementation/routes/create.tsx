import { createFileRoute } from "@tanstack/react-router";
import { CreateTeamPage } from "../components/team-setup.tsx";

export const Route = createFileRoute("/create")({
  codeSplitGroupings: [],
  component: CreateTeamPage,
});
