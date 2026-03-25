import { extractTranscript, getVideoId } from "./transcript";
import { SubtitleOverlay } from "./overlay";
import { getCached, setCached } from "./cache";
import type { ExtensionMessage, TranscriptSegment, Settings, DEFAULT_SETTINGS } from "./types";

/**
 * Content script: YouTube 페이지에 주입되어 동작한다.
 *
 * 역할:
 * 1. 영상 변경 감지 → transcript 추출
 * 2. background에 transcript 전달
 * 3. 번역 결과 수신 → overlay 업데이트
 * 4. 캐시 히트 시 즉시 overlay 표시
 */

let overlay: SubtitleOverlay | null = null;
let currentVideoId: string | null = null;
let segments: TranscriptSegment[] = [];

/** YouTube SPA 네비게이션을 감지한다. */
function observeNavigation(callback: () => void): void {
  // YouTube는 History API로 네비게이션하므로 yt-navigate-finish 이벤트를 감시
  document.addEventListener("yt-navigate-finish", callback);

  // 초기 로드
  callback();
}

/** 현재 영상에 대해 transcript를 추출하고 번역을 시작한다. */
async function onVideoChange(): Promise<void> {
  const videoId = getVideoId();
  if (!videoId || videoId === currentVideoId) return;

  currentVideoId = videoId;
  segments = [];

  // overlay 마운트 (영상 로드 대기)
  await waitForPlayer();

  if (!overlay) {
    overlay = new SubtitleOverlay();
  }
  overlay.mount();

  // 설정 로드
  const settings = await loadSettings();
  overlay.configure(settings);

  // 캐시 확인
  const cached = await getCached(videoId, settings.targetLang);
  if (cached) {
    segments = cached;
    overlay.setSegments(segments);
    notifyBackground({ type: "STATUS_UPDATE", status: "connected" });
    return;
  }

  // transcript 추출
  const extracted = await extractTranscript();
  if (!extracted?.length) {
    console.warn("[MASC Subtitle] No transcript available for", videoId);
    return;
  }

  segments = extracted;
  overlay.setSegments(segments);

  // background에 transcript 전달 → 번역 시작
  notifyBackground({
    type: "TRANSCRIPT_READY",
    videoId,
    segments: extracted,
  });
}

/** YouTube player가 DOM에 로드될 때까지 대기한다. */
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

/** Background service worker에 메시지를 보낸다. */
function notifyBackground(message: ExtensionMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // background가 아직 준비되지 않았을 수 있음
  });
}

/** chrome.storage에서 설정을 로드한다. */
async function loadSettings(): Promise<Settings> {
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

/** Background에서 오는 번역 결과를 수신한다. */
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
    // 번역 완료 → 캐시 저장
    loadSettings().then((settings) => {
      setCached(currentVideoId!, settings.targetLang, segments).catch(console.error);
    });
  }
});

// 시작
observeNavigation(() => {
  onVideoChange().catch(console.error);
});
