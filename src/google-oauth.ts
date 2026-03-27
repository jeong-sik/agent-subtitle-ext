import type { OAuthSession } from "./types";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const EXPIRY_SKEW_MS = 60_000;
const GEMINI_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever",
];
let inFlightSessionRefresh: Promise<OAuthSession> | null = null;

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  email?: string;
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

async function populateEmail(session: OAuthSession): Promise<OAuthSession> {
  try {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    if (!response.ok) return session;
    const payload = (await response.json()) as GoogleUserInfo;
    if (!payload.email) return session;
    return { ...session, email: payload.email };
  } catch {
    return session;
  }
}

function buildSession(payload: GoogleTokenResponse, fallback?: OAuthSession | null): OAuthSession {
  const accessToken = payload.access_token;
  if (!accessToken) {
    throw new Error("OAuth access token was missing");
  }

  return {
    accessToken,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    refreshToken: payload.refresh_token || fallback?.refreshToken,
    email: fallback?.email,
    scope: payload.scope || fallback?.scope,
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
    access_type: "offline",
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

  return populateEmail(buildSession(payload));
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
    if (session?.refreshToken) {
      try {
        const payload = await postTokenForm(new URLSearchParams({
          client_id: trimmedClientId,
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        }));
        return populateEmail(buildSession(payload, session));
      } catch {
        // Fall back to a silent browser refresh when refresh_token flow is unavailable.
      }
    }

    return runPkceFlow(trimmedClientId, false);
  })();

  try {
    return await inFlightSessionRefresh;
  } finally {
    inFlightSessionRefresh = null;
  }
}

export async function revokeGeminiOAuthSession(session: OAuthSession | null): Promise<void> {
  const token = session?.refreshToken || session?.accessToken;
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
