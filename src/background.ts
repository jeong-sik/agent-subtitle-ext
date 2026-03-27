import { AgentClient } from "./agent-client";
import { ensureGeminiOAuthSession } from "./google-oauth";
import { hasUsableCredential } from "./provider-config";
import { loadStoredSettings, saveOAuthSession } from "./settings-store";
import type { DebugEntry, ExtensionMessage, Settings, TranscriptSegment } from "./types";

/**
 * Background service worker (Manifest V3).
 *
 * Smart batch ordering: 현재 재생 위치 -> 앞(미래) -> 뒤(과거) 순서로 번역.
 * SSE streaming: 줄 단위로 번역 완성 시 즉시 overlay에 전달.
 */

const BATCH_SIZE = 20;
const CONTEXT_WINDOW = 3;
const DEBUG_LOG_MAX = 50;

let client: AgentClient | null = null;
let translatingVideoId: string | null = null;
const debugLog: DebugEntry[] = [];

chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }, () => {
  void chrome.runtime.lastError;
});

function appendDebugEntry(entry: DebugEntry): void {
  debugLog.push(entry);
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
}

function dbg(msg: string): void {
  appendDebugEntry({ ts: Date.now(), msg });
  console.log(`[Subtitle] ${msg}`);
}

function getSettings(): Promise<Settings> {
  return loadStoredSettings();
}

function ensureClient(settings: Settings): AgentClient {
  if (!client) {
    client = new AgentClient(settings);
  } else {
    client.setConfig(settings);
  }
  return client;
}

async function prepareSettingsForRequest(settings: Settings): Promise<Settings> {
  if (settings.provider !== "gemini" || settings.authMode !== "oauth") {
    return settings;
  }

  const oauthSession = await ensureGeminiOAuthSession(settings.oauthClientId, settings.oauthSession);
  if (
    settings.oauthSession?.accessToken === oauthSession.accessToken &&
    settings.oauthSession?.expiresAt === oauthSession.expiresAt
  ) {
    return settings;
  }

  const updated = { ...settings, oauthSession };
  await saveOAuthSession(oauthSession);
  return updated;
}

function getConnectionStatus(settings: Settings): "connected" | "disconnected" {
  return hasUsableCredential(settings) ? "connected" : "disconnected";
}

function broadcastToTabs(message: ExtensionMessage): void {
  chrome.tabs.query({ url: ["https://www.youtube.com/*", "https://youtube.com/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  });
}

function sendToTab(tabId: number, message: ExtensionMessage): void {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

/**
 * Segments를 현재 재생 위치 기준으로 batch 단위로 재배열.
 * 순서: 현재 위치 batch -> 앞으로(미래) -> 처음부터(과거)
 */
function reorderBatches(
  segments: TranscriptSegment[],
  currentTimeMs: number
): number[] {
  const totalBatches = Math.ceil(segments.length / BATCH_SIZE);
  if (totalBatches === 0) return [];

  let startSegIdx = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg && seg.start_ms >= currentTimeMs) {
      startSegIdx = i;
      break;
    }
    startSegIdx = i;
  }

  const startBatch = Math.floor(startSegIdx / BATCH_SIZE);

  const order: number[] = [];
  for (let i = startBatch; i < totalBatches; i++) order.push(i);
  for (let i = 0; i < startBatch; i++) order.push(i);

  return order;
}

async function runBatchTranslation(
  tabId: number,
  videoId: string,
  segments: TranscriptSegment[],
  targetLang: string,
  currentTimeMs: number,
  settings: Settings
): Promise<void> {
  translatingVideoId = videoId;
  let preparedSettings: Settings;
  try {
    preparedSettings = await prepareSettingsForRequest(settings);
  } catch (error) {
    await saveOAuthSession(null);
    dbg(`Auth failed: ${error}`);
    broadcastToTabs({ type: "STATUS_UPDATE", status: "disconnected" });
    translatingVideoId = null;
    return;
  }

  const agent = ensureClient(preparedSettings);

  broadcastToTabs({ type: "STATUS_UPDATE", status: "translating" });

  const translated: TranscriptSegment[] = [];
  const batchOrder = reorderBatches(segments, currentTimeMs);
  const totalBatches = batchOrder.length;

  dbg(`${totalBatches} batches (stream), starting near ${Math.round(currentTimeMs / 1000)}s`);

  for (let step = 0; step < totalBatches; step++) {
    if (translatingVideoId !== videoId) break;

    const batchIdx = batchOrder[step]!;
    const start = batchIdx * BATCH_SIZE;
    const batch = segments.slice(start, start + BATCH_SIZE);
    const contextBefore = translated.slice(-CONTEXT_WINDOW);

    let streamedCount = 0;

    try {
      const result = await agent.translateBatchStream(
        videoId, batch, "en", targetLang, contextBefore,
        (index, translatedText) => {
          const original = segments[index];
          if (original) original.translated = translatedText;
          streamedCount++;

          sendToTab(tabId, {
            type: "TRANSLATION_UPDATE",
            videoId,
            segments: [{ index, translated: translatedText }],
          });
        }
      );

      // streaming에서 놓친 segment가 있으면 batch로 전달
      const unstreamedSegs = result.segments.filter(
        (seg) => !segments[seg.index]?.translated
      );
      if (unstreamedSegs.length > 0) {
        for (const seg of unstreamedSegs) {
          const original = segments[seg.index];
          if (original) original.translated = seg.translated;
        }
        sendToTab(tabId, {
          type: "TRANSLATION_UPDATE",
          videoId,
          segments: [...unstreamedSegs],
        });
      }

      for (const seg of result.segments) {
        const original = segments[seg.index];
        if (original) translated.push(original);
      }

      const tokS = result.elapsed_ms && result.tokens
        ? `${(result.tokens / (result.elapsed_ms / 1000)).toFixed(1)} tok/s`
        : "";
      dbg(
        `Batch ${step + 1}/${totalBatches} (seg ${start}): ` +
        `${result.segments.length} segs, ${streamedCount} streamed, ` +
        `${result.elapsed_ms ?? 0}ms ${tokS}`
      );
    } catch (e) {
      dbg(`Batch ${start} failed: ${e}`);
    }
  }

  if (translatingVideoId === videoId) {
    sendToTab(tabId, { type: "TRANSLATION_COMPLETE", videoId });
    broadcastToTabs({ type: "STATUS_UPDATE", status: getConnectionStatus(preparedSettings) });
    translatingVideoId = null;
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (message.type === "TRANSCRIPT_READY" && sender.tab?.id != null) {
    dbg(`Transcript: ${message.segments.length} segs for ${message.videoId}`);
    const currentTimeMs = message.currentTimeMs ?? 0;
    getSettings().then((settings) => {
      dbg(`Agent: ${settings.provider} ${settings.model} -> ${settings.targetLang}`);
      runBatchTranslation(
        sender.tab!.id!, message.videoId, message.segments, settings.targetLang, currentTimeMs, settings
      ).catch(console.error);
    });
  }

  if (message.type === "DEBUG_LOG") {
    appendDebugEntry(message.entry);
  }

  if (message.type === "GET_DEBUG_LOG") {
    sendResponse({ log: debugLog });
    return true;
  }

  if (message.type === "GET_STATUS") {
    getSettings()
      .then((settings) => sendResponse({ status: translatingVideoId ? "translating" : getConnectionStatus(settings) }))
      .catch(() => sendResponse({ status: "disconnected" }));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "session") {
    return;
  }
  if (
    changes["agentUrl"] ||
    changes["apiKey"] ||
    changes["model"] ||
    changes["provider"] ||
    changes["authMode"] ||
    changes["oauthSession"] ||
    changes["googleProjectId"]
  ) {
    getSettings().then((s) => {
      if (client) client.setConfig(s);
    });
  }
});
