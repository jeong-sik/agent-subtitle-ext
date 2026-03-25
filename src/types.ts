/** Millisecond-precision transcript segment from YouTube JSON3 format. */
export interface TranscriptSegment {
  readonly index: number;
  readonly start_ms: number;
  readonly duration_ms: number;
  readonly text: string;
  translated?: string;
}

/** Translation response from agent. */
export interface TranslateResponse {
  readonly video_id: string;
  readonly segments: readonly {
    readonly index: number;
    readonly translated: string;
  }[];
  readonly elapsed_ms?: number;
  readonly tokens?: number;
}

/** Debug log entry for popup debug panel. */
export interface DebugEntry {
  readonly ts: number;
  readonly msg: string;
}

/** Extension internal messages between content script and background. */
export type ExtensionMessage =
  | { type: "TRANSCRIPT_READY"; videoId: string; segments: TranscriptSegment[]; currentTimeMs?: number }
  | { type: "TRANSLATE_REQUEST"; videoId: string; targetLang: string }
  | { type: "TRANSLATION_UPDATE"; videoId: string; segments: { index: number; translated: string }[] }
  | { type: "TRANSLATION_COMPLETE"; videoId: string }
  | { type: "STATUS_UPDATE"; status: ConnectionStatus }
  | { type: "GET_STATUS" }
  | { type: "DEBUG_LOG"; entry: DebugEntry }
  | { type: "GET_DEBUG_LOG" };

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "translating";

/** Extension settings stored in chrome.storage.local. */
export interface Settings {
  agentUrl: string;
  apiKey: string;
  model: string;
  targetLang: string;
  showDualSubtitles: boolean;
  fontSize: number;
  overlayPosition: "bottom" | "top";
  [key: string]: unknown; // chrome.storage compatibility
}

export const DEFAULT_SETTINGS: Settings = {
  agentUrl: "http://127.0.0.1:8085",
  apiKey: "",
  model: "auto",
  targetLang: "ko",
  showDualSubtitles: true,
  fontSize: 18,
  overlayPosition: "bottom",
};
