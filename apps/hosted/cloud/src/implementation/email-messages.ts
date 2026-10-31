import { Redacted } from "effect";
import type { AuthEmail, UnsubscribeLinks } from "../contracts/email.ts";
import {
  defaultProductBrand,
  productLogoUrl,
  type ProductBrand,
} from "@executor-js/utils/product-brand";

/** Shared with Better Auth so the message always states the code's actual lifetime. */
export const emailCodeExpiresIn = 300;

const purposes = (product: string) => ({
  "sign-in": {
    heading: "Your sign-in code",
    instruction: `Copy and paste this code into ${product} to sign in.`,
  },
  /** A sign-in code for an email with no account yet; verifying it creates the account. */
  "sign-up": {
    heading: "Your sign-up code",
    instruction: `Copy and paste this code into ${product} to create your account.`,
  },
  /** Sent to the current address; an email change needs this code before the new address gets one. */
  "email-verification": {
    heading: "Approve your email change",
    instruction: `Someone asked to change the email address of your ${product} account. Copy and paste this code into ${product} to approve the change.`,
  },
  "forget-password": {
    heading: "Your password reset code",
    instruction: `Copy and paste this code into ${product} to reset your password.`,
  },
  "change-email": {
    heading: "Confirm your new email address",
    instruction: `Copy and paste this code into ${product} to confirm your new email address.`,
  },
});

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** Render a team invite with one acceptance URL in HTML and text; both payloads contain a secret. */
export const invitationEmailMessage = ({
  email,
  id,
  organizationName,
  origin,
  brand,
}: {
  readonly email: string;
  readonly id: string;
  readonly organizationName: string;
  readonly origin: string;
  readonly brand: ProductBrand;
}): AuthEmail => {
  const product = escapeHtml(brand.name);
  // Executor's own logo comes from its site, so every stage's mail shows the same image.
  const logo = escapeHtml(
    brand.logo === defaultProductBrand.logo
      ? "https://executor.sh/favicon-192.png"
      : productLogoUrl(brand, origin),
  );
  const invitationUrl = `${origin}/invite?invitation=${encodeURIComponent(id)}`;
  const name = escapeHtml(organizationName);
  const link = escapeHtml(invitationUrl);
  const instruction = "Sign in with this email address to accept.";
  const unsolicited = "If you did not expect this invitation, ignore this email.";
  return {
    to: email,
    subject: `You’re invited to ${brand.name}`,
    text: Redacted.make(
      `You’re invited to join ${organizationName} on ${brand.name}.\n\n${invitationUrl}\n\n${instruction} ${unsolicited}`,
    ),
    html: Redacted.make(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>You’re invited to ${product}</title></head>
<body style="margin:0;padding:0;background:#f6f6f6;color:#171717;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">You’re invited to join ${name} on ${product}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td align="center" style="padding:40px 16px;">
    <!--[if mso]><table role="presentation" width="520" align="center"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:520px;table-layout:fixed;border-collapse:separate;border-spacing:0;">
      <tr><td style="padding:0 0 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
          <td width="32" valign="middle"><img src="${logo}" alt="" width="32" height="32" style="display:block;width:32px;height:32px;border:0;border-radius:6px;"></td>
          <td valign="middle" style="padding-left:10px;font-size:20px;line-height:28px;font-weight:700;letter-spacing:-0.5px;">${product}</td>
        </tr></table>
      </td></tr>
      <tr><td bgcolor="#ffffff" style="padding:32px 28px;border:1px solid #e5e5e5;border-radius:12px;background:#ffffff;">
        <p style="margin:0 0 16px;color:#666666;font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.5px;">TEAM INVITATION</p>
        <h1 style="margin:0 0 16px;font-size:28px;line-height:36px;letter-spacing:-0.7px;font-weight:700;">You’re invited.</h1>
        <p style="margin:0 0 28px;color:#444444;font-size:16px;line-height:26px;overflow-wrap:anywhere;word-break:break-word;">Join <strong style="color:#171717;">${name}</strong> on ${product}.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;"><tr><td align="center" bgcolor="#0a0a0a" style="border-radius:6px;background:#0a0a0a;mso-padding-alt:14px 24px;">
          <a href="${link}" style="display:inline-block;border:solid #0a0a0a;border-width:14px 24px;border-radius:6px;color:#ffffff;font-size:15px;line-height:20px;font-weight:700;text-align:center;text-decoration:none;mso-padding-alt:0;">Join team</a>
        </td></tr></table>
        <p style="margin:20px 0 0;color:#666666;font-size:13px;line-height:21px;">${instruction}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;border-collapse:collapse;margin-top:28px;"><tr><td style="border-top:1px solid #eeeeee;padding-top:24px;">
          <p style="margin:0 0 8px;color:#666666;font-size:12px;line-height:20px;">Or copy and paste this link into your browser:</p>
          <a href="${link}" style="color:#444444;font-size:12px;line-height:20px;text-decoration:underline;overflow-wrap:anywhere;word-break:break-all;">${link}</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:20px 4px 0;color:#666666;font-size:12px;line-height:20px;">${unsolicited}</td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr></table>
</body>
</html>`),
  };
};

/**
 * The docs live on the site origin, the edge when the deployment has role hosts; the MCP
 * endpoint is on the canonical MCP origin.
 */
export interface WelcomeEmailOrigins {
  readonly site: string;
  readonly resourceOrigin: string;
}

/**
 * A personal welcome with matching text and HTML; recipient names are escaped, never
 * markup. It carries one starter prompt with the deployment's MCP URL and the docs link.
 * The body reads as a direct note, so unsubscribing is left to the inbox's
 * List-Unsubscribe control.
 */
export const welcomeEmailMessage = (
  email: string,
  name: string,
  links: UnsubscribeLinks,
  origins: WelcomeEmailOrigins,
): AuthEmail => {
  const docsUrl = `${origins.site}/docs`;
  const firstName = name.trim().split(/\s+/)[0];
  const greeting = firstName && !firstName.includes("@") ? `Hey ${firstName},` : "Hey there,";
  const starterPrompt = `Add the Executor MCP server at ${origins.resourceOrigin}/mcp, then read the Executor docs at ${docsUrl} and work out how you can best use Executor to help me.`;
  const paragraphs = [
    greeting,
    "I'm Rhys, founder of Executor. Thanks for signing up!",
    "Here's a prompt you can hand to your agent to get started:",
    `"${starterPrompt}"`,
    "This is an email directly from me. If you reply, it comes straight to my inbox. I'd love to hear from you if you need any help or have feedback.",
    "I hope you enjoy Executor.",
  ];
  const signOff = ["Best,", "Rhys"];
  const subject = "Welcome to Executor";
  return {
    to: email,
    subject,
    text: Redacted.make([...paragraphs, signOff.join("\n")].join("\n\n")),
    html: Redacted.make(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${subject}</title></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#171717;">${paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}<p>${signOff.map(escapeHtml).join("<br>")}</p></body></html>`,
    ),
    headers: Redacted.make({
      "List-Unsubscribe": `<${Redacted.value(links.oneClick)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }),
  };
};

/** Render a compact code email with equivalent HTML and text; neither payload is log-safe. */
export const emailCodeMessage = ({
  email,
  otp,
  type,
  brand,
}: {
  email: string;
  otp: string;
  type: keyof ReturnType<typeof purposes>;
  brand: ProductBrand;
}): AuthEmail => {
  const { heading, instruction } = purposes(brand.name)[type];
  const expiry = `This code expires in ${emailCodeExpiresIn / 60} minutes. Never share this code with anyone.`;
  const unsolicited = "If you didn't request this, you can safely ignore this email.";
  return {
    to: email,
    subject:
      type === "sign-in" || type === "sign-up"
        ? `Your ${brand.name} ${type} code`
        : `${brand.name}: ${heading}`,
    text: Redacted.make(
      `${brand.name}\n\n${heading}\n\n${instruction}\n\n${otp}\n\n${expiry}\n\n${unsolicited}`,
    ),
    html: Redacted.make(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:0;background:#f6f6f6;color:#171717;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" style="width:100%;border-collapse:collapse;"><tr><td style="padding:40px 16px;">
    <table role="presentation" align="center" style="width:100%;max-width:480px;border-collapse:collapse;background:#ffffff;"><tr><td style="padding:32px;">
      <p style="margin:0 0 32px;font-size:18px;font-weight:700;">${escapeHtml(brand.name)}</p>
      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;">${heading}</h1>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${escapeHtml(instruction)}</p>
      <p style="margin:0 0 24px;padding:20px 12px;background:#f3f3f3;text-align:center;font-family:Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:6px;">${escapeHtml(otp)}</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">${expiry}</p>
      <p style="margin:0;color:#595959;font-size:14px;line-height:1.6;">${unsolicited}</p>
    </td></tr></table>
  </td></tr></table>
</body>
</html>`),
  };
};
