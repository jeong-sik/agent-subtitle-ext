import { getProvider, getResolvedBaseUrl, normalizeSettings } from "./provider-config";
import type { Settings, TranscriptSegment, TranslateResponse } from "./types";

/**
 * Provider-aware translation client.
 *
 * OpenAI-compatible endpoints (custom/OpenAI/Gemini) and Anthropic Messages API
 * are supported.
 *
 * SSE stream으로 토큰 단위 수신, 줄 완성 시 즉시 콜백.
 * 서버가 streaming을 무시하면 JSON fallback으로 자동 전환.
 */

const REQUEST_TIMEOUT_MS = 300_000;
const SEGMENT_LINE_RE = /^\[(\d+)\]\s*(.+)$/;

export type OnSegmentTranslated = (index: number, translated: string) => void;

function tryParseSegmentLine(line: string): { index: number; translated: string } | null {
  const match = line.match(SEGMENT_LINE_RE);
  if (!match?.[1] || !match[2]) return null;
  return { index: parseInt(match[1], 10), translated: match[2].trim() };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export class AgentClient {
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = normalizeSettings(settings);
  }

  setConfig(settings: Settings): void {
    this.settings = normalizeSettings(settings);
  }

  async isAvailable(): Promise<boolean> {
    const baseUrl = getResolvedBaseUrl(this.settings);
    try {
      const resp = await fetch(`${baseUrl}/health`, {
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
    const provider = getProvider(this.settings.provider);
    if (provider.endpointKind === "anthropic") {
      return this.translateAnthropic(videoId, segments, sourceLang, targetLang, contextBefore, onSegment);
    }

    const prompt = buildPrompt(segments, sourceLang, targetLang, contextBefore);
    const headers = this.buildOpenAIHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const t0 = Date.now();
    const baseUrl = getResolvedBaseUrl(this.settings);

    try {
      const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.settings.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 2048,
          temperature: 0.3,
          stream: true,
          // Disable thinking/reasoning for local models (Qwen3.5 etc.)
          chat_template_kwargs: { enable_thinking: false },
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

  private buildOpenAIHeaders(): Record<string, string> {
    this.assertSecureCustomEndpoint();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.settings.provider === "gemini" && this.settings.authMode === "oauth") {
      const accessToken = this.settings.oauthSession?.accessToken;
      if (!accessToken) {
        throw new Error("Gemini OAuth session is missing. Reconnect in the popup.");
      }
      headers["Authorization"] = `Bearer ${accessToken}`;
      if (this.settings.googleProjectId) {
        headers["x-goog-user-project"] = this.settings.googleProjectId;
      }
      return headers;
    }

    if (this.settings.apiKey) headers["Authorization"] = `Bearer ${this.settings.apiKey}`;
    return headers;
  }

  private buildAnthropicHeaders(): Record<string, string> {
    const apiKey = this.settings.apiKey.trim();
    if (!apiKey) {
      throw new Error("Claude requires an API key.");
    }

    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  private assertSecureCustomEndpoint(): void {
    if (this.settings.provider !== "custom" || !this.settings.apiKey.trim()) {
      return;
    }

    const url = new URL(getResolvedBaseUrl(this.settings));
    if (url.protocol === "https:" || isLoopbackHost(url.hostname)) {
      return;
    }

    throw new Error("Custom endpoints with credentials must use HTTPS or loopback HTTP.");
  }

  private async translateAnthropic(
    videoId: string,
    segments: readonly TranscriptSegment[],
    sourceLang: string,
    targetLang: string,
    contextBefore: readonly TranscriptSegment[] | undefined,
    onSegment: OnSegmentTranslated,
  ): Promise<TranslateResponse> {
    const prompt = buildPrompt(segments, sourceLang, targetLang, contextBefore);
    const headers = this.buildAnthropicHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const t0 = Date.now();
    const baseUrl = getResolvedBaseUrl(this.settings);

    try {
      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.settings.model,
          max_tokens: 2048,
          temperature: 0.3,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`Agent ${resp.status}: ${resp.statusText}`);
      }

      const data = (await resp.json()) as {
        content?: { type?: string; text?: string }[];
        usage?: { output_tokens?: number };
      };

      const content = data.content
        ?.filter((item) => item.type === "text" && item.text)
        .map((item) => item.text ?? "")
        .join("\n") ?? "";

      const result = parseResponse(videoId, segments, content);
      for (const seg of result.segments) onSegment(seg.index, seg.translated);

      return {
        ...result,
        elapsed_ms: Date.now() - t0,
        tokens: data.usage?.output_tokens ?? 0,
      };
    } finally {
      clearTimeout(timeout);
    }
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
