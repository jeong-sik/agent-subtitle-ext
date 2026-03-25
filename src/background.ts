import { AgentClient } from "./agent-client";
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

function dbg(msg: string): void {
  const entry: DebugEntry = { ts: Date.now(), msg };
  debugLog.push(entry);
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
  console.log(`[Subtitle] ${msg}`);
}

async function getClient(): Promise<AgentClient> {
  const settings = await getSettings();
  if (!client) {
    client = new AgentClient(settings.agentUrl, settings.apiKey, settings.model);
  }
  return client;
}

function getSettings(): Promise<Settings> {
  const defaults: Settings = {
    agentUrl: "http://127.0.0.1:8085",
    apiKey: "",
    model: "auto",
    targetLang: "ko",
    showDualSubtitles: true,
    fontSize: 18,
    overlayPosition: "bottom",
  };

  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (result) => {
      resolve(result as Settings);
    });
  });
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
 *
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
  currentTimeMs: number
): Promise<void> {
  translatingVideoId = videoId;
  const agent = await getClient();

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
        // onSegment: 줄이 완성될 때마다 즉시 tab에 전달
        (index, translatedText) => {
          const original = segments[index];
          if (original) {
            original.translated = translatedText;
          }
          streamedCount++;

          // 개별 segment를 즉시 전달 (streaming UX)
          sendToTab(tabId, {
            type: "TRANSLATION_UPDATE",
            videoId,
            segments: [{ index, translated: translatedText }],
          });
        }
      );

      // streaming 콜백에서 이미 처리하지 못한 segment가 있으면 batch로 보냄
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

      // context window 갱신
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
    broadcastToTabs({ type: "STATUS_UPDATE", status: "connected" });
    translatingVideoId = null;
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (message.type === "TRANSCRIPT_READY" && sender.tab?.id != null) {
    dbg(`Transcript: ${message.segments.length} segs for ${message.videoId}`);
    const currentTimeMs = message.currentTimeMs ?? 0;
    getSettings().then((settings) => {
      dbg(`Agent: ${settings.agentUrl} model=${settings.model} lang=${settings.targetLang}`);
      runBatchTranslation(
        sender.tab!.id!, message.videoId, message.segments, settings.targetLang, currentTimeMs
      ).catch(console.error);
    });
  }

  if (message.type === "DEBUG_LOG") {
    debugLog.push(message.entry);
    if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
  }

  if (message.type === "GET_DEBUG_LOG") {
    sendResponse({ log: debugLog });
    return true;
  }

  if (message.type === "GET_STATUS") {
    sendResponse({ status: translatingVideoId ? "translating" : "connected" });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes["agentUrl"] || changes["apiKey"] || changes["model"]) {
    getSettings().then((s) => {
      if (client) {
        client.setConfig(s.agentUrl, s.apiKey, s.model);
      }
    });
  }
});
