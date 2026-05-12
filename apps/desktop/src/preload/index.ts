// Renderer ↔ main bridge.
//
// The Electron main process attaches the Basic auth header to outbound
// requests via session.webRequest, so the renderer does not need any
// auth knowledge today. This preload is kept minimal but reserved for
// future capabilities (e.g. native menus, updater status).
export {};
