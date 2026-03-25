import type {
  JsonRpcRequest,
  JsonRpcResponse,
  TranscriptSegment,
  TranslateRequest,
  TranslateResponse,
} from "./types";

/**
 * MASC HTTP+SSE 클라이언트.
 *
 * MASC MCP의 canonical transport는 HTTP POST + SSE 응답이다.
 * 1. POST /mcp (initialize) → Session ID 획득
 * 2. POST /mcp (tools/call) → SSE stream으로 응답 수신
 *
 * Accept: application/json, text/event-stream 헤더 필수.
 */

type ConnectionState = "disconnected" | "connecting" | "connected" | "translating";

const REQUEST_TIMEOUT_MS = 120_000;
const KEEPER_NAME = "translator";
const MCP_PROTOCOL_VERSION = "2025-11-25";

export class MascClient {
  private sessionId: string | null = null;
  private state: ConnectionState = "disconnected";
  private requestId = 0;
  private baseUrl: string;

  onStatusChange?: (state: ConnectionState) => void;

  constructor(baseUrl: string) {
    // 트레일링 슬래시 제거
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** MCP 세션을 초기화한다. */
  async connect(): Promise<void> {
    if (this.sessionId) return;

    this.setState("connecting");

    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "masc-subtitle-ext",
              version: "0.1.0",
            },
          },
        }),
      });

      const sid = response.headers.get("mcp-session-id");
      if (!sid) {
        throw new Error("No Mcp-Session-Id in response");
      }

      this.sessionId = sid;
      this.setState("connected");
    } catch (e) {
      this.setState("disconnected");
      throw e;
    }
  }

  /** 연결을 종료한다. */
  disconnect(): void {
    this.sessionId = null;
    this.setState("disconnected");
  }

  /** URL을 변경한다. 재연결 필요. */
  setUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
    this.disconnect();
  }

  /** Room에 참여한다. */
  async join(): Promise<string> {
    const response = await this.callTool("masc_join", {
      agent_name: "subtitle-ext",
    });
    return this.extractText(response);
  }

  /** Translator keeper를 기동한다. */
  async ensureKeeperUp(): Promise<string> {
    const response = await this.callTool("masc_keeper_up", {
      name: KEEPER_NAME,
      goal: "Translate YouTube subtitle segments. Input: [index] text. Output: [index] translated text. Preserve technical terms in original form.",
      models: ["default"],
      instructions:
        "You are a subtitle translator. When you receive segments in the format [index] text, " +
        "translate each one and respond in the exact same format: [index] translated text. " +
        "Preserve technical terms. Translate naturally, not word-by-word. Keep translations concise.",
      proactive_enabled: false,
      presence_keepalive: false,
    });
    return this.extractText(response);
  }

  /** Keeper에게 배치 번역을 요청한다. */
  async translateBatch(
    videoId: string,
    segments: readonly TranscriptSegment[],
    sourceLang: string,
    targetLang: string,
    contextBefore?: readonly TranscriptSegment[]
  ): Promise<TranslateResponse> {
    const request: TranslateRequest = {
      action: "translate_batch",
      video_id: videoId,
      segments,
      source_lang: sourceLang,
      target_lang: targetLang,
      context_before: contextBefore,
    };

    const message = this.buildTranslationPrompt(request);
    const response = await this.callTool("masc_keeper_msg", {
      name: KEEPER_NAME,
      message,
    });

    return this.parseTranslationResponse(videoId, segments, response);
  }

  /** Keeper에게 실시간 번역을 요청한다. */
  async translateRealtime(
    videoId: string,
    segments: readonly TranscriptSegment[],
    sourceLang: string,
    targetLang: string
  ): Promise<TranslateResponse> {
    const request: TranslateRequest = {
      action: "translate_realtime",
      video_id: videoId,
      segments,
      source_lang: sourceLang,
      target_lang: targetLang,
    };

    const message = this.buildTranslationPrompt(request);
    const response = await this.callTool("masc_keeper_msg", {
      name: KEEPER_NAME,
      message,
    });

    return this.parseTranslationResponse(videoId, segments, response);
  }

  // --- Private ---

  private buildTranslationPrompt(req: TranslateRequest): string {
    const segmentTexts = req.segments
      .map((s) => `[${s.index}] ${s.text}`)
      .join("\n");

    const contextText = req.context_before?.length
      ? `\n\nPrevious translations for context:\n${req.context_before
          .slice(-3)
          .map((s) => `[${s.index}] ${s.text} -> ${s.translated ?? ""}`)
          .join("\n")}`
      : "";

    return `Translate the following YouTube subtitle segments from ${req.source_lang} to ${req.target_lang}.
Preserve technical terms in their original form. Maintain natural sentence flow.
Return ONLY the translations in the format: [index] translated text
${contextText}

Segments to translate:
${segmentTexts}`;
  }

  private parseTranslationResponse(
    videoId: string,
    originalSegments: readonly TranscriptSegment[],
    response: JsonRpcResponse
  ): TranslateResponse {
    const text = this.extractText(response);
    const lines = text.split("\n");
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

    // fallback: 라인 수가 일치하면 순서대로 매핑
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

  /**
   * MASC MCP tool을 호출한다.
   *
   * HTTP POST → SSE stream 수신 → data: 라인에서 JSON-RPC response 파싱.
   */
  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<JsonRpcResponse> {
    if (!this.sessionId) {
      await this.connect();
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Mcp-Session-Id": this.sessionId!,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`MASC HTTP ${response.status}: ${response.statusText}`);
      }

      // SSE stream을 파싱하여 JSON-RPC response를 찾는다
      return await this.parseSseResponse(response, id);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * SSE stream에서 해당 request ID의 JSON-RPC response를 추출한다.
   *
   * SSE format:
   *   retry: 3000
   *   id: N
   *   event: message
   *   data: {"jsonrpc":"2.0","id":X,"result":{...}}
   */
  private async parseSseResponse(
    response: Response,
    expectedId: number
  ): Promise<JsonRpcResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // 마지막 줄은 불완전할 수 있으므로 보존
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;

        const jsonStr = line.slice(6);
        try {
          const msg = JSON.parse(jsonStr) as JsonRpcResponse;
          if (msg.id === expectedId) {
            reader.cancel().catch(() => {});
            return msg;
          }
        } catch {
          // 파싱 불가 data 라인은 무시
        }
      }
    }

    throw new Error("SSE stream ended without response");
  }

  private extractText(response: JsonRpcResponse): string {
    if (response.error) {
      throw new Error(`MASC error: ${response.error.message}`);
    }
    const content = response.result?.content;
    if (!content?.length) return "";
    return content.map((c) => c.text).join("\n");
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.onStatusChange?.(state);
  }
}
