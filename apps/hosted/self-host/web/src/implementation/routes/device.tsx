import { createFileRoute } from "@tanstack/react-router";
import { DevicePage, deviceSearch } from "@executor-js/hosted-web/pages/device";

/** RFC 8628 verification: approve a device's sign-in by its code. */
export const Route = createFileRoute("/device")({
  validateSearch: deviceSearch,
  component: () => <DevicePage {...Route.useSearch()} />,
});
