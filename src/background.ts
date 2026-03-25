import { MascClient } from "./masc-client";
import type { ExtensionMessage, Settings, TranscriptSegment } from "./types";

/**
 * Background service worker (Manifest V3).
 *
 * MASC keeper를 통한 번역 파이프라인.
 * LLM 라우팅은 MASC/OAS cascade가 전담.
 */

const BATCH_SIZE = 15;
const CONTEXT_WINDOW = 3;

let mascClient: MascClient | null = null;
let translatingVideoId: string | null = null;

/** MASC 연결을 확보한다. */
async function ensureConnected(): Promise<MascClient> {
  const settings = await getSettings();

  if (!mascClient || mascClient.connectionState === "disconnected") {
    mascClient = new MascClient(settings.mascUrl);
    mascClient.onStatusChange = (state) => {
      broadcastToTabs({
        type: "STATUS_UPDATE",
        status: state === "connected" ? "connected" : "disconnected",
      });
    };
  }

  if (mascClient.connectionState !== "connected") {
    await mascClient.connect();
    await mascClient.join();
    await mascClient.ensureKeeperUp();
  }

  return mascClient;
}

function getSettings(): Promise<Settings> {
  const defaults: Settings = {
    mascUrl: "http://127.0.0.1:8935",
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
 * BATCH_SIZE 단위로 분할, sliding window context로 일관성 유지.
 */
async function runBatchTranslation(
  tabId: number,
  videoId: string,
  segments: TranscriptSegment[],
  targetLang: string
): Promise<void> {
  translatingVideoId = videoId;

  let client: MascClient;
  try {
    client = await ensureConnected();
  } catch (e) {
    console.error("[MASC Subtitle] MASC connection failed:", e);
    broadcastToTabs({ type: "STATUS_UPDATE", status: "disconnected" });
    return;
  }

  broadcastToTabs({ type: "STATUS_UPDATE", status: "translating" });

  const translated: TranscriptSegment[] = [];

  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    if (translatingVideoId !== videoId) break;

    const batch = segments.slice(i, i + BATCH_SIZE);
    const contextBefore = translated.slice(-CONTEXT_WINDOW);

    try {
      const result = await client.translateBatch(
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
    const status = mascClient?.connectionState ?? "disconnected";
    sendResponse({ status });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes["mascUrl"] && mascClient) {
    mascClient.setUrl(changes["mascUrl"].newValue as string);
  }
});
