/**
 * MAIN world — YouTube 페이지 컨텍스트에서 transcript를 추출한다.
 *
 * 전략 (우선순위):
 * 1. ytInitialPlayerResponse → captionTracks[].baseUrl (인증 토큰 내장)
 * 2. player.getOption("captions", "tracklist") → baseUrl
 * 3. XHR/fetch intercept (CC 켜져 있을 때 자동 캡처)
 *
 * 1번이 가장 안정적: 별도 API 호출 없이 페이지가 이미 가진 데이터를 읽는다.
 */

const LOG = "[AI Subtitle:inject]";

interface Segment {
  index: number;
  start_ms: number;
  duration_ms: number;
  text: string;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name?: { simpleText?: string };
  kind?: string; // "asr" = auto-generated
}

let capturedSegments: Segment[] = [];
let lastVideoId = "";
let primaryRunDone = false;

function getVideoId(): string {
  return new URLSearchParams(window.location.search).get("v") ?? "";
}

/** MAIN world -> ISOLATED world -> background debug log. */
function dbg(msg: string): void {
  console.log(`${LOG} ${msg}`);
  window.postMessage({ type: "__AI_SUBTITLE_DEBUG__", msg }, "*");
}

function emit(videoId: string, segments: Segment[]): void {
  if (segments.length === 0) return;
  if (videoId === lastVideoId && capturedSegments.length > 0) return;
  lastVideoId = videoId;
  capturedSegments = segments;
  dbg(`Emit ${segments.length} segments for ${videoId}`);
  window.postMessage({ type: "__AI_SUBTITLE_TRANSCRIPT__", videoId, segments }, "*");
}

// ─── Strategy 1: ytInitialPlayerResponse ─────────────────

/**
 * YouTube 페이지가 로드할 때 window.ytInitialPlayerResponse에
 * captions.playerCaptionsTracklistRenderer.captionTracks 배열이 존재.
 * SPA 네비게이션 후에는 사라지므로 ytplayer.config도 확인.
 */
function getCaptionTracks(): CaptionTrack[] {
  try {
    // 첫 로드: ytInitialPlayerResponse
    const w = window as unknown as Record<string, unknown>;
    const initial = w["ytInitialPlayerResponse"] as Record<string, unknown> | undefined;
    const tracks = extractTracks(initial);
    if (tracks.length > 0) return tracks;

    // SPA 네비게이션 후: player API
    const player = document.querySelector("#movie_player") as HTMLElement & {
      getPlayerResponse?: () => Record<string, unknown>;
      getOption?: (m: string, o: string) => unknown;
    };

    // player.getPlayerResponse()
    const playerResp = player?.getPlayerResponse?.();
    const tracks2 = extractTracks(playerResp);
    if (tracks2.length > 0) return tracks2;

    // player.getOption("captions", "tracklist")
    const tracklist = player?.getOption?.("captions", "tracklist") as CaptionTrack[] | undefined;
    if (tracklist?.length) return tracklist;
  } catch (e) {
    console.warn(`${LOG} getCaptionTracks error:`, e);
  }
  return [];
}

function extractTracks(response: Record<string, unknown> | undefined): CaptionTrack[] {
  if (!response) return [];
  try {
    const captions = response["captions"] as Record<string, unknown> | undefined;
    const renderer = captions?.["playerCaptionsTracklistRenderer"] as Record<string, unknown> | undefined;
    const tracks = renderer?.["captionTracks"] as CaptionTrack[] | undefined;
    return tracks ?? [];
  } catch {
    return [];
  }
}

/**
 * captionTracks에서 영어 트랙을 우선 선택.
 * 없으면 첫 번째 트랙 사용.
 */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  // 영어 우선
  const en = tracks.find((t) => t.languageCode === "en");
  if (en) return en;
  // 그 외 아무거나
  return tracks[0] ?? null;
}

/** baseUrl에서 json3 형식으로 transcript fetch. */
async function fetchFromBaseUrl(baseUrl: string): Promise<Segment[]> {
  // fmt=json3 추가 (이미 있으면 덮어쓰기)
  const url = new URL(baseUrl);
  url.searchParams.set("fmt", "json3");

  dbg("Fetching transcript from baseUrl...");
  const resp = await fetch(url.toString());
  if (!resp.ok) {
    dbg(`baseUrl fetch failed: ${resp.status}`);
    return [];
  }

  const text = await resp.text();
  dbg(`baseUrl response: ${text.length} chars`);
  return parseJson3(text);
}

// ─── JSON3 Parser ────────────────────────────────────────

/**
 * YouTube JSON3 timedtext 형식 파싱.
 * { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
 */
function parseJson3(text: string): Segment[] {
  if (!text || text.length < 10) return [];

  try {
    const data = JSON.parse(text) as {
      events?: {
        tStartMs?: number;
        dDurationMs?: number;
        segs?: { utf8?: string }[];
      }[];
    };

    if (!data.events?.length) return [];

    const segments: Segment[] = [];
    let idx = 0;

    for (const ev of data.events) {
      if (ev.tStartMs == null || !ev.segs?.length) continue;

      const t = ev.segs.map((s) => s.utf8 ?? "").join("").trim();
      if (!t || t === "\n") continue;

      // dDurationMs가 없는 이벤트도 있음 (예: 라인 구분자)
      const duration = ev.dDurationMs ?? 0;
      if (duration === 0) continue;

      segments.push({
        index: idx,
        start_ms: ev.tStartMs,
        duration_ms: duration,
        text: t,
      });
      idx++;
    }

    return segments;
  } catch {
    return [];
  }
}

// ─── Strategy 3: XHR/Fetch Intercept (Last Resort) ───────

/** tlang= 파라미터가 있으면 YouTube 자동번역 → 무시. 원본 자막만 캡처. */
function isAutoTranslated(url: string): boolean {
  return url.includes("tlang=");
}

const origFetch = window.fetch;
window.fetch = async function (...args) {
  const resp = await origFetch.apply(this, args);
  const url = typeof args[0] === "string" ? args[0] : (args[0] as Request)?.url ?? "";
  if ((url.includes("/api/timedtext") || url.includes("timedtext?")) && !isAutoTranslated(url) && primaryRunDone) {
    try {
      const clone = resp.clone();
      const text = await clone.text();
      dbg(`Intercepted timedtext fetch: ${text.length} chars`);
      const videoId = getVideoId();
      const segs = parseJson3(text);
      if (segs.length > 0) emit(videoId, segs);
    } catch { /* ignore */ }
  }
  return resp;
};

const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
  (this as XMLHttpRequest & { _url?: string })._url = typeof url === "string" ? url : url.toString();
  return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
};
XMLHttpRequest.prototype.send = function (...args) {
  const xhr = this as XMLHttpRequest & { _url?: string };
  const xhrUrl = xhr._url ?? "";
  if ((xhrUrl.includes("/api/timedtext") || xhrUrl.includes("timedtext?")) && !isAutoTranslated(xhrUrl) && primaryRunDone) {
    xhr.addEventListener("load", () => {
      const text = xhr.responseText ?? "";
      dbg(`Intercepted timedtext XHR: ${text.length} chars (${xhrUrl.match(/lang=([^&]*)/)?.[1] ?? "?"})`);
      const videoId = getVideoId();
      const segs = parseJson3(text);
      if (segs.length > 0) emit(videoId, segs);
    });
  }
  return origSend.apply(this, args);
};

dbg("Intercept installed");

// ─── Main ────────────────────────────────────────────────

async function run(): Promise<void> {
  const videoId = getVideoId();
  if (!videoId) return;

  if (videoId === lastVideoId && capturedSegments.length > 0) {
    emit(videoId, capturedSegments);
    primaryRunDone = true;
    return;
  }

  capturedSegments = [];
  lastVideoId = "";

  // Strategy 1: captionTracks baseUrl (가장 안정적)
  const tracks = getCaptionTracks();
  dbg(`Found ${tracks.length} caption tracks: ${tracks.map((t) => t.languageCode).join(", ")}`);

  if (tracks.length > 0) {
    const track = pickTrack(tracks);
    if (track) {
      dbg(`Using track: ${track.languageCode} (${track.kind ?? "manual"})`);
      const segs = await fetchFromBaseUrl(track.baseUrl);
      if (segs.length > 0) {
        emit(videoId, segs);
        primaryRunDone = true;
        return;
      }
      dbg(`baseUrl returned 0 segments, trying fallback...`);
    }
  }

  // Fallback: CC 트리거로 XHR intercept가 잡기를 기대
  primaryRunDone = true; // intercept 활성화
  dbg("Triggering CC for XHR intercept fallback...");
  try {
    const player = document.querySelector("#movie_player") as HTMLElement & {
      loadModule?: (m: string) => void;
      getOption?: (m: string, o: string) => unknown;
      setOption?: (m: string, o: string, v: unknown) => void;
    };
    player?.loadModule?.("captions");
    const playerTracks = player?.getOption?.("captions", "tracklist") as CaptionTrack[] | undefined;
    if (playerTracks?.length) {
      player?.setOption?.("captions", "track", {});
      setTimeout(() => player?.setOption?.("captions", "track", playerTracks[0]), 300);
    }
  } catch { /* ignore */ }
}

// SPA 네비게이션 감지
document.addEventListener("yt-navigate-finish", () => {
  capturedSegments = [];
  lastVideoId = "";
  primaryRunDone = false;
  // Signal content script to reset overlay/progress bar
  window.postMessage({ type: "__AI_SUBTITLE_RESET__" }, "*");
  setTimeout(() => run().catch(console.error), 1000);
});

// 초기 실행 — document_idle이므로 페이지 기본 데이터는 이미 존재
setTimeout(() => run().catch(console.error), 500);
