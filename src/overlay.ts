import type { TranscriptSegment, Settings } from "./types";

/**
 * YouTube player 위에 번역 자막을 표시하는 overlay.
 *
 * - video.currentTime을 감시하여 해당 시간의 segment를 표시
 * - 이중 자막 모드: 원문 + 번역 동시 표시
 * - YouTube 전체화면/미니플레이어에서도 동작
 * - Auto-pause: 미번역 구간에서 자동 일시정지, 번역 도착 시 자동 재생
 */

const CONTAINER_ID = "masc-subtitle-container";

export class SubtitleOverlay {
  private container: HTMLDivElement | null = null;
  private originalLine: HTMLDivElement | null = null;
  private translatedLine: HTMLDivElement | null = null;
  private bufferingLine: HTMLDivElement | null = null;
  private segments: TranscriptSegment[] = [];
  private video: HTMLVideoElement | null = null;
  private animFrameId: number | null = null;
  private lastIndex = -1;
  private showDual = true;
  private fontSize = 18;
  private autoPaused = false;
  private translationActive = false;

  mount(): boolean {
    const player = document.querySelector("#movie_player");
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (!player || !video) return false;

    this.unmount();
    this.video = video;

    this.container = document.createElement("div");
    this.container.id = CONTAINER_ID;

    this.originalLine = document.createElement("div");
    this.originalLine.className = "masc-sub-original";

    this.translatedLine = document.createElement("div");
    this.translatedLine.className = "masc-sub-translated";

    this.bufferingLine = document.createElement("div");
    this.bufferingLine.className = "masc-sub-buffering";
    this.bufferingLine.textContent = "";

    this.container.appendChild(this.originalLine);
    this.container.appendChild(this.translatedLine);
    this.container.appendChild(this.bufferingLine);
    player.appendChild(this.container);

    this.startSync();
    return true;
  }

  unmount(): void {
    this.resumeIfAutoPaused();
    this.stopSync();
    const existing = document.getElementById(CONTAINER_ID);
    existing?.remove();
    this.container = null;
    this.originalLine = null;
    this.translatedLine = null;
    this.bufferingLine = null;
    this.video = null;
    this.lastIndex = -1;
    this.autoPaused = false;
  }

  setSegments(segments: TranscriptSegment[]): void {
    this.segments = segments;
  }

  /** 번역 진행 중 여부 설정. auto-pause는 번역 활성 시에만 동작. */
  setTranslationActive(active: boolean): void {
    this.translationActive = active;
    if (!active) this.resumeIfAutoPaused();
  }

  updateTranslation(index: number, translated: string): void {
    const seg = this.segments[index];
    if (seg) {
      seg.translated = translated;
      if (index === this.lastIndex) {
        this.renderSegment(seg);
        // 현재 segment가 번역됐으면 auto-resume
        this.resumeIfAutoPaused();
      }
    }
  }

  configure(settings: Pick<Settings, "showDualSubtitles" | "fontSize" | "overlayPosition">): void {
    this.showDual = settings.showDualSubtitles;
    this.fontSize = settings.fontSize;

    if (this.container) {
      this.container.style.fontSize = `${this.fontSize}px`;
      this.container.dataset.position = settings.overlayPosition;
    }
  }

  private startSync(): void {
    const tick = (): void => {
      if (!this.video) return;

      const currentMs = this.video.currentTime * 1000;
      const segIndex = this.findSegmentIndex(currentMs);

      if (segIndex !== this.lastIndex) {
        this.lastIndex = segIndex;
        const seg = segIndex >= 0 ? this.segments[segIndex] : undefined;
        this.renderSegment(seg ?? null);

        // Auto-pause: 미번역 segment 진입 시
        if (seg && !seg.translated && this.translationActive) {
          this.autoPause();
        } else if (seg?.translated && this.autoPaused) {
          this.resumeIfAutoPaused();
        }
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

  private autoPause(): void {
    if (!this.video || this.video.paused || this.autoPaused) return;
    this.video.pause();
    this.autoPaused = true;
    if (this.bufferingLine) {
      this.bufferingLine.textContent = "Translating...";
      this.bufferingLine.style.display = "block";
    }
  }

  private resumeIfAutoPaused(): void {
    if (!this.autoPaused || !this.video) return;
    this.autoPaused = false;
    this.video.play().catch(() => {});
    if (this.bufferingLine) {
      this.bufferingLine.textContent = "";
      this.bufferingLine.style.display = "none";
    }
  }

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

    if (result >= 0) {
      const seg = segs[result];
      if (seg && currentMs < seg.start_ms + seg.duration_ms) {
        return result;
      }
    }

    return -1;
  }

  private renderSegment(seg: TranscriptSegment | null): void {
    if (!this.originalLine || !this.translatedLine || !this.container) return;

    if (!seg) {
      this.container.classList.remove("masc-sub-visible");
      this.originalLine.textContent = "";
      this.translatedLine.textContent = "";
      return;
    }

    this.container.classList.add("masc-sub-visible");

    const isTranslated = Boolean(seg.translated);

    if (this.showDual && isTranslated) {
      this.originalLine.textContent = seg.text;
      this.originalLine.style.display = "block";
    } else {
      this.originalLine.textContent = "";
      this.originalLine.style.display = "none";
    }

    this.translatedLine.textContent = isTranslated ? seg.translated! : seg.text;
    this.translatedLine.classList.toggle("masc-sub-untranslated", !isTranslated);
  }
}
