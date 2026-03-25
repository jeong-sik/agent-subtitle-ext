import type { TranscriptSegment } from "./types";

/**
 * YouTube ASR segments를 문장 단위로 병합.
 *
 * YouTube는 임의 지점에서 자막을 끊는다:
 *   [0] hi everyone so recently I gave a
 *   [1] 30-minute talk on large language models
 *
 * 문장 경계(. ? ! 또는 긴 pause)에서 병합하면:
 *   [0] hi everyone so recently I gave a 30-minute talk on large language models.
 *
 * 효과: 번역 품질 향상 + batch 수 감소 + 자연스러운 자막 표시.
 */

const SENTENCE_ENDERS = /[.!?]$/;
const PAUSE_THRESHOLD_MS = 1500; // 1.5초 이상 간격이면 문장 경계로 판단

export function mergeIntoSentences(
  raw: TranscriptSegment[]
): TranscriptSegment[] {
  if (raw.length === 0) return [];

  const merged: TranscriptSegment[] = [];
  let buffer: TranscriptSegment[] = [];

  function flush(): void {
    if (buffer.length === 0) return;

    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    const text = buffer.map((s) => s.text).join(" ");
    const endMs = last.start_ms + last.duration_ms;

    merged.push({
      index: merged.length,
      start_ms: first.start_ms,
      duration_ms: endMs - first.start_ms,
      text,
    });

    buffer = [];
  }

  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i]!;
    buffer.push(seg);

    const isSentenceEnd = SENTENCE_ENDERS.test(seg.text);

    // 다음 segment와의 간격 확인
    const next = raw[i + 1];
    const gap = next ? next.start_ms - (seg.start_ms + seg.duration_ms) : Infinity;
    const isPause = gap > PAUSE_THRESHOLD_MS;

    // 너무 길어지면 강제 flush (5 segments 이상)
    const isTooLong = buffer.length >= 5;

    if (isSentenceEnd || isPause || isTooLong) {
      flush();
    }
  }

  flush(); // 남은 버퍼
  return merged;
}

/**
 * 번역용 전략적 청킹.
 *
 * 단순 BATCH_SIZE 슬라이싱 대신, 문장 경계를 존중하는 청크로 분할.
 * 각 청크에 앞뒤 context를 포함하여 맥락 유지.
 */
export interface TranslationChunk {
  /** 번역할 segments (핵심) */
  segments: TranscriptSegment[];
  /** 맥락용 이전 segments (번역하지 않음, context로만 제공) */
  contextBefore: TranscriptSegment[];
}

export function chunkForTranslation(
  sentences: TranscriptSegment[],
  targetChunkSize: number,
  contextSize: number
): TranslationChunk[] {
  const chunks: TranslationChunk[] = [];

  for (let i = 0; i < sentences.length; i += targetChunkSize) {
    const end = Math.min(i + targetChunkSize, sentences.length);
    const contextStart = Math.max(0, i - contextSize);

    chunks.push({
      segments: sentences.slice(i, end),
      contextBefore: i > 0 ? sentences.slice(contextStart, i) : [],
    });
  }

  return chunks;
}
