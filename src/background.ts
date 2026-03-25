import { AgentClient } from "./agent-client";
import type { ExtensionMessage, Settings, TranscriptSegment } from "./types";

/**
 * Background service worker (Manifest V3).
 *
 * Smart batch ordering: 현재 재생 위치 → 앞(미래) → 뒤(과거) 순서로 번역.
 */

const BATCH_SIZE = 15;
const CONTEXT_WINDOW = 3;

let client: AgentClient | null = null;
let translatingVideoId: string | null = null;

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
 * 순서: 현재 위치 batch → 앞으로(미래) → 처음부터(과거)
 * 사용자가 30분에 있으면 30분부터 번역 시작, 끝까지 간 후 0분부터.
 */
function reorderBatches(
  segments: TranscriptSegment[],
  currentTimeMs: number
): number[] {
  const totalBatches = Math.ceil(segments.length / BATCH_SIZE);
  if (totalBatches === 0) return [];

  // 현재 시간에 해당하는 segment 찾기
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

  // startBatch → end, then 0 → startBatch
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

  console.log(`[Subtitle] ${totalBatches} batches, starting near ${Math.round(currentTimeMs / 1000)}s`);

  for (let step = 0; step < totalBatches; step++) {
    if (translatingVideoId !== videoId) break;

    const batchIdx = batchOrder[step]!;
    const start = batchIdx * BATCH_SIZE;
    const batch = segments.slice(start, start + BATCH_SIZE);
    const contextBefore = translated.slice(-CONTEXT_WINDOW);

    try {
      const result = await agent.translateBatch(
        videoId, batch, "en", targetLang, contextBefore
      );

      for (const seg of result.segments) {
        const original = segments[seg.index];
        if (original) {
          original.translated = seg.translated;
          translated.push(original);
        }
      }

      sendToTab(tabId, {
        type: "TRANSLATION_UPDATE",
        videoId,
        segments: [...result.segments],
      });

      console.log(`[Subtitle] Batch ${step + 1}/${totalBatches} (seg ${start}): ${result.segments.length} translated`);
    } catch (e) {
      console.error(`[Subtitle] Batch ${start} failed:`, e);
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
    const currentTimeMs = message.currentTimeMs ?? 0;
    getSettings().then((settings) => {
      runBatchTranslation(
        sender.tab!.id!, message.videoId, message.segments, settings.targetLang, currentTimeMs
      ).catch(console.error);
    });
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
