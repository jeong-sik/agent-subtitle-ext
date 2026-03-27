import { normalizeSettings } from "./provider-config";
import { DEFAULT_SETTINGS } from "./types";
import type { OAuthSession, Settings } from "./types";

const OAUTH_SESSION_KEY = "oauthSession";

export async function loadStoredSettings(): Promise<Settings> {
  const local = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, resolve);
  });
  const session = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.session.get({ [OAUTH_SESSION_KEY]: null }, resolve);
  });

  return normalizeSettings({
    ...(local as Settings),
    oauthSession: (session[OAUTH_SESSION_KEY] as OAuthSession | null | undefined) ?? null,
  });
}

export async function saveStoredSettings(settings: Settings): Promise<void> {
  const { oauthSession: _ignored, ...persistent } = settings;
  await new Promise<void>((resolve) => {
    chrome.storage.local.set(persistent, () => resolve());
  });
}

export async function saveOAuthSession(session: OAuthSession | null): Promise<void> {
  if (session) {
    await new Promise<void>((resolve) => {
      chrome.storage.session.set({ [OAUTH_SESSION_KEY]: session }, () => resolve());
    });
    return;
  }

  await new Promise<void>((resolve) => {
    chrome.storage.session.remove(OAUTH_SESSION_KEY, () => resolve());
  });
}
