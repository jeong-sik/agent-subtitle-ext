import {
  $,
  initSharedUI,
  refreshDebugLog,
  appendDebugEntryToUI,
} from "./ui-shared";
import type { DebugEntry, TranslationProgress } from "./types";

/**
 * Side panel entry point.
 *
 * Stays open while watching YouTube (unlike popup).
 * Receives real-time PROGRESS_UPDATE and DEBUG_LOG_PUSH from background.
 */

let currentProgress: TranslationProgress | null = null;
let wallTimerInterval: ReturnType<typeof setInterval> | null = null;

function renderProgress(progress: TranslationProgress): void {
  currentProgress = progress;
  const section = $("progress-section");
  const fill = $("progress-bar-fill") as HTMLDivElement | null;
  const segCount = $("segment-count");
  const batchCount = $("batch-count");
  const tokSec = $("tok-per-sec");
  const header = $("progress-header");

  if (section) section.classList.add("active");

  if (fill) {
    const pct = progress.totalSegments > 0
      ? (progress.translatedSegments / progress.totalSegments) * 100
      : 0;
    fill.style.width = `${pct.toFixed(1)}%`;
    fill.classList.toggle("complete", progress.isComplete);
  }

  if (segCount) segCount.textContent = `${progress.translatedSegments}/${progress.totalSegments} segs`;
  if (batchCount) batchCount.textContent = `${progress.completedBatches}/${progress.totalBatches} batches`;
  if (tokSec) {
    tokSec.textContent = progress.currentTokPerSec > 0
      ? `${progress.currentTokPerSec.toFixed(1)} tok/s`
      : "-- tok/s";
  }

  if (header) {
    header.textContent = progress.isComplete
      ? `Translation complete (${progress.videoId})`
      : `Translating ${progress.videoId}`;
  }

  updateWallTime();
}

function updateWallTime(): void {
  if (!currentProgress) return;
  const wallEl = $("wall-time");
  if (!wallEl) return;

  const elapsed = (Date.now() - currentProgress.wallStartMs) / 1000;
  wallEl.textContent = currentProgress.isComplete
    ? `${elapsed.toFixed(1)}s (done)`
    : `${elapsed.toFixed(1)}s`;

  // Stop ticking after completion
  if (currentProgress.isComplete && wallTimerInterval) {
    clearInterval(wallTimerInterval);
    wallTimerInterval = null;
  }
}

// Side-panel-specific message listener (STATUS_UPDATE handled by initSharedUI)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "PROGRESS_UPDATE") {
    renderProgress(message.progress as TranslationProgress);
  }

  if (message.type === "DEBUG_LOG_PUSH") {
    appendDebugEntryToUI(message.entry as DebugEntry);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  initSharedUI().then(() => {
    // Load initial state
    chrome.runtime.sendMessage({ type: "GET_PROGRESS" }, (response) => {
      if (response?.progress) renderProgress(response.progress);
    });

    // Load existing debug log
    refreshDebugLog();

    // Wall time ticker
    wallTimerInterval = setInterval(updateWallTime, 1000);
  }).catch(console.error);
});
