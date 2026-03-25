import type { TranscriptSegment, TranslateResponse } from "./types";

/**
 * OpenAI-compatible agent client.
 *
 * /v1/chat/completions 를 말하는 아무 백엔드에 번역을 요청한다.
 * llama-server, OpenAI, MASC proxy, OAS — 전부 동작.
 */

const REQUEST_TIMEOUT_MS = 120_000;

export class AgentClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey = "") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  setConfig(baseUrl: string, apiKey = ""): void {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      // /health 없는 서버도 있음 — completions 엔드포인트 자체로 판단
      return true;
    }
  }

  async translateBatch(
    videoId: string,
    segments: readonly TranscriptSegment[],
    sourceLang: string,
    targetLang: string,
    contextBefore?: readonly TranscriptSegment[]
  ): Promise<TranslateResponse> {
    const prompt = buildPrompt(segments, sourceLang, targetLang, contextBefore);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2048,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Agent ${resp.status}: ${resp.statusText}`);
      }

      const data = (await resp.json()) as {
        choices: { message: { content: string } }[];
      };

      const content = data.choices[0]?.message?.content ?? "";
      return parseResponse(videoId, segments, content);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildPrompt(
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

function parseResponse(
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
