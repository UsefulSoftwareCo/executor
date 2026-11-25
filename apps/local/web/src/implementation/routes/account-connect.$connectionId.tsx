import { createFileRoute } from "@tanstack/react-router";
import { ConnectAccountPage } from "../pages/connect-account.tsx";
export const Route = createFileRoute("/account-connect/$connectionId")({
  component: ConnectAccountPage,
});
