import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$organizationSlug/api-keys")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/account/tokens",
      search: { organization: params.organizationSlug },
      replace: true,
    });
  },
});
