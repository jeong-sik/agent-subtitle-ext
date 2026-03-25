/**
 * MAIN world script — YouTube 페이지 컨텍스트에서 실행.
 *
 * 전략:
 * 1. YouTube player의 자막을 활성화
 * 2. video.textTracks에서 cue 데이터를 읽음 (YouTube가 이미 로드한 데이터)
 * 3. fetch 불필요 — YouTube 자체 세션으로 로드된 데이터를 그대로 사용
 */

const LOG = "[AI Subtitle:inject]";

interface TranscriptSegment {
  index: number;
  start_ms: number;
  duration_ms: number;
  text: string;
}

interface YTPlayer extends HTMLElement {
  getPlayerResponse?: () => unknown;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => void;
  loadModule?: (module: string) => void;
}

function getPlayer(): YTPlayer | null {
  return document.querySelector("#movie_player") as YTPlayer | null;
}

function getVideo(): HTMLVideoElement | null {
  return document.querySelector("video.html5-main-video");
}

/** YouTube player에서 자막 트랙을 활성화한다. */
function enableCaptions(): void {
  const player = getPlayer();
  if (!player) return;

  try {
    player.loadModule?.("captions");

    const trackList = player.getOption?.("captions", "tracklist") as
      | { languageCode: string }[]
      | undefined;

    if (trackList?.length) {
      const currentTrack = player.getOption?.("captions", "track");
      if (!currentTrack) {
        player.setOption?.("captions", "track", trackList[0]);
        console.log(`${LOG} Enabled captions: ${trackList[0]?.languageCode}`);
      }
    }
  } catch (e) {
    console.warn(`${LOG} Failed to enable captions:`, e);
  }
}

/** video.textTracks에서 cue 데이터를 추출한다. */
function extractFromTextTracks(): TranscriptSegment[] {
  const video = getVideo();
  if (!video?.textTracks?.length) return [];

  for (let i = 0; i < video.textTracks.length; i++) {
    const track = video.textTracks[i];
    if (!track?.cues?.length) continue;

    const segments: TranscriptSegment[] = [];
    for (let j = 0; j < track.cues.length; j++) {
      const cue = track.cues[j] as VTTCue;
      if (!cue?.text?.trim()) continue;

      segments.push({
        index: j,
        start_ms: Math.round(cue.startTime * 1000),
        duration_ms: Math.round((cue.endTime - cue.startTime) * 1000),
        text: cue.text.trim(),
      });
    }

    if (segments.length > 0) {
      console.log(`${LOG} Got ${segments.length} cues from textTrack[${i}] (${track.language || "unknown"})`);
      return segments;
    }
  }

  return [];
}

/** cue가 로드될 때까지 대기한다 (최대 10초). */
function waitForCues(maxWaitMs = 10000): Promise<TranscriptSegment[]> {
  return new Promise((resolve) => {
    const immediate = extractFromTextTracks();
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }

    const video = getVideo();
    if (!video) { resolve([]); return; }

    const startTime = Date.now();
    let resolved = false;

    const done = (segs: TranscriptSegment[]): void => {
      if (resolved) return;
      resolved = true;
      clearInterval(checkInterval);
      resolve(segs);
    };

    const checkInterval = setInterval(() => {
      const segs = extractFromTextTracks();
      if (segs.length > 0) { done(segs); return; }
      if (Date.now() - startTime > maxWaitMs) {
        console.warn(`${LOG} Timed out waiting for cues (${maxWaitMs}ms)`);
        done([]);
      }
    }, 500);

    // track 추가 이벤트 감시
    const onAddTrack = (): void => {
      for (let i = 0; i < (video.textTracks?.length ?? 0); i++) {
        const track = video.textTracks[i];
        if (!track) continue;
        const handler = (): void => {
          const segs = extractFromTextTracks();
          if (segs.length > 0) done(segs);
        };
        track.addEventListener("cuechange", handler, { once: true });
      }
    };

    video.textTracks.addEventListener("addtrack", onAddTrack, { once: true });
    onAddTrack();
  });
}

async function run(): Promise<void> {
  const videoId = new URLSearchParams(window.location.search).get("v");
  if (!videoId) return;

  console.log(`${LOG} Starting for ${videoId}`);
  enableCaptions();

  const segments = await waitForCues();
  console.log(`${LOG} Result: ${segments.length} segments for ${videoId}`);

  window.dispatchEvent(new CustomEvent("__AI_SUBTITLE__", {
    detail: { videoId, segments },
  }));
}

document.addEventListener("yt-navigate-finish", () => {
  setTimeout(() => run().catch(console.error), 1500);
});

setTimeout(() => run().catch(console.error), 2000);
