import { useEffect, useRef } from "react";
import type { AppId } from "@executor-js/sdk";
import { useNavigate } from "@tanstack/react-router";

export function AccountSelectionPage({ id }: { readonly id: AppId }) {
  const navigate = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void navigate({
      to: "/apps/$appId",
      params: { appId: id },
      search: { view: "accounts" },
      replace: true,
    });
  });
  return null;
}
