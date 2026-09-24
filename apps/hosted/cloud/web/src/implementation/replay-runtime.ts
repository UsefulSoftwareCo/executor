/**
 * Registers the replay recorder on window.__PosthogExtensions__ so the SDK never fetches
 * /static/posthog-recorder.js, a filename that EasyPrivacy blocks on any origin. Loaded
 * lazily from a neutrally named chunk so signed-out pages do not pay for rrweb.
 */
import "posthog-js/dist/posthog-recorder";
