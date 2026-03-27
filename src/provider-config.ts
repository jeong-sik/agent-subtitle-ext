import { DEFAULT_SETTINGS } from "./types";
import type { AuthMode, ProviderId, Settings } from "./types";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  defaultUrl: string;
  authModes: AuthMode[];
  endpointKind: "openai" | "anthropic";
  modelPlaceholder: string;
  authHelpText: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  custom: {
    id: "custom",
    label: "Custom / Local",
    defaultUrl: DEFAULT_SETTINGS.agentUrl,
    authModes: ["apiKey"],
    endpointKind: "openai",
    modelPlaceholder: "auto, keeper:translator, local slug...",
    authHelpText: "OpenAI-compatible endpoint. API key is optional.",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultUrl: "https://api.openai.com",
    authModes: ["apiKey"],
    endpointKind: "openai",
    modelPlaceholder: "gpt-4o-mini, gpt-4.1-mini, ...",
    authHelpText: "Official OpenAI API is API-key authenticated. OAuth is not exposed for third-party browser API calls.",
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    defaultUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authModes: ["apiKey", "oauth"],
    endpointKind: "openai",
    modelPlaceholder: "gemini-3-flash-preview, gemini-2.5-flash, ...",
    authHelpText: "Gemini supports API key or Google OAuth. OAuth may require your own Google OAuth client and project.",
  },
  claude: {
    id: "claude",
    label: "Claude",
    defaultUrl: "https://api.anthropic.com",
    authModes: ["apiKey"],
    endpointKind: "anthropic",
    modelPlaceholder: "claude-sonnet-4-5, claude-opus-4-1, ...",
    authHelpText: "Official Claude API uses x-api-key authentication. OAuth is not exposed for direct third-party browser API calls.",
  },
};

export function getProvider(provider: ProviderId): ProviderDefinition {
  return PROVIDERS[provider];
}

export function normalizeSettings(settings: Settings): Settings {
  const provider = settings.provider in PROVIDERS
    ? settings.provider
    : DEFAULT_SETTINGS.provider;
  const def = getProvider(provider);
  const authMode = def.authModes.includes(settings.authMode)
    ? settings.authMode
    : def.authModes[0]!;

  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    provider,
    authMode,
    agentUrl: settings.agentUrl?.trim() || def.defaultUrl,
    oauthClientId: settings.oauthClientId?.trim() || "",
    googleProjectId: settings.googleProjectId?.trim() || "",
    oauthSession: settings.oauthSession ?? null,
  };
}

export function getResolvedBaseUrl(settings: Settings): string {
  const normalized = normalizeSettings(settings);
  return normalized.provider === "custom"
    ? normalized.agentUrl.replace(/\/+$/, "")
    : getProvider(normalized.provider).defaultUrl.replace(/\/+$/, "");
}

export function requiresCredential(settings: Settings): boolean {
  const normalized = normalizeSettings(settings);
  if (normalized.provider === "custom") {
    return false;
  }
  if (normalized.provider === "gemini" && normalized.authMode === "oauth") {
    return true;
  }
  return true;
}

export function hasUsableCredential(settings: Settings): boolean {
  const normalized = normalizeSettings(settings);
  if (normalized.provider === "custom") {
    return true;
  }
  if (normalized.provider === "gemini" && normalized.authMode === "oauth") {
    return Boolean(normalized.oauthSession?.accessToken);
  }
  return Boolean(normalized.apiKey.trim());
}
