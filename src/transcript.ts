import type { TranscriptSegment } from "./types";

/**
 * YouTube Innertube API를 통해 transcript를 추출한다.
 * JSON3 format으로 밀리초 정밀도 타이밍 데이터를 반환한다.
 *
 * Flow:
 * 1. ytInitialPlayerResponse에서 captionTracks 추출
 * 2. baseUrl + fmt=json3 으로 실제 transcript fetch
 * 3. events → TranscriptSegment[] 변환
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

/**
 * 현재 YouTube 페이지에서 사용 가능한 caption track 목록을 가져온다.
 * ytInitialPlayerResponse를 DOM에서 파싱하거나, Innertube API를 호출한다.
 */
export function getCaptionTracks(): CaptionTrack[] {
  // ytInitialPlayerResponse는 YouTube 페이지 로드 시 DOM에 삽입된다.
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
      return data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    } catch {
      continue;
    }
  }

  // SPA 내비게이션 후에는 window.ytInitialPlayerResponse가 없을 수 있다.
  // ytplayer.config.args에서 시도.
  try {
    const playerResponse = (
      document.querySelector("#movie_player") as HTMLElement & {
        getPlayerResponse?: () => {
          captions?: {
            playerCaptionsTracklistRenderer?: {
              captionTracks?: CaptionTrack[];
            };
          };
        };
      }
    )?.getPlayerResponse?.();

    if (playerResponse) {
      return (
        playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
      );
    }
  } catch {
    // getPlayerResponse not available
  }

  return [];
}

/**
 * caption track의 baseUrl로 JSON3 transcript를 fetch한다.
 */
async function fetchJson3Transcript(
  baseUrl: string
): Promise<Json3Event[]> {
  const url = new URL(baseUrl);
  url.searchParams.set("fmt", "json3");

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Transcript fetch failed: ${response.status}`);
  }

  const data = (await response.json()) as { events?: Json3Event[] };
  return data.events ?? [];
}

/**
 * JSON3 events를 TranscriptSegment[]로 변환한다.
 * 빈 segment, 메타데이터 event를 필터링한다.
 */
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
 *
 * @param preferredLang - 선호 언어 코드 (예: "en"). 없으면 첫 번째 track 사용.
 * @returns TranscriptSegment[] 또는 null (자막 없음)
 */
export async function extractTranscript(
  preferredLang?: string
): Promise<TranscriptSegment[] | null> {
  const tracks = getCaptionTracks();
  if (tracks.length === 0) return null;

  // 선호 언어 track 찾기. 없으면 ASR(auto-generated) 아닌 것 우선.
  let track =
    tracks.find((t) => t.languageCode === preferredLang && t.kind !== "asr") ??
    tracks.find((t) => t.languageCode === preferredLang) ??
    tracks.find((t) => t.kind !== "asr") ??
    tracks[0];

  if (!track) return null;

  const events = await fetchJson3Transcript(track.baseUrl);
  return eventsToSegments(events);
}

/**
 * 현재 YouTube 페이지의 video ID를 추출한다.
 */
export function getVideoId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("v");
}
