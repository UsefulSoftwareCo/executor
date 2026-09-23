/** Host-owned watcher also works when an app has no queries or its JavaScript fails. */
const installAppWatch = () => {
  const context = document.getElementById("executor-context")?.textContent;
  if (!context) return;
  const pinned: unknown = JSON.parse(context);
  if (typeof pinned !== "object" || pinned === null || !("deployment" in pinned)) return;
  const deployment = pinned.deployment;
  if (typeof deployment !== "string" || deployment.length === 0) return;
  const stream = new EventSource("/_executor/version");
  let reloading = false;
  const reload = () => {
    if (reloading) return;
    reloading = true;
    stream.close();
    location.reload();
  };
  stream.addEventListener("version", (event) => {
    const current: unknown = JSON.parse(event.data);
    if (
      typeof current === "object" &&
      current !== null &&
      "deployment" in current &&
      (current.deployment === null || typeof current.deployment === "string") &&
      current.deployment !== deployment
    )
      reload();
  });
  stream.addEventListener("revoked", reload);
  window.addEventListener("executor:deployment-changed", reload);
  window.addEventListener("pagehide", () => stream.close(), { once: true });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) reload();
  });
};

/** Dependency-free browser source served by each host after app authorization. */
export const appWatchScript = `(${installAppWatch.toString()})()`;
