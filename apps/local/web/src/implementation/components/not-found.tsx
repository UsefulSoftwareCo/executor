import { Link } from "@tanstack/react-router";
import { Empty } from "./common.tsx";

export function NotFoundPage() {
  return (
    <Empty title="Page not found">
      <Link to="/apps">Return to Apps</Link>
    </Empty>
  );
}
