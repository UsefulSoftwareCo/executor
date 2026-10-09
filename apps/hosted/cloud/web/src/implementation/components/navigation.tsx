import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { CreditCardIcon } from "@hugeicons/core-free-icons";

/**
 * Cloud's organization pages beside the common ones; self-host has no billing. Like the common
 * links, it stays disabled in the pending frame until the organization slug is known.
 */
export function CloudNavigation({
  organizationSlug,
  pendingPage,
}: {
  readonly organizationSlug?: string;
  readonly pendingPage?: string;
}) {
  const content = (
    <>
      <HugeiconsIcon icon={CreditCardIcon} strokeWidth={2} size={16} aria-hidden />
      Billing
    </>
  );
  if (organizationSlug === undefined)
    return (
      <a
        role="link"
        aria-disabled="true"
        tabIndex={-1}
        aria-current={pendingPage === "billing" ? "page" : undefined}
        className={pendingPage === "billing" ? "active pointer-events-none" : "pointer-events-none"}
      >
        {content}
      </a>
    );
  return (
    <Link
      to="/org/$organizationSlug/billing"
      params={{ organizationSlug }}
      activeProps={{ className: "active", "aria-current": "page" }}
    >
      {content}
    </Link>
  );
}
