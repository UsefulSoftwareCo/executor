import { Redacted } from "effect";
import type { AuthEmail, UnsubscribeLinks } from "../contracts/email.ts";

/** Shared with Better Auth so the message always states the code's actual lifetime. */
export const emailCodeExpiresIn = 300;

const purposes = {
  "sign-in": {
    heading: "Your sign-in code",
    instruction: "Copy and paste this code into Executor to sign in.",
  },
  "email-verification": {
    heading: "Verify your email address",
    instruction: "Copy and paste this code into Executor to verify your email address.",
  },
  "forget-password": {
    heading: "Your password reset code",
    instruction: "Copy and paste this code into Executor to reset your password.",
  },
  "change-email": {
    heading: "Confirm your new email address",
    instruction: "Copy and paste this code into Executor to confirm your new email address.",
  },
};

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
}: {
  readonly email: string;
  readonly id: string;
  readonly organizationName: string;
  readonly origin: string;
}): AuthEmail => {
  const invitationUrl = `${origin}/invite?invitation=${encodeURIComponent(id)}`;
  const name = escapeHtml(organizationName);
  const link = escapeHtml(invitationUrl);
  const instruction = "Sign in with this email address to accept.";
  const unsolicited = "If you did not expect this invitation, ignore this email.";
  return {
    to: email,
    subject: "You’re invited to Executor",
    text: Redacted.make(
      `You’re invited to join ${organizationName} on Executor.\n\n${invitationUrl}\n\n${instruction} ${unsolicited}`,
    ),
    html: Redacted.make(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>You’re invited to Executor</title></head>
<body style="margin:0;padding:0;background:#f6f6f6;color:#171717;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">You’re invited to join ${name} on Executor.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td align="center" style="padding:40px 16px;">
    <!--[if mso]><table role="presentation" width="520" align="center"><tr><td><![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" align="center" style="width:100%;max-width:520px;table-layout:fixed;border-collapse:separate;border-spacing:0;">
      <tr><td style="padding:0 0 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
          <td width="32" valign="middle"><img src="https://executor.sh/favicon-192.png" alt="" width="32" height="32" style="display:block;width:32px;height:32px;border:0;border-radius:6px;"></td>
          <td valign="middle" style="padding-left:10px;font-size:20px;line-height:28px;font-weight:700;letter-spacing:-0.5px;">Executor</td>
        </tr></table>
      </td></tr>
      <tr><td bgcolor="#ffffff" style="padding:32px 28px;border:1px solid #e5e5e5;border-radius:12px;background:#ffffff;">
        <p style="margin:0 0 16px;color:#666666;font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.5px;">TEAM INVITATION</p>
        <h1 style="margin:0 0 16px;font-size:28px;line-height:36px;letter-spacing:-0.7px;font-weight:700;">You’re invited.</h1>
        <p style="margin:0 0 28px;color:#444444;font-size:16px;line-height:26px;overflow-wrap:anywhere;word-break:break-word;">Join <strong style="color:#171717;">${name}</strong> on Executor.</p>
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
 * A personal, all-lowercase welcome with matching text and HTML; recipient names are
 * escaped, never markup. It carries one starter prompt with the deployment's MCP URL and
 * the docs link, and the unsubscribe link is an ordinary sentence rather than a footer.
 */
export const welcomeEmailMessage = (
  email: string,
  name: string,
  links: UnsubscribeLinks,
  origin: string,
): AuthEmail => {
  // IaC serves the docs and MCP endpoint on the same canonical cloud origin.
  const docsUrl = `${origin}/docs`;
  const firstName = name.trim().split(/\s+/)[0];
  const greeting = firstName && !firstName.includes("@") ? `hey ${firstName},` : "hey there,";
  const starterPrompt = `add the executor mcp server at ${origin}/mcp, then read the executor docs at ${docsUrl} and work out how you can best use executor to help me.`;
  const paragraphs = [
    greeting,
    "i'm rhys, founder of executor - thanks for signing up!",
    "quick heads up: i hate getting emails as much as you do, so you won't get many from me. when i do send one, i'll make sure it's worth opening.",
    "on to the useful part. if you're still working out where to start, here's a prompt you can hand to your agent:",
    `"${starterPrompt}"`,
    "if you get stuck or have questions, just reply. this was an automated email but replies go straight to me, and i'd love to hear what you're using executor for.",
  ];
  const unsubscribeLead = "and if you'd rather not get these at all, the unsubscribe link is";
  const unsubscribeUrl = Redacted.value(links.browser);
  return {
    to: email,
    subject: "welcome to executor",
    text: Redacted.make(
      `${paragraphs.join("\n\n")}\n\n${unsubscribeLead} right here: ${unsubscribeUrl}`,
    ),
    html: Redacted.make(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>welcome to executor</title></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#171717;">${paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}<p>${escapeHtml(unsubscribeLead)} <a style="color:#171717;" href="${escapeHtml(unsubscribeUrl)}">right here</a></p></body></html>`,
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
}: {
  email: string;
  otp: string;
  type: keyof typeof purposes;
}): AuthEmail => {
  const { heading, instruction } = purposes[type];
  const expiry = `This code expires in ${emailCodeExpiresIn / 60} minutes. Never share this code with anyone.`;
  const unsolicited = "If you didn't request this, you can safely ignore this email.";
  return {
    to: email,
    subject: type === "sign-in" ? "Your Executor sign-in code" : `Executor: ${heading}`,
    text: Redacted.make(
      `Executor\n\n${heading}\n\n${instruction}\n\n${otp}\n\n${expiry}\n\n${unsolicited}`,
    ),
    html: Redacted.make(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:0;background:#f6f6f6;color:#171717;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" style="width:100%;border-collapse:collapse;"><tr><td style="padding:40px 16px;">
    <table role="presentation" align="center" style="width:100%;max-width:480px;border-collapse:collapse;background:#ffffff;"><tr><td style="padding:32px;">
      <p style="margin:0 0 32px;font-size:18px;font-weight:700;">Executor</p>
      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;">${heading}</h1>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">${instruction}</p>
      <p style="margin:0 0 24px;padding:20px 12px;background:#f3f3f3;text-align:center;font-family:Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:6px;">${escapeHtml(otp)}</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">${expiry}</p>
      <p style="margin:0;color:#595959;font-size:14px;line-height:1.6;">${unsolicited}</p>
    </td></tr></table>
  </td></tr></table>
</body>
</html>`),
  };
};
