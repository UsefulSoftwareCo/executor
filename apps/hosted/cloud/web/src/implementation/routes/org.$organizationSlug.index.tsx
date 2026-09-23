import { createFileRoute, redirect } from "@tanstack/react-router";

/** An organization root opens its inventory without consulting a session preference. */
export const Route = createFileRoute("/org/$organizationSlug/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/org/$organizationSlug/apps", params, replace: true });
  },
});
