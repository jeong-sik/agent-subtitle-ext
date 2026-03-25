/**
 * MAIN world script — YouTube fetch를 intercept하여 timedtext 응답을 캡처.
 *
 * YouTube player가 자막을 렌더링할 때 timedtext URL을 fetch한다.
 * 그 응답을 가로채서 content script에 전달한다.
 * 우리가 직접 fetch할 필요 없음 — YouTube가 이미 하는 걸 관찰.
 */

const LOG = "[AI Subtitle:inject]";

interface TranscriptSegment {
  index: number;
  start_ms: number;
  duration_ms: number;
  text: string;
}

let capturedSegments: TranscriptSegment[] = [];
let lastVideoId = "";

/** JSON3 이벤트를 세그먼트로 변환. */
function json3ToSegments(events: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let idx = 0;
  for (const ev of events) {
    if (ev.tStartMs == null || ev.dDurationMs == null || !ev.segs?.length) continue;
    const text = ev.segs.map(s => s.utf8 ?? "").join("").trim();
    if (!text || text === "\n") continue;
    segments.push({ index: idx, start_ms: ev.tStartMs, duration_ms: ev.dDurationMs, text });
    idx++;
  }
  return segments;
}

/** XML timedtext를 세그먼트로 변환. */
function xmlToSegments(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const regex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>(.*?)<\/text>/gs;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = regex.exec(xml)) !== null) {
    const text = (match[3] ?? "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").trim();
    if (!text) continue;
    segments.push({
      index: idx,
      start_ms: Math.round(parseFloat(match[1] ?? "0") * 1000),
      duration_ms: Math.round(parseFloat(match[2] ?? "0") * 1000),
      text,
    });
    idx++;
  }
  return segments;
}

/** 응답 텍스트를 파싱해서 세그먼트를 추출. */
function parseTimedTextResponse(text: string): TranscriptSegment[] {
  if (!text || text.length < 10) return [];

  // JSON3 시도
  try {
    const data = JSON.parse(text);
    if (data.events?.length) {
      return json3ToSegments(data.events);
    }
  } catch {
    // not JSON
  }

  // XML 시도
  if (text.includes("<text")) {
    return xmlToSegments(text);
  }

  return [];
}

/** 세그먼트를 content script에 전달. */
function emitSegments(videoId: string, segments: TranscriptSegment[]): void {
  if (segments.length === 0) return;
  if (videoId === lastVideoId && capturedSegments.length > 0) return; // 중복 방지

  lastVideoId = videoId;
  capturedSegments = segments;

  console.log(`${LOG} Captured ${segments.length} segments for ${videoId}`);

  window.dispatchEvent(new CustomEvent("__AI_SUBTITLE__", {
    detail: { videoId, segments },
  }));
}

// === fetch intercept ===
const originalFetch = window.fetch;
window.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
  const response = await originalFetch.apply(this, args);

  const url = typeof args[0] === "string" ? args[0] : (args[0] as Request)?.url ?? "";

  if (url.includes("/api/timedtext") || url.includes("timedtext?")) {
    const videoId = new URLSearchParams(window.location.search).get("v") ?? "";

    // clone으로 body를 한 번 더 읽음 (원래 소비자에게 영향 없음)
    try {
      const clone = response.clone();
      const text = await clone.text();
      console.log(`${LOG} Intercepted timedtext fetch: ${text.length} chars`);
      const segments = parseTimedTextResponse(text);
      if (segments.length > 0) {
        emitSegments(videoId, segments);
      }
    } catch {
      // clone/read 실패 무시
    }
  }

  return response;
};

// === XMLHttpRequest intercept (YouTube는 XHR도 사용) ===
const originalXhrOpen = XMLHttpRequest.prototype.open;
const originalXhrSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
  (this as XMLHttpRequest & { _url?: string })._url = typeof url === "string" ? url : url.toString();
  return originalXhrOpen.apply(this, [method, url, ...rest] as Parameters<typeof originalXhrOpen>);
};

XMLHttpRequest.prototype.send = function (...args: Parameters<typeof originalXhrSend>) {
  const xhr = this as XMLHttpRequest & { _url?: string };
  const url = xhr._url ?? "";

  if (url.includes("/api/timedtext") || url.includes("timedtext?")) {
    xhr.addEventListener("load", () => {
      const videoId = new URLSearchParams(window.location.search).get("v") ?? "";
      const text = xhr.responseText ?? "";
      console.log(`${LOG} Intercepted timedtext XHR: ${text.length} chars`);
      const segments = parseTimedTextResponse(text);
      if (segments.length > 0) {
        emitSegments(videoId, segments);
      }
    });
  }

  return originalXhrSend.apply(this, args);
};

console.log(`${LOG} Fetch/XHR intercept installed`);

// 이미 자막이 로드된 경우를 위해, 수동으로 자막 활성화 시도
setTimeout(() => {
  const videoId = new URLSearchParams(window.location.search).get("v");
  if (!videoId) return;

  if (capturedSegments.length > 0) return; // 이미 캡처됨

  // YouTube player에게 자막을 켜달라고 요청
  try {
    const player = document.querySelector("#movie_player") as HTMLElement & {
      loadModule?: (m: string) => void;
      getOption?: (m: string, o: string) => unknown;
      setOption?: (m: string, o: string, v: unknown) => void;
    };

    player?.loadModule?.("captions");
    const tracks = player?.getOption?.("captions", "tracklist") as
      | { languageCode: string }[]
      | undefined;

    if (tracks?.length) {
      console.log(`${LOG} Triggering caption reload for ${tracks[0]?.languageCode}`);
      // 트랙을 null로 설정했다가 다시 켜면 YouTube가 timedtext를 다시 fetch함
      player?.setOption?.("captions", "track", {});
      setTimeout(() => {
        player?.setOption?.("captions", "track", tracks[0]);
      }, 200);
    }
  } catch (e) {
    console.warn(`${LOG} Caption trigger failed:`, e);
  }
}, 3000);
