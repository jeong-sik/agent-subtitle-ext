import type { TranscriptSegment } from "./types";

/**
 * YouTube player 위 번역 진행률 시각화.
 *
 * Canvas 타임라인: 번역 완료 구간 = green, 미번역 = transparent.
 * 현재 재생 위치 marker (흰색 수직선).
 * 상태 라벨: "42/120 (ko)" + playable dot.
 * 재생 가능 판정: current + 30초 분량이 모두 번역됐으면 green.
 */

const CONTAINER_ID = "masc-progress-container";
const PLAYABLE_HORIZON_MS = 30_000;

export class ProgressBar {
  private container: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private label: HTMLSpanElement | null = null;
  private dot: HTMLSpanElement | null = null;
  private segments: TranscriptSegment[] = [];
  private totalDurationMs = 0;
  private targetLang = "ko";
  private video: HTMLVideoElement | null = null;
  private rafPending = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private resizeObs: ResizeObserver | null = null;

  mount(): boolean {
    const player = document.querySelector("#movie_player");
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (!player || !video) return false;

    this.unmount();
    this.video = video;

    this.container = document.createElement("div");
    this.container.id = CONTAINER_ID;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "masc-progress-canvas";
    this.canvas.height = 3;

    const info = document.createElement("div");
    info.className = "masc-progress-info";

    this.dot = document.createElement("span");
    this.dot.className = "masc-progress-dot";

    this.label = document.createElement("span");
    this.label.className = "masc-progress-text";

    info.appendChild(this.dot);
    info.appendChild(this.label);
    this.container.appendChild(this.canvas);
    this.container.appendChild(info);
    player.appendChild(this.container);

    this.resizeObs = new ResizeObserver(() => this.scheduleRender());
    this.resizeObs.observe(this.container);

    // 1초마다 재생 위치 + playable 상태 갱신
    this.tickTimer = setInterval(() => this.scheduleRender(), 1000);

    return true;
  }

  unmount(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    document.getElementById(CONTAINER_ID)?.remove();
    this.container = null;
    this.canvas = null;
    this.label = null;
    this.dot = null;
    this.video = null;
  }

  setSegments(segs: TranscriptSegment[]): void {
    this.segments = segs;
    if (segs.length > 0) {
      const last = segs[segs.length - 1]!;
      this.totalDurationMs = last.start_ms + last.duration_ms;
    }
    this.scheduleRender();
  }

  setTargetLang(lang: string): void {
    this.targetLang = lang;
    this.scheduleRender();
  }

  /** TRANSLATION_UPDATE 수신 시 호출. */
  onTranslationUpdate(): void {
    this.scheduleRender();
  }

  /** 번역 완료 시 호출 — 자동 fade out. */
  onComplete(): void {
    this.scheduleRender();
    if (this.container) this.container.dataset.complete = "true";
  }

  private scheduleRender(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.render();
    });
  }

  private render(): void {
    if (!this.canvas || !this.container || !this.label || !this.dot) return;

    const canvasWidth = this.canvas.clientWidth;
    if (canvasWidth <= 0 || this.totalDurationMs === 0) return;

    this.canvas.width = canvasWidth;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvasWidth, 3);

    // Track background
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fillRect(0, 0, canvasWidth, 3);

    // 번역 완료 구간
    let translatedCount = 0;
    for (const seg of this.segments) {
      if (!seg.translated) continue;
      translatedCount++;
      const x = (seg.start_ms / this.totalDurationMs) * canvasWidth;
      const w = Math.max(1, (seg.duration_ms / this.totalDurationMs) * canvasWidth);
      ctx.fillStyle = "#4ade80";
      ctx.fillRect(x, 0, w, 3);
    }

    // 현재 재생 위치 marker
    const currentMs = (this.video?.currentTime ?? 0) * 1000;
    if (currentMs > 0) {
      const px = (currentMs / this.totalDurationMs) * canvasWidth;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(Math.round(px), 0, 1.5, 3);
    }

    // 라벨
    const total = this.segments.length;
    this.label.textContent = total > 0
      ? `${translatedCount}/${total} (${this.targetLang})`
      : "";

    // Playable dot 색상
    const playable = this.isPlayable(currentMs);
    if (translatedCount === total && total > 0) {
      this.dot.className = "masc-progress-dot done";
    } else if (playable) {
      this.dot.className = "masc-progress-dot playable";
    } else if (translatedCount > 0) {
      this.dot.className = "masc-progress-dot translating";
    } else {
      this.dot.className = "masc-progress-dot";
    }

    if (total > 0) {
      this.container.classList.add("masc-progress-visible");
    }
  }

  /** current ~ current+30s 구간이 모두 번역되었는지 판정. */
  private isPlayable(currentMs: number): boolean {
    const horizon = currentMs + PLAYABLE_HORIZON_MS;
    for (const seg of this.segments) {
      if (seg.start_ms >= horizon) break;
      if (seg.start_ms + seg.duration_ms <= currentMs) continue;
      if (!seg.translated) return false;
    }
    return this.segments.length > 0;
  }
}
