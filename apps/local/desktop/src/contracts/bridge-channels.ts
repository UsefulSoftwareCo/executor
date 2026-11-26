export type BridgeReply<A = unknown> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: unknown };

export const desktopChannels = {
  hostServer: "executor-host:server",
  hostCall: "executor-host:call",
  hostAccount: "executor-host:account",
  hostInstalled: "executor-host:installed",
  menuChoice: "executor-menu:choice",
  appHello: "executor-app:hello",
  appCall: "executor-app:call",
  appNotification: "executor-app:notification",
  appShortcut: "executor-app:shortcut",
  appWindowEvent: "executor-app:window-event",
} as const;
