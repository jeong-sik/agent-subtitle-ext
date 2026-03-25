import { SubtitleOverlay } from "./overlay";
import { getCached, setCached } from "./cache";
import { mergeIntoSentences } from "./sentence-merger";
import type { ExtensionMessage, TranscriptSegment, Settings } from "./types";

/**
 * Content script (ISOLATED world).
 *
 * inject.ts (MAIN world)에서 window.postMessage로 transcript 수신.
 * Background에 번역 요청 → 결과를 overlay에 반영.
 */

const LOG = "[AI Subtitle]";

let overlay: SubtitleOverlay | null = null;
let currentVideoId: string | null = null;
let segments: TranscriptSegment[] = [];

/** inject.ts (MAIN world)에서 postMessage로 보낸 이벤트 수신. */
window.addEventListener("message", async (event: MessageEvent) => {
  if (event.source !== window) return;

  // Debug log relay: MAIN world -> background
  if (event.data?.type === "__AI_SUBTITLE_DEBUG__") {
    chrome.runtime.sendMessage({
      type: "DEBUG_LOG",
      entry: { ts: Date.now(), msg: `[inject] ${event.data.msg}` },
    } as ExtensionMessage).catch(() => {});
    return;
  }

  if (event.data?.type !== "__AI_SUBTITLE_TRANSCRIPT__") return;

  const { videoId, segments: extracted } = event.data as {
    type: string;
    videoId: string;
    segments: TranscriptSegment[];
  };

  console.log(`${LOG} Received ${extracted?.length ?? 0} segments for ${videoId}`);

  if (!videoId || !extracted?.length) {
    console.warn(`${LOG} No transcript for ${videoId}`);
    return;
  }

  currentVideoId = videoId;
  // 문장 단위로 병합: 2731 raw segments → ~800 sentences
  const sentences = mergeIntoSentences(extracted);
  console.log(`${LOG} Merged ${extracted.length} raw → ${sentences.length} sentences`);
  segments = sentences;

  await waitForPlayer();
  if (!overlay) overlay = new SubtitleOverlay();
  overlay.mount();

  const settings = await loadSettings();
  overlay.configure(settings);

  // 캐시 확인
  const cached = await getCached(videoId, settings.targetLang);
  if (cached) {
    console.log(`${LOG} Cache hit for ${videoId}`);
    segments = cached;
    overlay.setSegments(segments);
    return;
  }

  overlay.setSegments(segments);

  const video = document.querySelector("video.html5-main-video") as HTMLVideoElement | null;
  const currentTimeMs = Math.round((video?.currentTime ?? 0) * 1000);
  console.log(`${LOG} Requesting translation for ${videoId} (${sentences.length} sentences, from ${currentTimeMs}ms)`);
  chrome.runtime.sendMessage({
    type: "TRANSCRIPT_READY",
    videoId,
    segments: sentences,
    currentTimeMs,
  } as ExtensionMessage).catch((e) => {
    console.warn(`${LOG} sendMessage failed:`, e);
  });
});

function waitForPlayer(): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (document.querySelector("#movie_player video.html5-main-video")) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

async function loadSettings(): Promise<Settings> {
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

/** Background → content: 번역 결과 수신. */
chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "TRANSLATION_UPDATE" && message.videoId === currentVideoId) {
    console.log(`${LOG} Translation update: ${message.segments.length} segments`);
    for (const seg of message.segments) {
      const target = segments[seg.index];
      if (target) {
        target.translated = seg.translated;
      }
      overlay?.updateTranslation(seg.index, seg.translated);
    }
  }

  if (message.type === "TRANSLATION_COMPLETE" && message.videoId === currentVideoId) {
    console.log(`${LOG} Translation complete`);
    loadSettings().then((settings) => {
      setCached(currentVideoId!, settings.targetLang, segments).catch(console.error);
    });
  }
});

/** 설정 변경 → overlay 재설정 + 언어 변경 시 재번역. */
chrome.storage.onChanged.addListener((changes) => {
  // overlay 설정 즉시 반영
  if (overlay && (changes["showDualSubtitles"] || changes["fontSize"] || changes["overlayPosition"])) {
    loadSettings().then((s) => overlay?.configure(s));
  }

  // 언어 변경 시: 캐시 있으면 즉시 로드, 없으면 재번역
  if (changes["targetLang"] && currentVideoId && segments.length > 0) {
    const newLang = changes["targetLang"].newValue as string;
    console.log(`${LOG} Language changed to ${newLang}`);

    getCached(currentVideoId, newLang).then((cached) => {
      if (cached) {
        console.log(`${LOG} Cache hit for ${newLang} — instant load`);
        segments = cached;
        overlay?.setSegments(segments);
        return;
      }

      console.log(`${LOG} No cache for ${newLang}, translating...`);
      for (const seg of segments) seg.translated = undefined;
      overlay?.setSegments(segments);

      const video = document.querySelector("video.html5-main-video") as HTMLVideoElement | null;
      chrome.runtime.sendMessage({
        type: "TRANSCRIPT_READY",
        videoId: currentVideoId,
        segments,
        currentTimeMs: Math.round((video?.currentTime ?? 0) * 1000),
      } as ExtensionMessage).catch(() => {});
    }).catch(() => {});
  }
});
