import { createFileRoute } from "@tanstack/react-router";
import { JoinPage } from "../../web/pages/join";

export const Route = createFileRoute("/join")({
  component: JoinPage,
});
