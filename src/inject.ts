/**
 * MAIN world script — YouTube 페이지 컨텍스트에서 실행.
 *
 * Content script(ISOLATED world)에서는 YouTube의 signed timedtext URL을
 * fetch하면 빈 응답을 받음. MAIN world에서는 페이지의 쿠키/세션으로
 * fetch하므로 정상 동작.
 *
 * 통신: CustomEvent("__AI_SUBTITLE__") 로 content script에 데이터 전달.
 */

const LOG = "[AI Subtitle:inject]";

interface CaptionTrack {
  baseUrl: string;
  name: { simpleText: string };
  languageCode: string;
  kind?: string;
}

interface TranscriptSegment {
  index: number;
  start_ms: number;
  duration_ms: number;
  text: string;
}

function getCaptionTracks(): CaptionTrack[] {
  // MAIN world에서는 YouTube player API에 직접 접근 가능
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

    const tracks = player?.getPlayerResponse?.()
      ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (tracks?.length) return tracks;
  } catch {
    // fallback
  }

  // ytInitialPlayerResponse fallback
  try {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent;
      if (!text?.includes("ytInitialPlayerResponse")) continue;
      const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (!match?.[1]) continue;
      const data = JSON.parse(match[1]);
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks?.length) return tracks;
    }
  } catch {
    // parse error
  }

  return [];
}

async function fetchTranscript(): Promise<TranscriptSegment[]> {
  const tracks = getCaptionTracks();
  console.log(`${LOG} tracks: ${tracks.length}`, tracks.map(t =>
    `${t.languageCode}${t.kind === "asr" ? "(auto)" : ""}`
  ));

  if (tracks.length === 0) return [];

  const track =
    tracks.find(t => t.kind !== "asr") ??
    tracks[0];

  if (!track) return [];
  console.log(`${LOG} using: ${track.languageCode} (${track.name?.simpleText ?? "?"})`);

  // JSON3 시도
  const json3Url = new URL(track.baseUrl);
  json3Url.searchParams.set("fmt", "json3");

  try {
    const resp = await fetch(json3Url.toString());
    if (resp.ok) {
      const text = await resp.text();
      console.log(`${LOG} json3: ${text.length} chars`);
      if (text.length > 10) {
        const data = JSON.parse(text);
        const events = data.events ?? [];
        const segments: TranscriptSegment[] = [];
        let idx = 0;
        for (const ev of events) {
          if (ev.tStartMs == null || ev.dDurationMs == null || !ev.segs?.length) continue;
          const segText = ev.segs.map((s: { utf8?: string }) => s.utf8 ?? "").join("").trim();
          if (!segText || segText === "\n") continue;
          segments.push({ index: idx, start_ms: ev.tStartMs, duration_ms: ev.dDurationMs, text: segText });
          idx++;
        }
        if (segments.length > 0) {
          console.log(`${LOG} extracted ${segments.length} segments (json3)`);
          return segments;
        }
      }
    }
  } catch (e) {
    console.warn(`${LOG} json3 failed:`, e);
  }

  // XML fallback
  try {
    const xmlUrl = new URL(track.baseUrl);
    xmlUrl.searchParams.delete("fmt");
    const resp = await fetch(xmlUrl.toString());
    if (resp.ok) {
      const xml = await resp.text();
      console.log(`${LOG} xml: ${xml.length} chars`);
      if (xml.includes("<text")) {
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
        if (segments.length > 0) {
          console.log(`${LOG} extracted ${segments.length} segments (xml)`);
          return segments;
        }
      }
    }
  } catch (e) {
    console.warn(`${LOG} xml failed:`, e);
  }

  return [];
}

// Content script에 데이터 전달
async function run(): Promise<void> {
  const videoId = new URLSearchParams(window.location.search).get("v");
  if (!videoId) return;

  const segments = await fetchTranscript();

  window.dispatchEvent(new CustomEvent("__AI_SUBTITLE__", {
    detail: { videoId, segments },
  }));
}

// YouTube SPA 네비게이션 감지
document.addEventListener("yt-navigate-finish", () => {
  run().catch(console.error);
});

// 초기 로드
run().catch(console.error);
