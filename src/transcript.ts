import type { TranscriptSegment } from "./types";

/**
 * YouTube transcript 추출.
 *
 * 3단계 fallback:
 * 1. player.getPlayerResponse() (SPA 내비게이션 후 가장 안정적)
 * 2. ytInitialPlayerResponse (초기 페이지 로드 시)
 * 3. YouTube timedtext XML API (위 둘 다 실패 시)
 */

interface CaptionTrack {
  baseUrl: string;
  name: { simpleText: string };
  languageCode: string;
  kind?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: { utf8?: string }[];
}

const LOG = "[AI Subtitle]";

/** player element에서 caption tracks를 추출한다 (SPA 안전). */
function getTracksFromPlayer(): CaptionTrack[] {
  try {
    const player = document.querySelector("#movie_player") as HTMLElement & {
      getPlayerResponse?: () => {
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: CaptionTrack[];
          };
        };
      };
    };

    const resp = player?.getPlayerResponse?.();
    const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (tracks?.length) {
      console.log(`${LOG} Found ${tracks.length} tracks via getPlayerResponse`);
      return tracks;
    }
  } catch {
    // not available
  }
  return [];
}

/** DOM script tags에서 ytInitialPlayerResponse를 파싱한다. */
function getTracksFromInitialData(): CaptionTrack[] {
  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    const text = script.textContent;
    if (!text?.includes("ytInitialPlayerResponse")) continue;

    const match = text.match(
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});/s
    );
    if (!match?.[1]) continue;

    try {
      const data = JSON.parse(match[1]) as {
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: CaptionTrack[];
          };
        };
      };
      const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks?.length) {
        console.log(`${LOG} Found ${tracks.length} tracks via ytInitialPlayerResponse`);
        return tracks;
      }
    } catch {
      continue;
    }
  }
  return [];
}

/** caption tracks를 가져온다. player 우선, 초기 데이터 fallback. */
export function getCaptionTracks(): CaptionTrack[] {
  return getTracksFromPlayer().length > 0
    ? getTracksFromPlayer()
    : getTracksFromInitialData();
}

/** JSON3 transcript를 fetch한다. 빈 응답/파싱 실패 시 빈 배열 반환. */
async function fetchJson3Transcript(
  baseUrl: string
): Promise<Json3Event[]> {
  const url = new URL(baseUrl);
  url.searchParams.set("fmt", "json3");

  console.log(`${LOG} Fetching transcript: ${url.hostname}${url.pathname}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    console.warn(`${LOG} Transcript fetch failed: ${response.status}`);
    return [];
  }

  const text = await response.text();
  if (!text || text.length < 10) {
    console.warn(`${LOG} Transcript response empty`);
    return [];
  }

  try {
    const data = JSON.parse(text) as { events?: Json3Event[] };
    console.log(`${LOG} Parsed ${data.events?.length ?? 0} events`);
    return data.events ?? [];
  } catch {
    console.warn(`${LOG} Transcript JSON parse failed, trying XML fallback`);
    return [];
  }
}

/** XML 형식 transcript를 fallback으로 fetch한다. */
async function fetchXmlTranscript(
  baseUrl: string
): Promise<TranscriptSegment[]> {
  // fmt 파라미터 없이 호출하면 XML 반환
  const url = new URL(baseUrl);
  url.searchParams.delete("fmt");

  console.log(`${LOG} Trying XML transcript fallback`);

  const response = await fetch(url.toString());
  if (!response.ok) return [];

  const xml = await response.text();
  if (!xml || !xml.includes("<text")) return [];

  const segments: TranscriptSegment[] = [];
  // <text start="1.54" dur="4.16">text here</text>
  const regex = /<text\s+start="([\d.]+)"\s+dur="([\d.]+)"[^>]*>(.*?)<\/text>/gs;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = regex.exec(xml)) !== null) {
    const startSec = parseFloat(match[1] ?? "0");
    const durSec = parseFloat(match[2] ?? "0");
    const rawText = match[3] ?? "";
    // HTML entity decode
    const text = rawText
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    if (!text) continue;

    segments.push({
      index,
      start_ms: Math.round(startSec * 1000),
      duration_ms: Math.round(durSec * 1000),
      text,
    });
    index++;
  }

  console.log(`${LOG} XML fallback: ${segments.length} segments`);
  return segments;
}

function eventsToSegments(events: Json3Event[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let index = 0;

  for (const event of events) {
    if (event.tStartMs == null || event.dDurationMs == null) continue;
    if (!event.segs?.length) continue;

    const text = event.segs
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .trim();

    if (!text || text === "\n") continue;

    segments.push({
      index,
      start_ms: event.tStartMs,
      duration_ms: event.dDurationMs,
      text,
    });
    index++;
  }

  return segments;
}

/**
 * YouTube 영상에서 transcript를 추출한다.
 * JSON3 → XML fallback 순서로 시도.
 */
export async function extractTranscript(
  preferredLang?: string
): Promise<TranscriptSegment[] | null> {
  const tracks = getCaptionTracks();
  console.log(`${LOG} Caption tracks: ${tracks.length}`, tracks.map(t => `${t.languageCode}${t.kind === "asr" ? "(auto)" : ""}`));

  if (tracks.length === 0) {
    console.warn(`${LOG} No caption tracks found`);
    return null;
  }

  const track =
    tracks.find((t) => t.languageCode === preferredLang && t.kind !== "asr") ??
    tracks.find((t) => t.languageCode === preferredLang) ??
    tracks.find((t) => t.kind !== "asr") ??
    tracks[0];

  if (!track) return null;
  console.log(`${LOG} Using track: ${track.languageCode} (${track.name?.simpleText ?? "unknown"})`);

  // JSON3 시도
  const events = await fetchJson3Transcript(track.baseUrl);
  if (events.length > 0) {
    const segs = eventsToSegments(events);
    console.log(`${LOG} Extracted ${segs.length} segments (JSON3)`);
    return segs.length > 0 ? segs : null;
  }

  // XML fallback
  const xmlSegs = await fetchXmlTranscript(track.baseUrl);
  if (xmlSegs.length > 0) {
    console.log(`${LOG} Extracted ${xmlSegs.length} segments (XML)`);
    return xmlSegs;
  }

  console.warn(`${LOG} All transcript extraction methods failed`);
  return null;
}

/** 현재 YouTube 페이지의 video ID를 추출한다. */
export function getVideoId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("v");
}
