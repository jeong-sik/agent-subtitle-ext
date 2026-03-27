import {
  $,
  initSharedUI,
  isDebugOpen,
  refreshDebugLog,
  toggleDebug,
} from "./ui-shared";

/**
 * Popup entry point (thin wrapper).
 *
 * Settings form, OAuth, status listener, and debug log rendering are in ui-shared.ts.
 * Popup-specific: collapsible debug toggle + 2s polling when open.
 */

document.addEventListener("DOMContentLoaded", () => {
  initSharedUI().then(() => {
    $("debug-toggle")?.addEventListener("click", toggleDebug);

    setInterval(() => {
      if (isDebugOpen()) refreshDebugLog();
    }, 2000);
  }).catch(console.error);
});
