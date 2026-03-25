import type { Settings, ConnectionStatus } from "./types";

/**
 * Popup UI: 설정 및 상태 표시.
 */

const DEFAULT_SETTINGS: Settings = {
  mascUrl: "http://127.0.0.1:8935",
  targetLang: "ko",
  showDualSubtitles: true,
  fontSize: 18,
  overlayPosition: "bottom",
};

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

async function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve(result as Settings);
    });
  });
}

async function saveSettings(settings: Partial<Settings>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(settings, resolve);
  });
}

function updateStatusDisplay(status: ConnectionStatus): void {
  const dot = $("status-dot");
  const text = $("status-text");
  if (!dot || !text) return;

  const labels: Record<ConnectionStatus, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting...",
    connected: "Connected",
    translating: "Translating...",
  };

  dot.className = `status-dot ${status}`;
  text.textContent = labels[status];
}

async function init(): Promise<void> {
  const settings = await loadSettings();

  // 폼 값 설정
  const wsUrlInput = $("ws-url") as HTMLInputElement | null;
  const targetLangSelect = $("target-lang") as HTMLSelectElement | null;
  const dualSubCheck = $("dual-subtitles") as HTMLInputElement | null;
  const fontSizeInput = $("font-size") as HTMLInputElement | null;
  const positionSelect = $("position") as HTMLSelectElement | null;

  if (wsUrlInput) wsUrlInput.value = settings.mascUrl;
  if (targetLangSelect) targetLangSelect.value = settings.targetLang;
  if (dualSubCheck) dualSubCheck.checked = settings.showDualSubtitles;
  if (fontSizeInput) fontSizeInput.value = String(settings.fontSize);
  if (positionSelect) positionSelect.value = settings.overlayPosition;

  // 상태 확인
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
    if (response?.status) {
      updateStatusDisplay(response.status as ConnectionStatus);
    }
  });

  // 설정 변경 이벤트
  $("settings-form")?.addEventListener("change", async () => {
    const newSettings: Partial<Settings> = {};
    if (wsUrlInput) newSettings.mascUrl = wsUrlInput.value;
    if (targetLangSelect) newSettings.targetLang = targetLangSelect.value;
    if (dualSubCheck) newSettings.showDualSubtitles = dualSubCheck.checked;
    if (fontSizeInput) newSettings.fontSize = parseInt(fontSizeInput.value, 10) || 18;
    if (positionSelect) newSettings.overlayPosition = positionSelect.value as "bottom" | "top";
    await saveSettings(newSettings);
  });
}

// 상태 업데이트 수신
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATUS_UPDATE") {
    updateStatusDisplay(message.status as ConnectionStatus);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  init().catch(console.error);
});
