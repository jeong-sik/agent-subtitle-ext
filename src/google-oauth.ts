import type { OAuthSession } from "./types";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const EXPIRY_SKEW_MS = 60_000;
const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/generative-language.retriever",
];
let inFlightSessionRefresh: Promise<OAuthSession> | null = null;

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function getRedirectUri(): string {
  return chrome.identity.getRedirectURL("gemini-oauth");
}

function isExpiringSoon(session: OAuthSession | null | undefined): boolean {
  if (!session?.accessToken || !session.expiresAt) return true;
  return session.expiresAt <= Date.now() + EXPIRY_SKEW_MS;
}

function getErrorMessage(payload: Record<string, string | undefined>): string {
  return payload.error_description || payload.error || "OAuth flow failed";
}

function randomBase64Url(bytes = 32): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  let binary = "";
  for (const chunk of raw) binary += String.fromCharCode(chunk);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseRedirect(url: string): URL {
  const parsed = new URL(url);
  const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  if (fragment) {
    const fragmentParams = new URLSearchParams(fragment);
    for (const [key, value] of fragmentParams.entries()) {
      parsed.searchParams.set(key, value);
    }
  }
  return parsed;
}

async function launchWebAuthFlow(url: string, interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (responseUrl) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!responseUrl) {
        reject(new Error("OAuth redirect URL was empty"));
        return;
      }
      resolve(responseUrl);
    });
  });
}

async function postTokenForm(body: URLSearchParams): Promise<GoogleTokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as GoogleTokenResponse;
  if (!response.ok || payload.error) {
    throw new Error(getErrorMessage(payload as Record<string, string | undefined>));
  }
  return payload;
}

function buildSession(payload: GoogleTokenResponse): OAuthSession {
  const accessToken = payload.access_token;
  if (!accessToken) {
    throw new Error("OAuth access token was missing");
  }

  return {
    accessToken,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    scope: payload.scope,
  };
}

function buildGoogleAuthUrl(params: Record<string, string>): string {
  return `${GOOGLE_AUTH_URL}?${new URLSearchParams(params).toString()}`;
}

async function runPkceFlow(clientId: string, interactive: boolean): Promise<OAuthSession> {
  const state = randomBase64Url(24);
  const verifier = randomBase64Url(32);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = getRedirectUri();
  const url = buildGoogleAuthUrl({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GEMINI_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    include_granted_scopes: "true",
    prompt: interactive ? "consent select_account" : "none",
  });

  const redirect = parseRedirect(await launchWebAuthFlow(url, interactive));
  const error = redirect.searchParams.get("error");
  if (error) {
    throw new Error(getErrorMessage({
      error,
      error_description: redirect.searchParams.get("error_description") ?? undefined,
    }));
  }

  const returnedState = redirect.searchParams.get("state");
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("OAuth authorization code was missing");
  if (returnedState !== state) throw new Error("OAuth state mismatch");

  const payload = await postTokenForm(new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }));

  return buildSession(payload);
}

export async function connectGeminiOAuth(clientId: string): Promise<OAuthSession> {
  const trimmedClientId = clientId.trim();
  if (!trimmedClientId) {
    throw new Error("Google OAuth client ID is required");
  }

  return runPkceFlow(trimmedClientId, true);
}

export async function ensureGeminiOAuthSession(
  clientId: string,
  session: OAuthSession | null,
): Promise<OAuthSession> {
  const trimmedClientId = clientId.trim();
  if (!trimmedClientId) {
    throw new Error("Google OAuth client ID is required");
  }

  if (!isExpiringSoon(session)) {
    return session!;
  }

  if (inFlightSessionRefresh) {
    return inFlightSessionRefresh;
  }

  inFlightSessionRefresh = (async () => {
    return runPkceFlow(trimmedClientId, false);
  })();

  try {
    return await inFlightSessionRefresh;
  } finally {
    inFlightSessionRefresh = null;
  }
}

export async function revokeGeminiOAuthSession(session: OAuthSession | null): Promise<void> {
  const token = session?.accessToken;
  if (!token) return;

  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Best-effort revoke only.
  }
}
