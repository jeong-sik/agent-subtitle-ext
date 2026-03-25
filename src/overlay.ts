import type { TranscriptSegment, Settings, DEFAULT_SETTINGS } from "./types";

/**
 * YouTube player 위에 번역 자막을 표시하는 overlay.
 *
 * - video.currentTime을 감시하여 해당 시간의 segment를 표시
 * - 이중 자막 모드: 원문 + 번역 동시 표시
 * - YouTube 전체화면/미니플레이어에서도 동작
 */

const OVERLAY_ID = "masc-subtitle-overlay";
const CONTAINER_ID = "masc-subtitle-container";

export class SubtitleOverlay {
  private container: HTMLDivElement | null = null;
  private originalLine: HTMLDivElement | null = null;
  private translatedLine: HTMLDivElement | null = null;
  private segments: TranscriptSegment[] = [];
  private video: HTMLVideoElement | null = null;
  private animFrameId: number | null = null;
  private lastIndex = -1;
  private showDual = true;
  private fontSize = 18;

  /** overlay를 YouTube player 내부에 생성한다. */
  mount(): boolean {
    const player = document.querySelector("#movie_player");
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (!player || !video) return false;

    // 이미 마운트되어 있으면 제거 후 재생성
    this.unmount();

    this.video = video;

    this.container = document.createElement("div");
    this.container.id = CONTAINER_ID;

    this.originalLine = document.createElement("div");
    this.originalLine.className = "masc-sub-original";

    this.translatedLine = document.createElement("div");
    this.translatedLine.className = "masc-sub-translated";

    this.container.appendChild(this.originalLine);
    this.container.appendChild(this.translatedLine);
    player.appendChild(this.container);

    this.startSync();
    return true;
  }

  /** overlay를 제거한다. */
  unmount(): void {
    this.stopSync();
    const existing = document.getElementById(CONTAINER_ID);
    existing?.remove();
    this.container = null;
    this.originalLine = null;
    this.translatedLine = null;
    this.video = null;
    this.lastIndex = -1;
  }

  /** 번역된 segment 데이터를 설정한다. */
  setSegments(segments: TranscriptSegment[]): void {
    this.segments = segments;
  }

  /** 특정 segment의 번역을 업데이트한다 (streaming 수신 시). */
  updateTranslation(index: number, translated: string): void {
    const seg = this.segments[index];
    if (seg) {
      seg.translated = translated;
      // 현재 표시 중인 segment면 즉시 반영
      if (index === this.lastIndex) {
        this.renderSegment(seg);
      }
    }
  }

  /** 표시 설정을 변경한다. */
  configure(settings: Pick<Settings, "showDualSubtitles" | "fontSize" | "overlayPosition">): void {
    this.showDual = settings.showDualSubtitles;
    this.fontSize = settings.fontSize;

    if (this.container) {
      this.container.style.fontSize = `${this.fontSize}px`;
      this.container.dataset.position = settings.overlayPosition;
    }
  }

  /** requestAnimationFrame으로 video.currentTime을 감시한다. */
  private startSync(): void {
    const tick = (): void => {
      if (!this.video) return;

      const currentMs = this.video.currentTime * 1000;
      const segIndex = this.findSegmentIndex(currentMs);

      if (segIndex !== this.lastIndex) {
        this.lastIndex = segIndex;
        const seg = segIndex >= 0 ? this.segments[segIndex] : undefined;
        this.renderSegment(seg ?? null);
      }

      this.animFrameId = requestAnimationFrame(tick);
    };

    this.animFrameId = requestAnimationFrame(tick);
  }

  private stopSync(): void {
    if (this.animFrameId != null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /**
   * binary search로 currentTime에 해당하는 segment를 찾는다.
   * segments는 start_ms 기준 오름차순 정렬 전제.
   */
  private findSegmentIndex(currentMs: number): number {
    const segs = this.segments;
    let lo = 0;
    let hi = segs.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const seg = segs[mid];
      if (!seg) break;

      if (seg.start_ms <= currentMs) {
        if (currentMs < seg.start_ms + seg.duration_ms) {
          return mid;
        }
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // result가 가리키는 segment의 duration 내에 있는지 확인
    if (result >= 0) {
      const seg = segs[result];
      if (seg && currentMs < seg.start_ms + seg.duration_ms) {
        return result;
      }
    }

    return -1;
  }

  /** segment를 overlay에 렌더링한다. */
  private renderSegment(seg: TranscriptSegment | null): void {
    if (!this.originalLine || !this.translatedLine || !this.container) return;

    if (!seg) {
      this.container.classList.remove("masc-sub-visible");
      this.originalLine.textContent = "";
      this.translatedLine.textContent = "";
      return;
    }

    this.container.classList.add("masc-sub-visible");

    if (this.showDual) {
      this.originalLine.textContent = seg.text;
      this.originalLine.style.display = "block";
    } else {
      this.originalLine.textContent = "";
      this.originalLine.style.display = "none";
    }

    this.translatedLine.textContent = seg.translated ?? seg.text;
  }
}
