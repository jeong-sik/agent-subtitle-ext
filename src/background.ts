import { MascClient } from "./masc-client";
import { DirectClient } from "./direct-client";
import type { ExtensionMessage, Settings, TranscriptSegment, TranslateResponse } from "./types";

/**
 * Background service worker (Manifest V3).
 *
 * 번역 파이프라인:
 * 1. MASC keeper (primary) → OAS cascade
 * 2. Direct LLM (fallback) → llama-server / Cloud API
 *
 * MASC 연결 실패 시 자동으로 direct 모드로 전환.
 */

const BATCH_SIZE = 15; // 10-20 사이가 품질/속도 균형점
const CONTEXT_WINDOW = 3;

let mascClient: MascClient | null = null;
let directClient: DirectClient | null = null;
let translatingVideoId: string | null = null;
let useDirectMode = false;

/** 번역 클라이언트를 초기화한다. MASC 우선, 실패 시 direct fallback. */
async function getTranslationClient(): Promise<"masc" | "direct"> {
  if (useDirectMode) return "direct";

  const settings = await getSettings();

  // MASC 연결 시도
  try {
    if (!mascClient || mascClient.connectionState === "disconnected") {
      mascClient = new MascClient(settings.mascWsUrl);
      mascClient.onStatusChange = (state) => {
        broadcastToTabs({
          type: "STATUS_UPDATE",
          status: state === "connected" ? "connected" : "disconnected",
        });
      };
    }
    await mascClient.connect();
    await mascClient.join();
    await mascClient.ensureKeeperUp();
    return "masc";
  } catch (e) {
    console.warn("[MASC Subtitle] MASC unavailable, falling back to direct mode:", e);
  }

  // Direct LLM fallback
  if (!directClient) {
    directClient = new DirectClient();
  }

  const available = await directClient.isAvailable();
  if (available) {
    useDirectMode = true;
    broadcastToTabs({ type: "STATUS_UPDATE", status: "connected" });
    return "direct";
  }

  throw new Error("No translation backend available (MASC and direct LLM both failed)");
}

/** 배치 번역 실행. 백엔드에 따라 MASC 또는 direct 호출. */
async function translateBatch(
  videoId: string,
  batch: readonly TranscriptSegment[],
  sourceLang: string,
  targetLang: string,
  contextBefore: readonly TranscriptSegment[]
): Promise<TranslateResponse> {
  const mode = await getTranslationClient();

  if (mode === "masc" && mascClient) {
    return mascClient.translateBatch(videoId, batch, sourceLang, targetLang, contextBefore);
  }

  if (!directClient) {
    directClient = new DirectClient();
  }
  return directClient.translateBatch(videoId, batch, sourceLang, targetLang, contextBefore);
}

function getSettings(): Promise<Settings> {
  const defaults: Settings = {
    mascWsUrl: "ws://localhost:8937",
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
 * 배치 번역 파이프라인.
 *
 * segments를 BATCH_SIZE 단위로 분할하고 순차 번역.
 * 이전 배치의 마지막 CONTEXT_WINDOW개를 다음 배치 context로 전달.
 */
async function runBatchTranslation(
  tabId: number,
  videoId: string,
  segments: TranscriptSegment[],
  targetLang: string
): Promise<void> {
  translatingVideoId = videoId;

  broadcastToTabs({ type: "STATUS_UPDATE", status: "translating" });

  const translated: TranscriptSegment[] = [];

  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    if (translatingVideoId !== videoId) break;

    const batch = segments.slice(i, i + BATCH_SIZE);
    const contextBefore = translated.slice(-CONTEXT_WINDOW);

    try {
      const result = await translateBatch(
        videoId,
        batch,
        "en",
        targetLang,
        contextBefore
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

      console.log(`[MASC Subtitle] Batch ${i / BATCH_SIZE + 1}: ${result.segments.length} segments translated`);
    } catch (e) {
      console.error(`[MASC Subtitle] Batch ${i} failed:`, e);
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
    getSettings().then((settings) => {
      runBatchTranslation(
        sender.tab!.id!,
        message.videoId,
        message.segments,
        settings.targetLang
      ).catch(console.error);
    });
  }

  if (message.type === "GET_STATUS") {
    const mode = useDirectMode ? "direct" : "masc";
    const status = mascClient?.connectionState ?? "disconnected";
    sendResponse({ status, mode });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes["mascWsUrl"] && mascClient) {
    mascClient.setUrl(changes["mascWsUrl"].newValue as string);
    useDirectMode = false; // URL 변경 시 MASC 재시도
  }
});
