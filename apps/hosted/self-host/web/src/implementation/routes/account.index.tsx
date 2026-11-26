import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/account/")({
  beforeLoad: () => {
    throw redirect({ to: "/account/profile", replace: true });
  },
});
