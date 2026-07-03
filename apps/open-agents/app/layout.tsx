import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const themeInitializationScript = `
(() => {
  const storageKey = "open-agents-theme";
  const darkModeMediaQuery = "(prefers-color-scheme: dark)";
  const storedTheme = window.localStorage.getItem(storageKey);

  const theme =
    storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
      ? storedTheme
      : "system";

  const resolvedTheme =
    theme === "system"
      ? window.matchMedia(darkModeMediaQuery).matches
        ? "dark"
        : "light"
      : theme;

  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
})();
`;

const hmrDebugScript = `
(() => {
  if (window.__openAgentsHmrProbeInstalled) {
    return;
  }

  window.__openAgentsHmrProbeInstalled = true;

  const NativeWebSocket = window.WebSocket;
  let nextConnectionId = 0;

  function isHmrUrl(url) {
    const value = typeof url === "string" ? url : url.href;
    return value.includes("/_next/webpack-hmr");
  }

  function InstrumentedWebSocket(url, protocols) {
    const socket =
      protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);

    if (!isHmrUrl(url)) {
      return socket;
    }

    const connectionId = ++nextConnectionId;
    const connectionUrl = typeof url === "string" ? url : url.href;
    const loggedAt = () => new Date().toISOString();

    console.info("[open-agents:hmr]", "create", {
      connectionId,
      connectionUrl,
      loggedAt: loggedAt(),
    });

    socket.addEventListener("open", () => {
      console.info("[open-agents:hmr]", "open", {
        connectionId,
        loggedAt: loggedAt(),
      });
    });

    socket.addEventListener("close", (event) => {
      console.warn("[open-agents:hmr]", "close", {
        connectionId,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        loggedAt: loggedAt(),
      });
    });

    socket.addEventListener("error", () => {
      console.error("[open-agents:hmr]", "error", {
        connectionId,
        loggedAt: loggedAt(),
      });
    });

    return socket;
  }

  Object.setPrototypeOf(InstrumentedWebSocket, NativeWebSocket);
  InstrumentedWebSocket.prototype = NativeWebSocket.prototype;
  window.WebSocket = InstrumentedWebSocket;
  console.info("[open-agents:hmr]", "probe-installed");
})();
`;

const isPreviewDeployment = process.env.VERCEL_ENV === "preview";
const faviconPath = isPreviewDeployment
  ? "/favicon-preview.svg"
  : "/favicon.ico";
const metadataBase =
  process.env.VERCEL_ENV === "production" &&
  process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    : process.env.VERCEL_URL
      ? new URL(`https://${process.env.VERCEL_URL}`)
      : new URL("https://open-agents.dev");

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: "Open Agents",
    template: "%s | Open Agents",
  },
  description:
    "Spawn coding agents that run infinitely in the cloud. Powered by AI SDK, Gateway, Sandbox, and Workflow SDK.",
  icons: {
    icon: faviconPath,
    shortcut: faviconPath,
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans overflow-x-hidden antialiased`}
      >
        <script
          dangerouslySetInnerHTML={{ __html: themeInitializationScript }}
        />
        {process.env.NODE_ENV === "development" ? (
          <script dangerouslySetInnerHTML={{ __html: hmrDebugScript }} />
        ) : null}
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
