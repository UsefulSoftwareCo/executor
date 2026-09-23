import { CloudLoginPage } from "../pages/login.tsx";
import { createFileRoute } from "@tanstack/react-router";
import { loginSearch } from "@executor-js/hosted-web/pages/login";

/** Each host mounts the same login UI on its own origin. */
export const Route = createFileRoute("/login")({
  codeSplitGroupings: [],
  validateSearch: (search) => ({
    ...loginSearch(search),
    ...(search.mode === "signup" ? { mode: "signup" as const } : {}),
  }),
  component: () => <CloudLoginPage {...Route.useSearch()} />,
});
