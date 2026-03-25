import { SubtitleOverlay } from "./overlay";
import { getCached, setCached } from "./cache";
import type { ExtensionMessage, TranscriptSegment, Settings } from "./types";

/**
 * Content script (ISOLATED world).
 *
 * Transcript 추출은 inject.ts (MAIN world)가 담당.
 * 이 스크립트는 CustomEvent로 데이터를 받아서 overlay + background 통신.
 */

const LOG = "[AI Subtitle]";

let overlay: SubtitleOverlay | null = null;
let currentVideoId: string | null = null;
let segments: TranscriptSegment[] = [];

/** inject.ts에서 보낸 transcript 데이터 수신. */
window.addEventListener("__AI_SUBTITLE__", async (event: Event) => {
  const { videoId, segments: extracted } = (event as CustomEvent).detail as {
    videoId: string;
    segments: TranscriptSegment[];
  };

  console.log(`${LOG} Received ${extracted.length} segments for ${videoId}`);

  if (!videoId || extracted.length === 0) {
    console.warn(`${LOG} No transcript for ${videoId}`);
    return;
  }

  currentVideoId = videoId;
  segments = extracted;

  // overlay 마운트
  await waitForPlayer();
  if (!overlay) {
    overlay = new SubtitleOverlay();
  }
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

  // background에 번역 요청
  notifyBackground({
    type: "TRANSCRIPT_READY",
    videoId,
    segments: extracted,
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

function notifyBackground(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {});
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

/** Background에서 오는 번역 결과 수신. */
chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "TRANSLATION_UPDATE" && message.videoId === currentVideoId) {
    for (const seg of message.segments) {
      const target = segments[seg.index];
      if (target) {
        target.translated = seg.translated;
      }
      overlay?.updateTranslation(seg.index, seg.translated);
    }
  }

  if (message.type === "TRANSLATION_COMPLETE" && message.videoId === currentVideoId) {
    loadSettings().then((settings) => {
      setCached(currentVideoId!, settings.targetLang, segments).catch(console.error);
    });
  }
});

/** 설정 변경 시 현재 영상 재번역. */
chrome.storage.onChanged.addListener((changes) => {
  if (!changes["targetLang"] || !currentVideoId || segments.length === 0) return;

  console.log(`${LOG} Language changed to ${changes["targetLang"].newValue}, re-translating...`);

  // 기존 번역 제거
  for (const seg of segments) {
    seg.translated = undefined;
  }
  overlay?.setSegments(segments);

  // 재번역 요청
  notifyBackground({
    type: "TRANSCRIPT_READY",
    videoId: currentVideoId,
    segments,
  });
});
