import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { RegistryProvider } from "@effect/atom-react";
import { App } from "./implementation/App.tsx";
import "./implementation/styles.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 32,
            fontFamily: "monospace",
            color: "#ff6b6b",
            background: "#0b0b0b",
            minHeight: "100vh",
          }}
        >
          <h1 style={{ fontSize: 16, marginBottom: 12 }}>Application Error</h1>
          <pre style={{ fontSize: 13, whiteSpace: "pre-wrap", color: "#ede7da" }}>
            {this.state.error.message}
          </pre>
          <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", color: "#8a8478", marginTop: 8 }}>
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <RegistryProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </RegistryProvider>
  </ErrorBoundary>,
);
