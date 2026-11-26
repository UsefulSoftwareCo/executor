import { CloudLoginPage } from "../pages/login.tsx";
import { createFileRoute } from "@tanstack/react-router";
import { loginProps, loginSearch } from "@executor-js/hosted-web/pages/login";

export const Route = createFileRoute("/login")({
  codeSplitGroupings: [],
  validateSearch: (search) => ({
    ...loginSearch(search),
    ...(search.mode === "signup" ? { mode: "signup" as const } : {}),
  }),
  component: () => {
    const search = Route.useSearch();
    return <CloudLoginPage {...search} {...loginProps(search)} />;
  },
});
