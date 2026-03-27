import type { TranscriptSegment } from "./types";

/**
 * IndexedDB 기반 번역 캐시.
 *
 * video_id + target_lang을 키로 번역 결과를 저장한다.
 * 같은 영상을 재방문하거나 팀원이 같은 영상을 열 때 MASC 호출을 절약한다.
 */

const DB_NAME = "masc-subtitle-cache";
const DB_VERSION = 1;
const STORE_NAME = "translations";

interface CachedTranslation {
  key: string; // `${videoId}:${targetLang}`
  videoId: string;
  targetLang: string;
  segments: TranscriptSegment[];
  createdAt: number;
  source: "local" | "board"; // 로컬 번역 vs MASC Board에서 가져온 것
}

function cacheKey(videoId: string, targetLang: string): string {
  return `${videoId}:${targetLang}`;
}

let dbInstance: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("videoId", "videoId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onclose = () => { dbInstance = null; };
      resolve(dbInstance);
    };
    request.onerror = () => reject(request.error);
  });
}

/** 캐시에서 번역을 조회한다. 번역이 실제로 채워진 경우만 반환. */
export async function getCached(
  videoId: string,
  targetLang: string
): Promise<TranscriptSegment[] | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(cacheKey(videoId, targetLang));

    request.onsuccess = () => {
      const result = request.result as CachedTranslation | undefined;
      const segs = result?.segments;
      if (!segs?.length) { resolve(null); return; }
      // Validate: at least 50% of segments must have .translated
      const translatedCount = segs.filter(s => Boolean(s.translated)).length;
      if (translatedCount < segs.length * 0.5) {
        resolve(null);
        return;
      }
      resolve(segs);
    };
    request.onerror = () => reject(request.error);
  });
}

/** 번역 결과를 캐시에 저장한다. */
export async function setCached(
  videoId: string,
  targetLang: string,
  segments: TranscriptSegment[],
  source: "local" | "board" = "local"
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const entry: CachedTranslation = {
      key: cacheKey(videoId, targetLang),
      videoId,
      targetLang,
      segments,
      createdAt: Date.now(),
      source,
    };

    const request = store.put(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** 특정 영상의 캐시를 삭제한다. */
export async function clearCached(
  videoId: string,
  targetLang: string
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(cacheKey(videoId, targetLang));

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** 모든 캐시를 삭제한다. */
export async function clearAllCache(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      const clearReq = store.clear();
      clearReq.onsuccess = () => resolve(count);
      clearReq.onerror = () => reject(clearReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
  });
}

/** 30일 이상 된 캐시를 정리한다. */
export async function pruneOldCache(maxAgeDays = 30): Promise<number> {
  const db = await openDb();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("createdAt");
    const range = IDBKeyRange.upperBound(cutoff);
    const request = index.openCursor(range);
    let deleted = 0;

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    request.onerror = () => reject(request.error);
  });
}
