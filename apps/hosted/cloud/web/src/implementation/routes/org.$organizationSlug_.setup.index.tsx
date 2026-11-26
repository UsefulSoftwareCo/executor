import { createFileRoute } from "@tanstack/react-router";
import { SetupStart } from "../components/team-setup.tsx";

export const Route = createFileRoute("/org/$organizationSlug_/setup/")({
  codeSplitGroupings: [],
  component: SetupStart,
});
