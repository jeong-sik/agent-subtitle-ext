import { connectGeminiOAuth, revokeGeminiOAuthSession } from "./google-oauth";
import { getProvider, normalizeSettings } from "./provider-config";
import { loadStoredSettings, saveOAuthSession, saveStoredSettings } from "./settings-store";
import { DEFAULT_SETTINGS } from "./types";
import type {
  AuthMode,
  ConnectionStatus,
  DebugEntry,
  ProviderId,
  Settings,
} from "./types";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

let currentSettings: Settings = DEFAULT_SETTINGS;

async function loadSettings(): Promise<Settings> {
  return loadStoredSettings();
}

async function saveSettings(settings: Partial<Settings>): Promise<void> {
  const merged = normalizeSettings({ ...currentSettings, ...settings });
  currentSettings = merged;
  await saveStoredSettings(merged);
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

function setValue(id: string, value: string): void {
  const input = $(id) as HTMLInputElement | HTMLSelectElement | null;
  if (input) input.value = value;
}

function formatExpiry(expiresAt: number): string {
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return "expired";
  const mins = Math.round(diffMs / 60_000);
  return `${mins} min left`;
}

function renderAuthModeOptions(providerId: ProviderId, selected: AuthMode): AuthMode {
  const authModeSelect = $("auth-mode") as HTMLSelectElement | null;
  if (!authModeSelect) return selected;

  const provider = getProvider(providerId);
  authModeSelect.innerHTML = provider.authModes
    .map((mode) => `<option value="${mode}">${mode === "oauth" ? "OAuth" : "API Key"}</option>`)
    .join("");

  const resolved = provider.authModes.includes(selected) ? selected : provider.authModes[0]!;
  authModeSelect.value = resolved;
  return resolved;
}

function renderOAuthStatus(settings: Settings): void {
  const status = $("oauth-status");
  if (!status) return;

  if (settings.provider !== "gemini" || settings.authMode !== "oauth") {
    status.textContent = "Gemini OAuth is disabled.";
    return;
  }

  const session = settings.oauthSession;
  if (!session?.accessToken) {
    status.textContent = "Not connected";
    return;
  }

  const who = session.email ? `Connected as ${session.email}` : "Connected";
  status.textContent = `${who} • ${formatExpiry(session.expiresAt)}`;
}

function renderForm(settings: Settings): void {
  const provider = getProvider(settings.provider);
  const providerSelect = $("provider") as HTMLSelectElement | null;
  const help = $("provider-help");
  const urlInput = $("ws-url") as HTMLInputElement | null;
  const apiKeyGroup = $("api-key-group");
  const apiKeyInput = $("api-key") as HTMLInputElement | null;
  const modelInput = $("model") as HTMLInputElement | null;
  const oauthPanel = $("oauth-panel");
  const oauthClientIdInput = $("oauth-client-id") as HTMLInputElement | null;
  const googleProjectIdInput = $("google-project-id") as HTMLInputElement | null;
  const redirectUriInput = $("oauth-redirect-uri") as HTMLInputElement | null;
  const disconnectBtn = $("oauth-disconnect-btn") as HTMLButtonElement | null;

  if (providerSelect) providerSelect.value = settings.provider;
  const authMode = renderAuthModeOptions(settings.provider, settings.authMode);
  if (authMode !== settings.authMode) {
    currentSettings = { ...settings, authMode };
  }

  if (help) help.textContent = provider.authHelpText;
  if (urlInput) {
    urlInput.value = settings.provider === "custom" ? settings.agentUrl : provider.defaultUrl;
    urlInput.placeholder = provider.defaultUrl;
    urlInput.readOnly = settings.provider !== "custom";
  }
  if (apiKeyInput) {
    apiKeyInput.placeholder = settings.provider === "claude"
      ? "sk-ant-..."
      : settings.provider === "gemini"
        ? "AIza... or Gemini API token"
        : "sk-...";
  }
  if (modelInput) modelInput.placeholder = provider.modelPlaceholder;

  const oauthEnabled = settings.provider === "gemini" && authMode === "oauth";
  if (apiKeyGroup) apiKeyGroup.style.display = authMode === "apiKey" ? "block" : "none";
  if (oauthPanel) oauthPanel.style.display = oauthEnabled ? "block" : "none";
  if (oauthClientIdInput) oauthClientIdInput.value = settings.oauthClientId;
  if (googleProjectIdInput) googleProjectIdInput.value = settings.googleProjectId;
  if (redirectUriInput) redirectUriInput.value = chrome.identity.getRedirectURL("gemini-oauth");
  if (disconnectBtn) disconnectBtn.disabled = !settings.oauthSession?.accessToken;

  renderOAuthStatus(settings);
}

function collectSettingsFromForm(): Settings {
  const provider = (($("provider") as HTMLSelectElement | null)?.value ?? "custom") as ProviderId;
  const authMode = (($("auth-mode") as HTMLSelectElement | null)?.value ?? "apiKey") as AuthMode;
  const providerDef = getProvider(provider);

  return normalizeSettings({
    ...currentSettings,
    provider,
    authMode: providerDef.authModes.includes(authMode) ? authMode : providerDef.authModes[0]!,
    agentUrl: provider === "custom"
      ? (($("ws-url") as HTMLInputElement | null)?.value ?? currentSettings.agentUrl)
      : providerDef.defaultUrl,
    apiKey: (($("api-key") as HTMLInputElement | null)?.value ?? currentSettings.apiKey).trim(),
    model: (($("model") as HTMLInputElement | null)?.value ?? currentSettings.model).trim(),
    targetLang: (($("target-lang") as HTMLSelectElement | null)?.value ?? currentSettings.targetLang).trim(),
    showDualSubtitles: (($("dual-subtitles") as HTMLInputElement | null)?.checked ?? currentSettings.showDualSubtitles),
    fontSize: parseInt((($("font-size") as HTMLInputElement | null)?.value ?? String(currentSettings.fontSize)), 10) || 18,
    overlayPosition: ((($("position") as HTMLSelectElement | null)?.value ?? currentSettings.overlayPosition) as "bottom" | "top"),
    oauthClientId: (($("oauth-client-id") as HTMLInputElement | null)?.value ?? currentSettings.oauthClientId).trim(),
    googleProjectId: (($("google-project-id") as HTMLInputElement | null)?.value ?? currentSettings.googleProjectId).trim(),
  });
}

async function persistForm(): Promise<void> {
  currentSettings = collectSettingsFromForm();
  await saveStoredSettings(currentSettings);
  renderForm(currentSettings);
}

async function syncStatus(): Promise<void> {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
    if (response?.status) {
      updateStatusDisplay(response.status as ConnectionStatus);
    }
  });
}

async function handleGeminiOAuthConnect(): Promise<void> {
  currentSettings = collectSettingsFromForm();
  renderForm(currentSettings);

  if (!currentSettings.oauthClientId) {
    const status = $("oauth-status");
    if (status) status.textContent = "Google OAuth client ID is required.";
    return;
  }

  updateStatusDisplay("connecting");

  try {
    const oauthSession = await connectGeminiOAuth(currentSettings.oauthClientId);
    currentSettings = normalizeSettings({
      ...currentSettings,
      provider: "gemini",
      authMode: "oauth",
      oauthSession,
    });
    await saveStoredSettings(currentSettings);
    await saveOAuthSession(oauthSession);
    renderForm(currentSettings);
    await syncStatus();
  } catch (error) {
    const status = $("oauth-status");
    if (status) {
      status.textContent = error instanceof Error ? error.message : "OAuth connection failed";
    }
    updateStatusDisplay("disconnected");
  }
}

async function handleGeminiOAuthDisconnect(): Promise<void> {
  const previousSession = currentSettings.oauthSession;
  currentSettings = normalizeSettings({
    ...collectSettingsFromForm(),
    oauthSession: null,
  });
  await revokeGeminiOAuthSession(previousSession);
  await saveStoredSettings(currentSettings);
  await saveOAuthSession(null);
  renderForm(currentSettings);
  await syncStatus();
}

async function init(): Promise<void> {
  const versionEl = $("version");
  if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

  currentSettings = await loadSettings();

  setValue("provider", currentSettings.provider);
  setValue("ws-url", currentSettings.agentUrl);
  setValue("api-key", currentSettings.apiKey);
  setValue("model", currentSettings.model);
  setValue("target-lang", currentSettings.targetLang);
  setValue("oauth-client-id", currentSettings.oauthClientId);
  setValue("google-project-id", currentSettings.googleProjectId);

  const dualSubCheck = $("dual-subtitles") as HTMLInputElement | null;
  const fontSizeInput = $("font-size") as HTMLInputElement | null;
  const positionSelect = $("position") as HTMLSelectElement | null;
  if (dualSubCheck) dualSubCheck.checked = currentSettings.showDualSubtitles;
  if (fontSizeInput) fontSizeInput.value = String(currentSettings.fontSize);
  if (positionSelect) positionSelect.value = currentSettings.overlayPosition;

  renderForm(currentSettings);
  await syncStatus();

  $("settings-form")?.addEventListener("change", () => {
    persistForm().catch(console.error);
  });

  $("oauth-connect-btn")?.addEventListener("click", () => {
    handleGeminiOAuthConnect().catch(console.error);
  });

  $("oauth-disconnect-btn")?.addEventListener("click", () => {
    handleGeminiOAuthDisconnect().catch(console.error);
  });

  $("debug-toggle")?.addEventListener("click", toggleDebug);

  setInterval(() => {
    if (debugOpen) refreshDebugLog();
  }, 2000);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATUS_UPDATE") {
    updateStatusDisplay(message.status as ConnectionStatus);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  init().catch(console.error);
});
