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

    $("open-sidepanel-btn")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" }).catch(console.error);
      window.close();
    });

    setInterval(() => {
      if (isDebugOpen()) refreshDebugLog();
    }, 2000);
  }).catch(console.error);
});
