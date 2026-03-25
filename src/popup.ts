import { DEFAULT_SETTINGS } from "./types";
import type { Settings, ConnectionStatus, DebugEntry } from "./types";

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

// --- Debug panel ---

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function colorizeMsg(msg: string): string {
  if (msg.startsWith("[inject]")) return `<span class="inject">${escHtml(msg)}</span>`;
  if (msg.includes("failed") || msg.includes("error")) return `<span class="err">${escHtml(msg)}</span>`;
  return `<span class="bg">${escHtml(msg)}</span>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderDebugLog(entries: DebugEntry[]): void {
  const logEl = $("debug-log");
  const emptyEl = $("debug-empty");
  if (!logEl) return;

  if (entries.length === 0) {
    if (emptyEl) emptyEl.style.display = "block";
    logEl.innerHTML = "";
    return;
  }

  if (emptyEl) emptyEl.style.display = "none";
  logEl.innerHTML = entries
    .map((e) => `<span class="ts">${formatTime(e.ts)}</span> ${colorizeMsg(e.msg)}`)
    .join("\n");

  // auto-scroll to bottom
  const panel = $("debug-panel");
  if (panel) panel.scrollTop = panel.scrollHeight;
}

let debugOpen = false;

function toggleDebug(): void {
  debugOpen = !debugOpen;
  const panel = $("debug-panel");
  const arrow = $("debug-arrow");
  if (panel) panel.classList.toggle("open", debugOpen);
  if (arrow) arrow.innerHTML = debugOpen ? "&#9660;" : "&#9654;";

  if (debugOpen) refreshDebugLog();
}

function refreshDebugLog(): void {
  chrome.runtime.sendMessage({ type: "GET_DEBUG_LOG" }, (response) => {
    if (response?.log) {
      renderDebugLog(response.log as DebugEntry[]);
    }
  });
}

// --- Init ---

async function init(): Promise<void> {
  // 버전을 manifest에서 동적 로드
  const versionEl = $("version");
  if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

  const settings = await loadSettings();

  const wsUrlInput = $("ws-url") as HTMLInputElement | null;
  const apiKeyInput = $("api-key") as HTMLInputElement | null;
  const modelInput = $("model") as HTMLInputElement | null;
  const targetLangSelect = $("target-lang") as HTMLSelectElement | null;
  const dualSubCheck = $("dual-subtitles") as HTMLInputElement | null;
  const fontSizeInput = $("font-size") as HTMLInputElement | null;
  const positionSelect = $("position") as HTMLSelectElement | null;

  if (wsUrlInput) wsUrlInput.value = settings.agentUrl;
  if (apiKeyInput) apiKeyInput.value = settings.apiKey;
  if (modelInput) modelInput.value = settings.model;
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

  // 설정 변경
  $("settings-form")?.addEventListener("change", async () => {
    const newSettings: Partial<Settings> = {};
    if (wsUrlInput) newSettings.agentUrl = wsUrlInput.value;
    if (apiKeyInput) newSettings.apiKey = apiKeyInput.value;
    if (modelInput) newSettings.model = modelInput.value;
    if (targetLangSelect) newSettings.targetLang = targetLangSelect.value;
    if (dualSubCheck) newSettings.showDualSubtitles = dualSubCheck.checked;
    if (fontSizeInput) newSettings.fontSize = parseInt(fontSizeInput.value, 10) || 18;
    if (positionSelect) newSettings.overlayPosition = positionSelect.value as "bottom" | "top";
    await saveSettings(newSettings);
  });

  // Debug toggle
  $("debug-toggle")?.addEventListener("click", toggleDebug);

  // Auto-refresh debug log while open
  setInterval(() => {
    if (debugOpen) refreshDebugLog();
  }, 2000);
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
