import type { TranscriptSegment, TranslateResponse } from "./types";

/**
 * Direct LLM 클라이언트 (MASC 없이 직접 번역).
 *
 * MASC 서버가 없거나 연결 실패 시 fallback으로 사용.
 * OpenAI 호환 API (/v1/chat/completions) 엔드포인트에 직접 요청한다.
 *
 * 지원 백엔드:
 * - llama-server (localhost:8085) — Qwen3.5, 로컬 무료
 * - OpenAI API
 * - Anthropic API (proxy 경유)
 * - 기타 OpenAI 호환 서버
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:8085/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 60_000;

export interface DirectClientConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_CONFIG: DirectClientConfig = {
  endpoint: DEFAULT_ENDPOINT,
  model: "qwen3.5",
  temperature: 0.3,
  maxTokens: 2048,
};

export class DirectClient {
  private config: DirectClientConfig;

  constructor(config?: Partial<DirectClientConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** 백엔드 health 확인. */
  async isAvailable(): Promise<boolean> {
    try {
      const healthUrl = this.config.endpoint.replace("/v1/chat/completions", "/health");
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** 배치 번역. */
  async translateBatch(
    videoId: string,
    segments: readonly TranscriptSegment[],
    sourceLang: string,
    targetLang: string,
    contextBefore?: readonly TranscriptSegment[]
  ): Promise<TranslateResponse> {
    const prompt = this.buildPrompt(segments, sourceLang, targetLang, contextBefore);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(this.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          // Qwen3.5 thinking mode off for speed
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`LLM API ${resp.status}: ${resp.statusText}`);
      }

      const data = (await resp.json()) as {
        choices: { message: { content: string } }[];
      };

      const content = data.choices[0]?.message?.content ?? "";
      return this.parseResponse(videoId, segments, content);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildPrompt(
    segments: readonly TranscriptSegment[],
    sourceLang: string,
    targetLang: string,
    contextBefore?: readonly TranscriptSegment[]
  ): string {
    const segmentTexts = segments.map((s) => `[${s.index}] ${s.text}`).join("\n");

    const contextText = contextBefore?.length
      ? `\n\nPrevious translations for context:\n${contextBefore
          .slice(-3)
          .map((s) => `[${s.index}] ${s.text} -> ${s.translated ?? ""}`)
          .join("\n")}`
      : "";

    return `Translate the following YouTube subtitle segments from ${sourceLang} to ${targetLang}.
Preserve technical terms in their original form. Maintain natural sentence flow.
Return ONLY the translations in the format: [index] translated text
${contextText}

Segments to translate:
${segmentTexts}`;
  }

  private parseResponse(
    videoId: string,
    originalSegments: readonly TranscriptSegment[],
    content: string
  ): TranslateResponse {
    const lines = content.split("\n");
    const translated: { index: number; translated: string }[] = [];

    for (const line of lines) {
      const match = line.match(/^\[(\d+)\]\s*(.+)$/);
      if (match?.[1] && match[2]) {
        translated.push({
          index: parseInt(match[1], 10),
          translated: match[2].trim(),
        });
      }
    }

    // fallback: 라인 수 일치 시 순서 매핑
    if (translated.length === 0 && lines.length === originalSegments.length) {
      for (let i = 0; i < lines.length; i++) {
        const seg = originalSegments[i];
        const line = lines[i];
        if (seg && line?.trim()) {
          translated.push({ index: seg.index, translated: line.trim() });
        }
      }
    }

    return { video_id: videoId, segments: translated };
  }
}
