// ---------------------------------------------------------------------------
// openOAuthPopup — browser popup opener for OAuth flows.
//
// Opens a centered popup window pointed at an authorization URL, listens
// for the result via `postMessage` and `BroadcastChannel` (Safari fallback),
// and settles exactly once. Has NO React-specific imports so it can be used
// from any browser context, but lives under the `/react` entry to signal
// it is browser-only and should not be imported from Node / worker code.
// ---------------------------------------------------------------------------

import {
  isOAuthPopupResult as sharedIsOAuthPopupResult,
  type OAuthPopupResult,
} from "@executor-js/sdk";

export { OAUTH_POPUP_MESSAGE_TYPE } from "@executor-js/sdk";
export type { OAuthPopupResult } from "@executor-js/sdk";

export const isOAuthPopupResult = sharedIsOAuthPopupResult;

// ---------------------------------------------------------------------------
// openOAuthPopup
// ---------------------------------------------------------------------------

export type OpenOAuthPopupInput<TAuth> = {
  readonly url: string;
  readonly onResult: (data: OAuthPopupResult<TAuth>) => void;
  readonly reservedPopup?: ReservedOAuthPopup;
  /** Ignore popup messages for any other in-flight OAuth session. */
  readonly expectedSessionId?: string;
  /** `window.open` target name — also used to focus an existing popup. */
  readonly popupName: string;
  /** BroadcastChannel name, must match the server-side `popupDocument` channel. */
  readonly channelName: string;
  readonly onOpenFailed?: () => void;
  /**
   * Called if the user closes the popup window without completing the
   * flow (detected via a `popup.closed` poll). NOT called when the popup
   * closes itself after a successful result post — `onResult` handles
   * that path. Also not called if the caller invokes the teardown
   * function returned from this function.
   */
  readonly onClosed?: () => void;
  readonly width?: number;
  readonly height?: number;
  /** How often to poll `popup.closed`. Default 500ms. Set to null to disable. */
  readonly closedPollMs?: number | null;
};

export type ReservedOAuthPopup = {
  readonly popup: Window;
};

const isHttpPopupUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:";
};

const oauthPopupFeatures = (input: { readonly width?: number; readonly height?: number }) => {
  const w = input.width ?? 640;
  const h = input.height ?? 760;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  return `width=${w},height=${h},left=${left},top=${top},popup=1`;
};

export const reserveOAuthPopup = (input: {
  readonly popupName: string;
  readonly width?: number;
  readonly height?: number;
}): ReservedOAuthPopup | null => {
  const popup = window.open("about:blank", input.popupName, oauthPopupFeatures(input));
  if (!popup) return null;
  // The app keeps a WindowProxy for navigation/closed polling, but the
  // provider should not receive opener access after the reserved window
  // is navigated cross-origin. The callback uses BroadcastChannel.
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: popup opener access can throw in browser-specific states
  try {
    popup.opener = null;
  } catch {
    // Best-effort hardening; the popup handle is still usable for the flow.
  }
  return { popup };
};

/**
 * Open a centered popup window at `url` and resolve when the popup posts
 * an `OAuthPopupResult` back to the opener. Returns a teardown function
 * that removes the listeners, stops polling, and closes the popup window.
 *
 * Settles exactly once via one of three paths:
 *   1. `onResult`      — popup posted a message back (success or error)
 *   2. `onClosed`      — user closed the popup without completing the flow,
 *                        unless `closedPollMs` is null
 *   3. teardown called — caller cancelled programmatically
 *
 * If the popup is blocked (`window.open` returns null), invokes
 * `onOpenFailed` on the next microtask and returns a no-op teardown.
 */
export const openOAuthPopup = <TAuth>(input: OpenOAuthPopupInput<TAuth>): (() => void) => {
  if (!isHttpPopupUrl(input.url)) {
    queueMicrotask(() => input.onOpenFailed?.());
    return () => {};
  }

  let settled = false;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  const channel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(input.channelName) : null;

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    handleResult(event.data);
  };

  const stopPolling = () => {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  };

  /** Close the popup window if it's still open. Swallows cross-origin errors. */
  const closePopup = (popup: Window | null) => {
    if (!popup) return;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: cross-origin popup state can throw and cleanup is best-effort
    try {
      if (!popup.closed) popup.close();
    } catch {
      // Cross-origin access can throw; safe to ignore.
    }
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    window.removeEventListener("message", onMessage);
    channel?.close();
    stopPolling();
  };

  const handleResult = (data: unknown) => {
    if (!isOAuthPopupResult<TAuth>(data) || settled) return;
    if (input.expectedSessionId && data.sessionId !== input.expectedSessionId) return;
    settle();
    input.onResult(data);
  };

  window.addEventListener("message", onMessage);
  if (channel) channel.onmessage = (event) => handleResult(event.data);

  const popup =
    input.reservedPopup?.popup ??
    reserveOAuthPopup({
      popupName: input.popupName,
      width: input.width,
      height: input.height,
    })?.popup ??
    null;
  if (!popup) {
    if (!settled) {
      settle();
      queueMicrotask(() => input.onOpenFailed?.());
    }
    return () => {};
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: popup navigation can fail if the browser has invalidated the handle
  try {
    popup.location.href = input.url;
  } catch {
    if (!settled) {
      settle();
      queueMicrotask(() => input.onOpenFailed?.());
    }
    return () => {};
  }

  // Some providers use COOP headers that can make a live cross-origin
  // popup look closed to the opener. Callers can disable polling and rely
  // on the explicit cancel path plus BroadcastChannel completion.
  const pollMs = input.closedPollMs === undefined ? 500 : input.closedPollMs;
  if (pollMs !== null) {
    pollHandle = setInterval(() => {
      let isClosed = false;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: browser popup.closed can throw while navigating cross-origin
      try {
        isClosed = popup.closed;
      } catch {
        // Cross-origin access can throw during navigation; treat as open.
      }
      if (isClosed && !settled) {
        settle();
        input.onClosed?.();
      }
    }, pollMs);
  }

  return () => {
    if (settled) return;
    settle();
    closePopup(popup);
  };
};
