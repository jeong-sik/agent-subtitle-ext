import type { TranscriptSegment, TranslateResponse } from "./types";

/**
 * OpenAI-compatible agent client.
 *
 * /v1/chat/completions 를 말하는 아무 백엔드에 번역을 요청한다.
 * llama-server, OpenAI, MASC proxy, OAS — 전부 동작.
 *
 * SSE stream으로 토큰 단위 수신, 줄 완성 시 즉시 콜백.
 * 서버가 streaming을 무시하면 JSON fallback으로 자동 전환.
 */

const REQUEST_TIMEOUT_MS = 120_000;
const SEGMENT_LINE_RE = /^\[(\d+)\]\s*(.+)$/;

export type OnSegmentTranslated = (index: number, translated: string) => void;

function tryParseSegmentLine(line: string): { index: number; translated: string } | null {
  const match = line.match(SEGMENT_LINE_RE);
  if (!match?.[1] || !match[2]) return null;
  return { index: parseInt(match[1], 10), translated: match[2].trim() };
}

export class AgentClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(baseUrl: string, apiKey = "", model = "auto") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
  }

  setConfig(baseUrl: string, apiKey = "", model = "auto"): void {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return true;
    }
  }

  /**
   * SSE streaming batch translation.
   *
   * `stream: true`로 요청. 서버가 JSON으로 응답하면 자동 fallback.
   * `[index] translated text` 줄이 완성될 때마다 onSegment 콜백 호출.
   */
  async translateBatchStream(
    videoId: string,
    segments: readonly TranscriptSegment[],
    sourceLang: string,
    targetLang: string,
    contextBefore: readonly TranscriptSegment[] | undefined,
    onSegment: OnSegmentTranslated
  ): Promise<TranslateResponse> {
    const prompt = buildPrompt(segments, sourceLang, targetLang, contextBefore);
    const headers = this.buildHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const t0 = Date.now();

    try {
      const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2048,
          temperature: 0.3,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Agent ${resp.status}: ${resp.statusText}`);
      }

      // 서버가 streaming을 무시하고 JSON으로 응답하는 경우 fallback
      const contentType = resp.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const data = (await resp.json()) as {
          choices: { message: { content: string } }[];
          usage?: { completion_tokens?: number; total_tokens?: number };
        };
        const content = data.choices[0]?.message?.content ?? "";
        const result = parseResponse(videoId, segments, content);
        for (const seg of result.segments) onSegment(seg.index, seg.translated);
        return {
          ...result,
          elapsed_ms: Date.now() - t0,
          tokens: data.usage?.completion_tokens ?? 0,
        };
      }

      // SSE stream — segments are collected during streaming via onSegment
      const { segments: streamed, tokens } = await readSSEStream(resp, onSegment);
      const elapsed_ms = Date.now() - t0;
      return { video_id: videoId, segments: streamed, elapsed_ms, tokens };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }
}

// --- SSE stream reader ---

interface SSEResult {
  segments: readonly { index: number; translated: string }[];
  tokens: number;
}

/**
 * OpenAI SSE 스트림을 읽어서 토큰을 누적한다.
 * `[index] translated text\n` 패턴이 완성될 때마다 onSegment 콜백 호출.
 * segments를 직접 수집하여 반환 (double-parse 방지).
 */
async function readSSEStream(
  resp: Response,
  onSegment: OnSegmentTranslated
): Promise<SSEResult> {
  const reader = resp.body?.getReader();
  if (!reader) {
    return { segments: [], tokens: 0 };
  }

  const decoder = new TextDecoder();
  let sseBuffer = "";
  let lineBuffer = "";
  let tokens = 0;
  const segments: { index: number; translated: string }[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });

    const events = sseBuffer.split("\n\n");
    sseBuffer = events.pop() ?? "";

    for (const event of events) {
      for (const rawLine of event.split("\n")) {
        if (!rawLine.startsWith("data: ")) continue;
        const payload = rawLine.slice(6);
        if (payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
            usage?: { completion_tokens?: number };
          };

          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta == null) continue;

          lineBuffer += delta;

          while (lineBuffer.includes("\n")) {
            const nlIdx = lineBuffer.indexOf("\n");
            const completedLine = lineBuffer.slice(0, nlIdx);
            lineBuffer = lineBuffer.slice(nlIdx + 1);

            const parsed = tryParseSegmentLine(completedLine);
            if (parsed) {
              segments.push(parsed);
              onSegment(parsed.index, parsed.translated);
            }
          }

          if (chunk.usage?.completion_tokens) {
            tokens = chunk.usage.completion_tokens;
          }
        } catch {
          // incomplete JSON frame
        }
      }
    }
  }

  // 마지막 남은 줄
  if (lineBuffer.trim()) {
    const parsed = tryParseSegmentLine(lineBuffer);
    if (parsed) {
      segments.push(parsed);
      onSegment(parsed.index, parsed.translated);
    }
  }

  return { segments, tokens };
}

// --- Prompt & Response parsing ---

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
    const parsed = tryParseSegmentLine(line);
    if (parsed) translated.push(parsed);
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
