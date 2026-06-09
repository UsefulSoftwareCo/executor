import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/sources/$namespace")({
  beforeLoad: ({ params }) => {
    const { namespace } = params;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TanStack Router redirects are modeled as thrown values
    throw redirect({ to: "/integrations/$namespace", params: { namespace } });
  },
});
