import { createHash } from "node:crypto";
import {
  Add01Icon,
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CloudIcon,
  Delete02Icon,
  Home01Icon,
  Logout01Icon,
  ServerStack01Icon,
  Settings05Icon,
  SlidersHorizontalIcon,
  Tick02Icon,
  WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import executorMark from "../../../web/public/favicon.png";

type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;

const attribute = (name: string) => name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

const icon = (nodes: IconNode, size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${nodes
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .filter(([name]) => name !== "key")
          .map(([name, value]) => `${attribute(name)}="${escape(String(value))}"`)
          .join(" ")}/>`,
    )
    .join("")}</svg>`;

export const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );

export const welcomeScheme = "executor-welcome:";
export const promptScheme = "executor-prompt:";
export const appStateScheme = "executor-app-state:";

const theme = `
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #0a0a0a; --muted: #737373; --border: #e5e5e5; --field: #ffffff; --primary: #171717; --on-primary: #fafafa; --accent: #f5f5f5; --warn: #b45309; --error: #dc2626; --card: #ffffff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 13px; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0a0a0a; --fg: #fafafa; --muted: #a3a3a3; --border: #262626; --field: #171717; --primary: #fafafa; --on-primary: #171717; --accent: #262626; --warn: #f59e0b; --error: #f87171; --card: #121212; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); -webkit-font-smoothing: antialiased; }
  button, input { font: inherit; }
  .button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-weight: 500; cursor: default; }
  .button:hover { background: var(--accent); }
  .button:focus-visible, input:focus-visible, summary:focus-visible { outline: 3px solid color-mix(in srgb, var(--fg) 25%, transparent); outline-offset: 1px; }
  .primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
  .primary:hover { background: color-mix(in srgb, var(--primary) 88%, var(--bg)); }
  .muted { color: var(--muted); }
  .link { background: none; border: 0; padding: 0; color: var(--fg); text-decoration: underline; text-underline-offset: 2px; cursor: default; }
  [role="alert"] { color: var(--error); }
`;

const document = (options: {
  readonly title: string;
  readonly actions: ReadonlyArray<string>;
  readonly style: string;
  readonly body: string;
  readonly script?: string;
}) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;${options.script === undefined ? "" : ` script-src 'sha256-${createHash("sha256").update(options.script).digest("base64")}';`} form-action ${options.actions.join(" ")}">
<title>${escape(options.title)}</title>
<style>${theme}${options.style}</style>
${options.body}${options.script === undefined ? "" : `\n<script>${options.script}</script>`}
</html>`)}`;

const welcomeStyle = `
  main { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 28px 24px 32px; }
  .logo { width: 44px; height: 44px; border-radius: 11px; }
  h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.2px; margin: 12px 0 4px; }
  .lead { margin: 0 0 18px; color: var(--muted); }
  .stack { width: 210px; display: flex; flex-direction: column; gap: 8px; }
  .stack .button { width: 100%; }
  .note { max-width: 300px; margin: 14px 0 0; line-height: 1.45; }
  details { position: fixed; top: 8px; right: 8px; text-align: left; }
  body:has(details[open]) main { opacity: 0.35; }
  summary { list-style: none; width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--muted); position: relative; }
  summary::-webkit-details-marker { display: none; }
  summary:hover, details[open] summary { background: var(--accent); color: var(--fg); }
  summary:hover::after { content: attr(data-tooltip); position: absolute; top: 34px; right: 0; white-space: nowrap; background: var(--primary); color: var(--on-primary); font-size: 12px; padding: 4px 8px; border-radius: 6px; }
  details[open] summary:hover::after { display: none; }
  .popover { position: absolute; top: 34px; right: 0; width: 270px; padding: 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--card); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); }
  .popover h2 { font-size: 13px; font-weight: 600; margin: 0 0 2px; }
  .popover p { margin: 0 0 8px; color: var(--muted); font-size: 12px; line-height: 1.45; }
  .popover input[type="url"] { width: 100%; height: 32px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--field); color: var(--fg); margin: 2px 0 10px; }
  .popover .button { width: 100%; height: 32px; }
  .popover label.confirm { display: flex; gap: 8px; align-items: center; margin: 0 0 10px; font-size: 12px; }
  .popover .warning { color: var(--warn); }
  .spinner { width: 28px; height: 28px; border-radius: 50%; border: 3px solid var(--border); border-top-color: var(--fg); animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .waiting h1 { margin-top: 14px; }
  .waiting .row { display: flex; gap: 6px; align-items: center; justify-content: center; color: var(--muted); }
`;

export interface SelfHostForm {
  readonly value: string;
  readonly error: string | undefined;
  readonly warning: string | undefined;
  readonly confirmPlain: boolean;
}

export const welcomeTitle = "Welcome to Executor";

export const welcomePage = (options: {
  readonly message: string | undefined;
  readonly note: string | undefined;
  readonly local: boolean;
  readonly selfHost: SelfHostForm | undefined;
}) => {
  const form = options.selfHost;
  return document({
    title: welcomeTitle,
    actions: [welcomeScheme],
    style: welcomeStyle,
    body: `<main>
  <img class="logo" src="${executorMark}" alt="">
  <h1>${escape(welcomeTitle)}</h1>
  <p class="lead">Your apps and accounts, on your desktop.</p>
  <form class="stack" action="${welcomeScheme}cloud" method="get">
    <button class="button primary" type="submit">Sign in</button>
    ${options.local ? `<button class="button" type="submit" formaction="${welcomeScheme}local">Run locally</button>` : ""}
  </form>
  ${options.message === undefined ? "" : `<p class="note" role="alert">${escape(options.message)}</p>`}
  ${options.note === undefined ? "" : `<p class="note muted" role="note">${escape(options.note)}</p>`}
</main>
<details${form === undefined ? "" : " open"}>
  <summary aria-label="Customize" data-tooltip="Customize">${icon(SlidersHorizontalIcon, 16)}</summary>
  <form class="popover" action="${welcomeScheme}self-host" method="get">
    <h2>Self-hosted Executor</h2>
    <p>Your organization's server address</p>
    <input id="url" name="url" type="url" required aria-label="Server address" placeholder="https://executor.yourcompany.com" value="${escape(form?.value ?? "")}"${form === undefined ? "" : " autofocus"}>
    ${form?.error === undefined ? "" : `<p role="alert">${escape(form.error)}</p>`}
    ${form?.confirmPlain === true ? `<label class="confirm"><input type="checkbox" name="plain" value="yes" required>Sign in without encryption</label>` : ""}
    ${form?.warning === undefined ? "" : `<p class="warning" role="note">${escape(form.warning)}</p>`}
    <button class="button primary" type="submit">Sign in to this server</button>
  </form>
</details>`,
  });
};

export const waitingTitle = "Finish signing in in your browser";

export const waitingPage = (host: string) =>
  document({
    title: "Executor",
    actions: [welcomeScheme],
    style: welcomeStyle,
    body: `<main class="waiting" role="status" aria-label="${escape(waitingTitle)}">
  <div class="spinner" aria-hidden="true"></div>
  <h1>${escape(waitingTitle)}</h1>
  <p class="lead">We opened ${escape(host)}. Come back here when you're done.</p>
  <form class="row" action="${welcomeScheme}reopen" method="get">
    <button class="link" type="submit">Open the page again</button>
    <span aria-hidden="true">·</span>
    <button class="link" type="submit" formaction="${welcomeScheme}cancel">Cancel</button>
  </form>
</main>`,
  });

const promptStyle = `
  body { display: grid; place-items: center; background: color-mix(in srgb, var(--bg) 92%, transparent); }
  [role="dialog"] { position: relative; width: 100%; min-height: 100vh; padding: 22px; background: var(--card); }
  .close { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border-radius: 6px; border: 0; background: none; color: var(--muted); display: flex; align-items: center; justify-content: center; }
  .close:hover { background: var(--accent); color: var(--fg); }
  .tile { position: relative; width: 46px; height: 46px; margin-bottom: 14px; }
  .tile .app { width: 46px; height: 46px; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 19px; font-weight: 600; background: linear-gradient(135deg, #1d3557, #5cd3e6); }
  .tile .team { position: absolute; right: -6px; bottom: -6px; width: 22px; height: 22px; border-radius: 6px; border: 2px solid var(--card); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 11px; font-weight: 600; }
  .tile .state { position: absolute; right: -6px; bottom: -6px; width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--card); background: var(--card); display: flex; align-items: center; justify-content: center; color: var(--warn); }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; padding-right: 24px; }
  p { margin: 0 0 18px; color: var(--muted); line-height: 1.5; }
  strong { color: var(--fg); font-weight: 500; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
`;

const markColors = ["#4b5bd6", "#2c8a63", "#8a4bd6", "#c2372f", "#c27a1f", "#1f7ac2"];
export const markColor = (name: string) =>
  markColors[[...name].reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 6] ??
  "#4b5bd6";
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";

export interface PromptText {
  readonly text: string;
  readonly strong?: boolean;
}

export interface Prompt {
  readonly title: string;
  readonly body: ReadonlyArray<PromptText>;
  readonly app: string | undefined;
  readonly team: string | undefined;
  readonly accept: string | undefined;
  readonly dismiss: string;
}

export const promptPage = (prompt: Prompt) =>
  document({
    title: prompt.title,
    actions: [promptScheme],
    style: promptStyle,
    body: `<form role="dialog" aria-modal="true" aria-labelledby="title" aria-describedby="description" action="${promptScheme}dismiss" method="get">
  <button class="close" type="submit" aria-label="Close">${icon(Cancel01Icon, 15)}</button>
  <div class="tile" aria-hidden="true"><span class="app">${escape(initial(prompt.app ?? "?"))}</span>${prompt.team === undefined ? "" : `<span class="team" style="background:${markColor(prompt.team)}">${escape(initial(prompt.team))}</span>`}</div>
  <h1 id="title">${escape(prompt.title)}</h1>
  <p id="description">${prompt.body.map((part) => (part.strong === true ? `<strong>${escape(part.text)}</strong>` : escape(part.text))).join("")}</p>
  <div class="actions">
    <button class="button" type="submit"${prompt.accept === undefined ? " autofocus" : ""}>${escape(prompt.dismiss)}</button>
    ${prompt.accept === undefined ? "" : `<button class="button primary" type="submit" formaction="${promptScheme}accept" autofocus>${escape(prompt.accept)}</button>`}
  </div>
</form>`,
  });

const stateStyle = `
  main { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 32px; }
  .mark { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--accent); color: var(--muted); margin-bottom: 14px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: var(--muted); max-width: 380px; line-height: 1.5; }
  .actions { display: flex; gap: 8px; }
`;

export type AppState = "signed-out" | "gone" | "offline";

export const appStatePage = (options: {
  readonly state: AppState;
  readonly name: string;
  readonly team: string | undefined;
  readonly host: string;
}) => {
  const { name, team, host } = options;
  const content = {
    "signed-out": {
      icon: Alert02Icon,
      title: `Sign in again to open ${name}`,
      detail: `${team ?? host} signed this computer out, so ${name} can't open until you sign in again. Your installed apps stay here.`,
      actions: [
        { action: "close", label: "Close", primary: false },
        { action: "sign-in", label: "Sign in again", primary: true },
      ],
    },
    gone: {
      icon: Alert02Icon,
      title: `${name} is no longer available`,
      detail: `${host} no longer has ${name}, or it no longer has a page to open. It may have been removed, or you may have lost access to it.`,
      actions: [
        { action: "close", label: "Close", primary: false },
        { action: "uninstall", label: "Uninstall", primary: true },
      ],
    },
    offline: {
      icon: WifiDisconnected01Icon,
      title: `Can't reach ${host}`,
      detail: `${name} opens once Executor can reach ${host} again. Check your connection, then try again.`,
      actions: [
        { action: "close", label: "Close", primary: false },
        { action: "retry", label: "Retry", primary: true },
      ],
    },
  }[options.state];
  return document({
    title: name,
    actions: [appStateScheme],
    style: stateStyle,
    body: `<main role="alert" aria-labelledby="title">
  <div class="mark">${icon(content.icon, 20)}</div>
  <h1 id="title">${escape(content.title)}</h1>
  <p>${escape(content.detail)}</p>
  <form class="actions" method="get" action="${appStateScheme}close">
    ${content.actions
      .map(
        (entry) =>
          `<button class="button${entry.primary ? " primary" : ""}" type="submit" formaction="${appStateScheme}${entry.action}"${entry.primary ? " autofocus" : ""}>${escape(entry.label)}</button>`,
      )
      .join("\n    ")}
  </form>
</main>`,
  });
};

const menuStyle = `
  body { min-height: 0; background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  main { padding: 5px; }
  .label { padding: 8px; min-width: 0; }
  .label .name { font-size: 13px; font-weight: 500; }
  .label .sub, .item .sub { font-size: 11px; color: var(--muted); }
  .label .name, .label .sub, .item .text > span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 4px -5px; }
  .caption { padding: 6px 8px 4px; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
  .accounts { max-height: 264px; overflow-y: auto; }
  .row { position: relative; }
  .item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 8px; border: 0; border-radius: 4px; background: none; color: var(--fg); font-size: 13px; text-align: left; cursor: default; }
  .item:hover, .item:focus-visible { background: var(--accent); outline: none; }
  .item svg { flex: none; }
  .item .text { min-width: 0; flex: 1; }
  .account { min-height: 40px; }
  .account[aria-current="true"] { background: color-mix(in srgb, var(--accent) 60%, transparent); }
  .account.away { opacity: 0.6; }
  .row:has(.pill) .account { padding-right: 70px; }
  .sub.again { color: #d97706; }
  .pill { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); border: 1px solid var(--border); border-radius: 6px; padding: 2px 6px; background: var(--card); color: var(--muted); font-size: 11px; cursor: default; }
  .pill:hover, .pill:focus-visible { color: var(--fg); }
  .mark { position: relative; flex: none; width: 20px; height: 20px; border-radius: 5px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; font-weight: 600; }
  .mark.plain { background: var(--accent); color: var(--fg); }
  .mark .dot { position: absolute; right: -3px; bottom: -3px; width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--card); background: var(--muted); }
  .mark .dot.again { background: #f59e0b; }
  .mark .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--fg); animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .mark .spin { animation: none; } }
`;

export interface MenuAccount {
  readonly id: string;
  readonly kind: "local" | "self-host" | "cloud";
  readonly team: string;
  readonly host: string;
  readonly state: "signed-in" | "sign-in-again" | "unreachable" | "waiting";
}

export interface AccountMenu {
  readonly view: "accounts" | "add";
  readonly current: MenuAccount;
  readonly email: string | undefined;
  readonly accounts: ReadonlyArray<MenuAccount>;
  readonly local: boolean;
  readonly settings: boolean;
}

export const accountMenuTitle = "Account menu";

const menuItem = (options: {
  readonly action: string;
  readonly icon: IconNode;
  readonly label: string;
  readonly detail?: string;
  readonly account?: string;
  readonly trailing?: IconNode;
}) =>
  `<button class="item" type="button" role="menuitem" data-action="${options.action}"${options.account === undefined ? "" : ` data-for="${escape(options.account)}"`}>${icon(options.icon, 16)}${options.detail === undefined ? `<span class="text"><span>${escape(options.label)}</span></span>` : `<span class="text"><span>${escape(options.label)}</span><span class="sub">${escape(options.detail)}</span></span>`}${options.trailing === undefined ? "" : icon(options.trailing, 14)}</button>`;

const accountName = (account: MenuAccount) =>
  account.kind === "local" ? "This computer" : account.team;

const accountDetail = (account: MenuAccount) => {
  if (account.kind === "local") return "local";
  switch (account.state) {
    case "sign-in-again":
      return "Sign in again";
    case "unreachable":
      return `Can't reach ${account.host}`;
    case "waiting":
      return "Waiting for your browser…";
    case "signed-in":
      return account.host;
  }
};

const accountMark = (account: MenuAccount) => {
  const plain = account.kind === "local" || account.state === "waiting";
  const inner =
    account.state === "waiting"
      ? `<span class="spin"></span>`
      : account.kind === "local"
        ? icon(Home01Icon, 12)
        : escape(initial(account.team));
  const dot =
    account.state === "sign-in-again"
      ? `<span class="dot again"></span>`
      : account.state === "unreachable"
        ? `<span class="dot"></span>`
        : "";
  return `<span class="mark${plain ? " plain" : ""}" aria-hidden="true"${plain ? "" : ` style="background:${markColor(account.team)}"`}>${inner}${dot}</span>`;
};

const accountPill = (account: MenuAccount) => {
  switch (account.state) {
    case "sign-in-again":
      return { action: "sign-in-again", label: "Sign in" };
    case "unreachable":
      return { action: "retry", label: "Retry" };
    case "waiting":
      return { action: "cancel", label: "Cancel" };
    case "signed-in":
      return undefined;
  }
};

const accountRow = (account: MenuAccount, current: boolean) => {
  const pill = accountPill(account);
  return `<div class="row" data-account="${escape(account.id)}" data-kind="${account.kind}" data-state="${account.state}" data-team="${escape(account.team)}" data-host="${escape(account.host)}">
      <button class="item account${account.state === "unreachable" ? " away" : ""}" type="button" role="menuitem" data-action="select" data-for="${escape(account.id)}"${current ? ` aria-current="true" autofocus` : ""}>${accountMark(account)}<span class="text"><span title="${escape(account.team)}">${escape(accountName(account))}</span><span class="sub${account.state === "sign-in-again" && account.kind !== "local" ? " again" : ""}">${escape(accountDetail(account))}</span></span>${current && pill === undefined ? icon(Tick02Icon, 14) : ""}</button>${
        pill === undefined
          ? ""
          : `
      <button class="pill" type="button" data-action="${pill.action}" data-for="${escape(account.id)}">${escape(pill.label)}</button>`
      }
    </div>`;
};

const menuAccounts = (menu: AccountMenu) => {
  const { current } = menu;
  const others = menu.accounts.filter((account) => account.id !== current.id);
  const hosted = current.kind !== "local";
  const choices =
    current.kind === "local" && others.length === 0
      ? [
          menuItem({
            action: "cloud",
            icon: CloudIcon,
            label: "Sign in to Executor Cloud",
            detail: "Use your team's apps here too",
          }),
          menuItem({ action: "self-host", icon: ServerStack01Icon, label: "Self-hosted server…" }),
        ]
      : [
          `<div class="caption" aria-hidden="true">Switch to</div>`,
          `<div class="accounts" role="group" aria-label="Accounts on this computer">
    ${menu.accounts.map((account) => accountRow(account, account.id === current.id)).join("\n    ")}
  </div>`,
          menuItem({
            action: "add",
            icon: Add01Icon,
            label: "Add account",
            trailing: ArrowRight01Icon,
          }),
        ];
  const footer = [
    ...(menu.settings
      ? [menuItem({ action: "settings", icon: Settings05Icon, label: "Account settings" })]
      : []),
    ...(hosted
      ? [
          menuItem({
            action: "sign-out",
            icon: Logout01Icon,
            label: `Sign out of ${current.team}`,
          }),
          menuItem({
            action: "remove",
            icon: Delete02Icon,
            label: "Remove from this computer…",
            account: current.id,
          }),
        ]
      : []),
  ];
  return `<div class="label"><span class="name">${escape(hosted ? current.team : "This computer")}</span><span class="sub">${escape(hosted ? (menu.email ?? current.host) : "Executor running locally")}</span></div>
  <hr>
  ${choices.join("\n  ")}${footer.length === 0 ? "" : `\n  <hr>\n  ${footer.join("\n  ")}`}`;
};

const menuAdd = (menu: AccountMenu) =>
  [
    menuItem({ action: "back", icon: ArrowLeft01Icon, label: "Add account" }),
    "<hr>",
    menuItem({ action: "cloud", icon: CloudIcon, label: "Sign in to Executor Cloud" }),
    ...(menu.local
      ? []
      : [menuItem({ action: "run-locally", icon: Home01Icon, label: "Run locally" })]),
    menuItem({ action: "self-host", icon: ServerStack01Icon, label: "Self-hosted server…" }),
  ].join("\n  ");

const menuKeys = `const choose = (action, account) => window.executorAccountMenu.choose(action, account ?? null);
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (button === null) return;
  event.preventDefault();
  choose(button.getAttribute("data-action"), button.getAttribute("data-for"));
});
document.addEventListener("keydown", (event) => {
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  const at = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    choose("close");
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : items.length - 1;
    items[at < 0 ? (step === 1 ? 0 : items.length - 1) : (at + step) % items.length]?.focus();
  }
});`;

const menuMain = (menu: AccountMenu) =>
  `<main role="menu" aria-label="${menu.view === "add" ? "Add account" : accountMenuTitle}">
  ${menu.view === "add" ? menuAdd(menu) : menuAccounts(menu)}
</main>`;

export const accountMenuPage = (menu: AccountMenu) =>
  document({
    title: accountMenuTitle,
    actions: ["'none'"],
    style: menuStyle,
    script: menuKeys,
    body: menuMain(menu),
  });

export const accountMenuUpdate = (menu: AccountMenu) => `(() => {
  const keyOf = (element) =>
    element === null ? "" : \`\${element.getAttribute("data-action") ?? ""} \${element.getAttribute("data-for") ?? ""}\`;
  const active = keyOf(document.activeElement);
  const main = document.querySelector("main");
  const next = ${JSON.stringify(menuMain(menu))};
  if (main !== null && main.outerHTML !== next) main.outerHTML = next;
  const buttons = [...document.querySelectorAll("button")];
  const focused = buttons.find((button) => keyOf(button) === active) ?? document.querySelector("[autofocus]") ?? buttons[0];
  if (focused !== document.activeElement) focused?.focus();
  return Math.ceil(document.body.getBoundingClientRect().height);
})()`;

export const pageAction = (scheme: string, value: string) => {
  const url = URL.parse(value);
  if (url === null || url.protocol !== scheme) return undefined;
  return { action: url.pathname, params: url.searchParams };
};
