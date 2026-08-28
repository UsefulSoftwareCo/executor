/**
 * Classification of `BrowserWindow.loadURL` rejections.
 *
 * Chromium cancels an in-flight navigation when the window it belongs to is
 * destroyed, and reports the cancellation as a generic net error (ERR_FAILED
 * / ERR_ABORTED / ERR_CONNECTION_RESET). That is a shutdown race with no
 * diagnostic value. The same net errors under a live window mean the local
 * server genuinely could not be loaded, which must still surface — so this is
 * a branch, never a blanket ignore.
 */

const TEARDOWN_NET_ERRORS = /ERR_FAILED|ERR_ABORTED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/;

export interface NavigationAbortInput {
  readonly message: string;
  readonly windowDestroyed: boolean;
  readonly appQuitting: boolean;
}

export const isExpectedNavigationAbort = (input: NavigationAbortInput): boolean =>
  (input.windowDestroyed || input.appQuitting) && TEARDOWN_NET_ERRORS.test(input.message);
