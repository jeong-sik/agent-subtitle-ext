/** Millisecond-precision transcript segment from YouTube JSON3 format. */
export interface TranscriptSegment {
  readonly index: number;
  readonly start_ms: number;
  readonly duration_ms: number;
  readonly text: string;
  translated?: string;
}

/** Translation request sent to MASC keeper. */
export interface TranslateRequest {
  readonly action: "translate_batch" | "translate_realtime";
  readonly video_id: string;
  readonly segments: readonly TranscriptSegment[];
  readonly source_lang: string;
  readonly target_lang: string;
  /** Optional context: preceding translated segments for coherence. */
  readonly context_before?: readonly TranscriptSegment[];
}

/** Translation response from MASC keeper. */
export interface TranslateResponse {
  readonly video_id: string;
  readonly segments: readonly {
    readonly index: number;
    readonly translated: string;
  }[];
}

/** MASC JSON-RPC 2.0 request. */
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
}

/** MASC JSON-RPC 2.0 response. */
export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: {
    readonly content: readonly { readonly type: string; readonly text: string }[];
  };
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

/** Extension internal messages between content script and background. */
export type ExtensionMessage =
  | { type: "TRANSCRIPT_READY"; videoId: string; segments: TranscriptSegment[] }
  | { type: "TRANSLATE_REQUEST"; videoId: string; targetLang: string }
  | { type: "TRANSLATION_UPDATE"; videoId: string; segments: { index: number; translated: string }[] }
  | { type: "TRANSLATION_COMPLETE"; videoId: string }
  | { type: "STATUS_UPDATE"; status: ConnectionStatus }
  | { type: "GET_STATUS" };

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "translating";

/** Extension settings stored in chrome.storage.local. */
export interface Settings {
  mascUrl: string;
  targetLang: string;
  showDualSubtitles: boolean;
  fontSize: number;
  overlayPosition: "bottom" | "top";
  [key: string]: unknown; // chrome.storage compatibility
}

export const DEFAULT_SETTINGS: Settings = {
  mascUrl: "http://127.0.0.1:8935",
  targetLang: "ko",
  showDualSubtitles: true,
  fontSize: 18,
  overlayPosition: "bottom",
};
