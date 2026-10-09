import { useEffect, useRef } from "react";
import type { AppId } from "@executor-js/sdk";
import type { SetupSearch } from "../../contracts/navigation.ts";
import { useNavigate } from "@tanstack/react-router";

/** Setup links land on the app's Accounts tab, where accounts are connected and chosen. */
export function AccountSelectionPage({ id, profile }: { readonly id: AppId } & SetupSearch) {
  const navigate = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void navigate({
      to: "/apps/$appId",
      params: { appId: id },
      search: { view: "accounts", profile },
      replace: true,
    });
  });
  return null;
}
