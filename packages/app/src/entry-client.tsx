import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { bootstrapLocalAuthToken } from "@executor-js/react/api/local-auth";
import { getRouter } from "./router";
import { initDesktopCrashReporting } from "./crash-reporting";
import "@executor-js/react/globals.css";

initDesktopCrashReporting();

if ("executor" in window && navigator.platform.includes("Mac")) {
  document.documentElement.classList.add("executor-desktop-macos");
}

// Resolve the local bearer token (?_token → localStorage → dev global) and set
// the connection's auth BEFORE the router mounts, so the first API atom carries
// it. No-op on desktop (the main process injects the header).
bootstrapLocalAuthToken();

const router = getRouter();

ReactDOM.createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
