import {
  $,
  initSharedUI,
  isDebugOpen,
  refreshDebugLog,
  toggleDebug,
  updateStatusDisplay,
} from "./ui-shared";
import type { ConnectionStatus } from "./types";

/**
 * Popup entry point (thin wrapper).
 *
 * Settings form, OAuth, and debug log rendering are in ui-shared.ts.
 * Popup-specific: collapsible debug toggle + 2s polling when open.
 */

document.addEventListener("DOMContentLoaded", () => {
  initSharedUI().then(() => {
    $("debug-toggle")?.addEventListener("click", toggleDebug);

    // Popup polls debug log every 2s when debug panel is open
    setInterval(() => {
      if (isDebugOpen()) refreshDebugLog();
    }, 2000);
  }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATUS_UPDATE") {
    updateStatusDisplay(message.status as ConnectionStatus);
  }
});
