import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { CreditCardIcon } from "@hugeicons/core-free-icons";

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
