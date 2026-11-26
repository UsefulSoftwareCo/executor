export const SsoRefusal = {
  emailUnverified: "sso_email_unverified",
  domainNotAllowed: "sso_domain_not_allowed",
  notMember: "sso_not_member",
  instanceNotReady: "sso_instance_not_ready",
} as const;

const explanations: Readonly<Record<string, string>> = {
  [SsoRefusal.emailUnverified]:
    "Your identity provider did not confirm that this email address is verified. Ask your administrator to have the provider mark it verified.",
  [SsoRefusal.domainNotAllowed]:
    "This email is not from a domain approved for SSO on this instance. Use an approved account or contact your administrator.",
  [SsoRefusal.notMember]:
    "Your account is not a member of this instance. Contact your administrator.",
  [SsoRefusal.instanceNotReady]:
    "This instance is not set up yet. Ask your administrator to finish setup.",
  account_not_linked:
    "This email already has a password account on this instance. Sign in with your password, then connect SSO on your account's Security page.",
};

export const ssoRefusalExplanation = (code: string): string =>
  explanations[code] ??
  "SSO sign-in failed. Use an approved account or contact your administrator.";

const linkExplanations: Readonly<Record<string, string>> = {
  email_does_not_match:
    "Your identity provider signed you in with a different email address. Connect the SSO account that uses this account's email.",
  account_already_linked_to_different_user:
    "That SSO account is already connected to another account on this instance.",
  unable_to_link_account:
    "Your identity provider did not confirm that this email address is verified, so SSO was not connected.",
};

export const ssoLinkRefusalExplanation = (code: string): string =>
  linkExplanations[code] ?? "SSO could not be connected. Try again.";
