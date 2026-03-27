import { SubtitleOverlay } from "./overlay";
import { ProgressBar } from "./progress-bar";
import { getCached, setCached } from "./cache";
import { mergeIntoSentences } from "./sentence-merger";
import { DEFAULT_SETTINGS } from "./types";
import type { ExtensionMessage, TranscriptSegment, Settings } from "./types";

/**
 * Content script (ISOLATED world).
 *
 * inject.ts (MAIN world)에서 window.postMessage로 transcript 수신.
 * Background에 번역 요청 → 결과를 overlay에 반영.
 * ProgressBar로 번역 진행률 시각화.
 * SPA 네비게이션 시 상태 초기화.
 */

const LOG = "[AI Subtitle]";
const WAIT_FOR_PLAYER_TIMEOUT_MS = 10_000;

let overlay: SubtitleOverlay | null = null;
let progressBar: ProgressBar | null = null;
let currentVideoId: string | null = null;
let segments: TranscriptSegment[] = [];

/** SPA 네비게이션 또는 새 영상 전환 시 전체 상태 초기화. */
function resetState(): void {
  overlay?.unmount();
  overlay = null;
  progressBar?.unmount();
  progressBar = null;
  currentVideoId = null;
  segments = [];
}

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

  // SPA navigation reset signal from inject.ts
  if (event.data?.type === "__AI_SUBTITLE_RESET__") {
    console.log(`${LOG} SPA navigation detected, resetting state`);
    resetState();
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

  // Reset if video changed
  if (currentVideoId && currentVideoId !== videoId) {
    resetState();
  }

  currentVideoId = videoId;
  const sentences = mergeIntoSentences(extracted);
  console.log(`${LOG} Merged ${extracted.length} raw → ${sentences.length} sentences`);
  segments = sentences;

  const playerReady = await waitForPlayer();
  if (!playerReady) {
    console.warn(`${LOG} Player not found after ${WAIT_FOR_PLAYER_TIMEOUT_MS}ms, skipping`);
    return;
  }

  overlay = new SubtitleOverlay();
  overlay.mount();

  progressBar = new ProgressBar();
  progressBar.mount();

  const settings = await loadSettings();
  overlay.configure(settings);
  progressBar.setTargetLang(settings.targetLang);

  // 캐시 확인
  const cached = await getCached(videoId, settings.targetLang);
  if (cached) {
    console.log(`${LOG} Cache hit for ${videoId}`);
    segments = cached;
    overlay.setSegments(segments);
    progressBar.setSegments(segments);
    progressBar.onComplete();
    return;
  }

  overlay.setSegments(segments);
  progressBar.setSegments(segments);

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

function waitForPlayer(): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + WAIT_FOR_PLAYER_TIMEOUT_MS;
    const check = (): void => {
      if (document.querySelector("#movie_player video.html5-main-video")) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}

async function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve(result as Settings);
    });
  });
}

/** Background → content: 번역 결과 수신. */
chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "TRANSLATION_UPDATE" && message.videoId === currentVideoId) {
    for (const seg of message.segments) {
      const target = segments[seg.index];
      if (target) {
        target.translated = seg.translated;
      }
      overlay?.updateTranslation(seg.index, seg.translated);
    }
    progressBar?.onTranslationUpdate();
  }

  if (message.type === "TRANSLATION_COMPLETE" && message.videoId === currentVideoId) {
    console.log(`${LOG} Translation complete`);
    progressBar?.onComplete();
    loadSettings().then((settings) => {
      setCached(currentVideoId!, settings.targetLang, segments).catch(console.error);
    });
  }
});

/** 설정 변경 → overlay 재설정 + 언어 변경 시 재번역. */
chrome.storage.onChanged.addListener((changes) => {
  if (overlay && (changes["showDualSubtitles"] || changes["fontSize"] || changes["overlayPosition"])) {
    loadSettings().then((s) => overlay?.configure(s));
  }

  if (changes["targetLang"] && currentVideoId && segments.length > 0) {
    const newLang = changes["targetLang"].newValue as string;
    console.log(`${LOG} Language changed to ${newLang}`);
    progressBar?.setTargetLang(newLang);

    getCached(currentVideoId, newLang).then((cached) => {
      if (cached) {
        console.log(`${LOG} Cache hit for ${newLang} — instant load`);
        segments = cached;
        overlay?.setSegments(segments);
        progressBar?.setSegments(segments);
        progressBar?.onComplete();
        return;
      }

      console.log(`${LOG} No cache for ${newLang}, translating...`);
      for (const seg of segments) seg.translated = undefined;
      overlay?.setSegments(segments);
      progressBar?.setSegments(segments);

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
