import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "@executor-js/react/globals.css";

import { getRouter } from "./router";

// The whole app — shell, pages, and the multiplayer surface — is the shared
// @executor-js/react composition wired in routes/__root.tsx. Cloudflare Access
// is the identity (validated at the edge), so there is no login screen.
const router = getRouter();
const rootElement = document.getElementById("root");

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<RouterProvider router={router} />);
}
