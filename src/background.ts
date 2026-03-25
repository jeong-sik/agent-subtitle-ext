import { AgentClient } from "./agent-client";
import type { ExtensionMessage, Settings, TranscriptSegment } from "./types";

/**
 * Background service worker (Manifest V3).
 *
 * OpenAI-compatible agent endpoint에 번역 요청.
 * 뒤에 뭐가 있는지 모름 — llama-server든 MASC keeper든 Cloud API든.
 */

const BATCH_SIZE = 15;
const CONTEXT_WINDOW = 3;

let client: AgentClient | null = null;
let translatingVideoId: string | null = null;

async function getClient(): Promise<AgentClient> {
  const settings = await getSettings();
  if (!client) {
    client = new AgentClient(settings.agentUrl, settings.apiKey);
  }
  return client;
}

function getSettings(): Promise<Settings> {
  const defaults: Settings = {
    agentUrl: "http://127.0.0.1:8085",
    apiKey: "",
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

async function runBatchTranslation(
  tabId: number,
  videoId: string,
  segments: TranscriptSegment[],
  targetLang: string
): Promise<void> {
  translatingVideoId = videoId;
  const agent = await getClient();

  broadcastToTabs({ type: "STATUS_UPDATE", status: "translating" });

  const translated: TranscriptSegment[] = [];

  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    if (translatingVideoId !== videoId) break;

    const batch = segments.slice(i, i + BATCH_SIZE);
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

      console.log(`[Subtitle] Batch ${i / BATCH_SIZE + 1}: ${result.segments.length} segments`);
    } catch (e) {
      console.error(`[Subtitle] Batch ${i} failed:`, e);
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
        sender.tab!.id!, message.videoId, message.segments, settings.targetLang
      ).catch(console.error);
    });
  }

  if (message.type === "GET_STATUS") {
    sendResponse({ status: translatingVideoId ? "translating" : "connected" });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes["agentUrl"] || changes["apiKey"]) {
    const settings = {
      agentUrl: (changes["agentUrl"]?.newValue as string) ?? "",
      apiKey: (changes["apiKey"]?.newValue as string) ?? "",
    };
    if (client && settings.agentUrl) {
      client.setConfig(settings.agentUrl, settings.apiKey);
    }
  }
});
