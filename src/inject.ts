/**
 * MAIN world — YouTube 페이지 컨텍스트.
 *
 * Primary: Innertube get_transcript API (CC 토글 불필요)
 * Fallback: fetch/XHR intercept (YouTube 자체 timedtext 요청 캡처)
 */

const LOG = "[AI Subtitle:inject]";

interface Segment {
  index: number;
  start_ms: number;
  duration_ms: number;
  text: string;
}

let capturedSegments: Segment[] = [];
let lastVideoId = "";

function emit(videoId: string, segments: Segment[]): void {
  if (segments.length === 0 || (videoId === lastVideoId && capturedSegments.length > 0)) return;
  lastVideoId = videoId;
  capturedSegments = segments;
  console.log(`${LOG} Captured ${segments.length} segments for ${videoId}`);
  window.postMessage({ type: "__AI_SUBTITLE_TRANSCRIPT__", videoId, segments }, "*");
}

// ─── Innertube get_transcript (Primary) ────────────────────

/** ytcfg에서 API key 추출. */
function getApiKey(): string {
  try {
    const ytcfg = (window as unknown as { ytcfg?: { get: (k: string) => string } }).ytcfg;
    return ytcfg?.get("INNERTUBE_API_KEY") ?? "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  } catch {
    return "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  }
}

/** ytcfg에서 client context 추출. */
function getClientContext(): Record<string, string> {
  try {
    const ytcfg = (window as unknown as { ytcfg?: { get: (k: string) => string } }).ytcfg;
    return {
      hl: ytcfg?.get("HL") ?? "en",
      gl: ytcfg?.get("GL") ?? "US",
      clientName: "WEB",
      clientVersion: ytcfg?.get("INNERTUBE_CLIENT_VERSION") ?? "2.20260324",
    };
  } catch {
    return { hl: "en", gl: "US", clientName: "WEB", clientVersion: "2.20260324" };
  }
}

/** /youtubei/v1/next 에서 transcript params 추출. */
async function getTranscriptParams(videoId: string): Promise<string | null> {
  const apiKey = getApiKey();
  const client = getClientContext();

  const resp = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${apiKey}&prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: { client }, videoId }),
  });

  if (!resp.ok) return null;
  const data = await resp.json();

  // 재귀적으로 getTranscriptEndpoint.params 검색
  function findParams(obj: unknown, depth = 0): string | null {
    if (depth > 15 || !obj || typeof obj !== "object") return null;
    const record = obj as Record<string, unknown>;
    if ("getTranscriptEndpoint" in record) {
      const ep = record["getTranscriptEndpoint"] as Record<string, unknown>;
      if (typeof ep?.params === "string") return ep.params;
    }
    for (const v of Object.values(record)) {
      const r = findParams(v, depth + 1);
      if (r) return r;
    }
    return null;
  }

  return findParams(data);
}

/** get_transcript 호출 → segments 파싱. */
async function fetchViaInnertube(videoId: string): Promise<Segment[]> {
  console.log(`${LOG} Trying Innertube get_transcript...`);

  const params = await getTranscriptParams(videoId);
  if (!params) {
    console.warn(`${LOG} Innertube: no transcript params found`);
    return [];
  }

  const apiKey = getApiKey();
  const client = getClientContext();

  const resp = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: { client }, params }),
  });

  if (!resp.ok) {
    console.warn(`${LOG} Innertube: get_transcript failed ${resp.status}`);
    return [];
  }

  const data = await resp.json();

  // 응답 구조: actions[0].updateEngagementPanelAction.content.transcriptRenderer.body.transcriptBodyRenderer.cueGroups[]
  const segments: Segment[] = [];
  try {
    const body = data
      ?.actions?.[0]
      ?.updateEngagementPanelAction
      ?.content
      ?.transcriptRenderer
      ?.body
      ?.transcriptBodyRenderer;

    const cueGroups = body?.cueGroups ?? [];
    let idx = 0;
    for (const group of cueGroups) {
      const cue = group?.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
      if (!cue) continue;
      const text = cue.cue?.simpleText ?? cue.cue?.runs?.map((r: { text: string }) => r.text).join("") ?? "";
      if (!text.trim()) continue;
      const startMs = parseInt(cue.startOffsetMs ?? "0", 10);
      const durMs = parseInt(cue.durationMs ?? "0", 10);
      segments.push({ index: idx, start_ms: startMs, duration_ms: durMs, text: text.trim() });
      idx++;
    }
  } catch (e) {
    console.warn(`${LOG} Innertube: parse error`, e);
  }

  console.log(`${LOG} Innertube: ${segments.length} segments`);
  return segments;
}

// ─── XHR/Fetch Intercept (Fallback) ───────────────────────

function parseTimedText(text: string): Segment[] {
  if (!text || text.length < 10) return [];
  try {
    const data = JSON.parse(text);
    if (data.events?.length) {
      const segs: Segment[] = [];
      let idx = 0;
      for (const ev of data.events) {
        if (ev.tStartMs == null || ev.dDurationMs == null || !ev.segs?.length) continue;
        const t = ev.segs.map((s: { utf8?: string }) => s.utf8 ?? "").join("").trim();
        if (!t || t === "\n") continue;
        segs.push({ index: idx, start_ms: ev.tStartMs, duration_ms: ev.dDurationMs, text: t });
        idx++;
      }
      return segs;
    }
  } catch { /* not JSON */ }

  if (text.includes("<text")) {
    const segs: Segment[] = [];
    const re = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>(.*?)<\/text>/gs;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(text)) !== null) {
      const t = (m[3] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      if (!t) continue;
      segs.push({ index: idx, start_ms: Math.round(parseFloat(m[1] ?? "0") * 1000), duration_ms: Math.round(parseFloat(m[2] ?? "0") * 1000), text: t });
      idx++;
    }
    return segs;
  }

  return [];
}

// Intercept fetch
const origFetch = window.fetch;
window.fetch = async function (...args) {
  const resp = await origFetch.apply(this, args);
  const url = typeof args[0] === "string" ? args[0] : (args[0] as Request)?.url ?? "";
  if (url.includes("/api/timedtext") || url.includes("timedtext?")) {
    try {
      const clone = resp.clone();
      const text = await clone.text();
      console.log(`${LOG} Intercepted timedtext fetch: ${text.length} chars`);
      const videoId = new URLSearchParams(window.location.search).get("v") ?? "";
      const segs = parseTimedText(text);
      if (segs.length > 0) emit(videoId, segs);
    } catch { /* ignore */ }
  }
  return resp;
};

// Intercept XHR
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
  (this as XMLHttpRequest & { _url?: string })._url = typeof url === "string" ? url : url.toString();
  return origOpen.apply(this, [method, url, ...rest] as Parameters<typeof origOpen>);
};
XMLHttpRequest.prototype.send = function (...args) {
  const xhr = this as XMLHttpRequest & { _url?: string };
  if (xhr._url?.includes("/api/timedtext") || xhr._url?.includes("timedtext?")) {
    xhr.addEventListener("load", () => {
      const text = xhr.responseText ?? "";
      console.log(`${LOG} Intercepted timedtext XHR: ${text.length} chars`);
      const videoId = new URLSearchParams(window.location.search).get("v") ?? "";
      const segs = parseTimedText(text);
      if (segs.length > 0) emit(videoId, segs);
    });
  }
  return origSend.apply(this, args);
};

console.log(`${LOG} Intercept installed`);

// ─── Main: Innertube first, intercept as fallback ─────────

async function run(): Promise<void> {
  const videoId = new URLSearchParams(window.location.search).get("v");
  if (!videoId) return;

  // 이미 캡처된 데이터가 있으면 스킵
  if (videoId === lastVideoId && capturedSegments.length > 0) {
    emit(videoId, capturedSegments);
    return;
  }

  // Reset
  capturedSegments = [];
  lastVideoId = "";

  // Primary: Innertube
  const segs = await fetchViaInnertube(videoId);
  if (segs.length > 0) {
    emit(videoId, segs);
    return;
  }

  // Fallback: CC 트리거해서 XHR intercept가 잡도록
  console.log(`${LOG} Innertube failed, triggering CC for XHR intercept...`);
  try {
    const player = document.querySelector("#movie_player") as HTMLElement & {
      loadModule?: (m: string) => void;
      getOption?: (m: string, o: string) => unknown;
      setOption?: (m: string, o: string, v: unknown) => void;
    };
    player?.loadModule?.("captions");
    const tracks = player?.getOption?.("captions", "tracklist") as { languageCode: string }[] | undefined;
    if (tracks?.length) {
      player?.setOption?.("captions", "track", {});
      setTimeout(() => player?.setOption?.("captions", "track", tracks[0]), 300);
    }
  } catch { /* ignore */ }
}

document.addEventListener("yt-navigate-finish", () => {
  capturedSegments = [];
  lastVideoId = "";
  setTimeout(() => run().catch(console.error), 1500);
});

setTimeout(() => run().catch(console.error), 2000);
