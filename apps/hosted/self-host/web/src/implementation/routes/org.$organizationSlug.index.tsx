import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$organizationSlug/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/org/$organizationSlug/apps", params, replace: true });
  },
});
