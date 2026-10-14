import { createFileRoute } from "@tanstack/react-router";
import { V1ImportPage } from "../components/v1-import.tsx";

/** Import a single-member Executor v1 workspace; outside the dashboard, like team setup. */
export const Route = createFileRoute("/v1-import")({
  codeSplitGroupings: [],
  component: V1ImportPage,
});
