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

export type ProviderId = "custom" | "openai" | "gemini" | "claude";
export type AuthMode = "apiKey" | "oauth";

export interface OAuthSession {
  accessToken: string;
  expiresAt: number;
  scope?: string;
}

/** Real-time translation progress for side panel. */
export interface TranslationProgress {
  readonly videoId: string;
  readonly totalSegments: number;
  readonly translatedSegments: number;
  readonly completedBatches: number;
  readonly totalBatches: number;
  readonly totalTokens: number;
  readonly wallStartMs: number;
  readonly currentTokPerSec: number;
  readonly isComplete: boolean;
}

/** Extension internal messages between content script, background, popup, and side panel. */
export type ExtensionMessage =
  | { type: "TRANSCRIPT_READY"; videoId: string; segments: TranscriptSegment[]; currentTimeMs?: number }
  | { type: "TRANSLATE_REQUEST"; videoId: string; targetLang: string }
  | { type: "TRANSLATION_UPDATE"; videoId: string; segments: { index: number; translated: string }[] }
  | { type: "TRANSLATION_COMPLETE"; videoId: string }
  | { type: "STATUS_UPDATE"; status: ConnectionStatus }
  | { type: "GET_STATUS" }
  | { type: "DEBUG_LOG"; entry: DebugEntry }
  | { type: "GET_DEBUG_LOG" }
  | { type: "DEBUG_LOG_PUSH"; entry: DebugEntry }
  | { type: "PROGRESS_UPDATE"; videoId: string; progress: TranslationProgress }
  | { type: "GET_PROGRESS" }
  | { type: "OPEN_SIDE_PANEL" }
  | { type: "CLEAR_CACHE" };

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "translating";

/** Extension settings stored in chrome.storage.local. */
export interface Settings {
  provider: ProviderId;
  authMode: AuthMode;
  agentUrl: string;
  apiKey: string;
  model: string;
  targetLang: string;
  showDualSubtitles: boolean;
  fontSize: number;
  overlayPosition: "bottom" | "top";
  oauthClientId: string;
  googleProjectId: string;
  oauthSession: OAuthSession | null;
  [key: string]: unknown; // chrome.storage compatibility
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "custom",
  authMode: "apiKey",
  agentUrl: "http://127.0.0.1:8085",
  apiKey: "",
  model: "auto",
  targetLang: "ko",
  showDualSubtitles: true,
  fontSize: 18,
  overlayPosition: "bottom",
  oauthClientId: "",
  googleProjectId: "",
  oauthSession: null,
};
