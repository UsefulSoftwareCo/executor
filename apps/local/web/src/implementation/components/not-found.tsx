import { Link } from "@tanstack/react-router";
import { Empty } from "./common.tsx";

/** Missing or malformed routes have a safe destination in the dashboard. */
export function NotFoundPage() {
  return (
    <Empty title="Page not found">
      <Link to="/apps">Return to Apps</Link>
    </Empty>
  );
}
