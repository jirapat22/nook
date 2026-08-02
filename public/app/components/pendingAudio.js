// Holds a recording that hasn't been transcribed yet.
//
// The audio blob used to live only in memory, so a failed transcription was
// unrecoverable the moment the page reloaded — and a failure is exactly when
// you're most likely to reload (that's how an auth-error recording was lost).
// IndexedDB is used rather than localStorage because a Blob can be stored
// directly, with no base64 round-trip.
//
// One slot only: the recorder handles a single take at a time, so a newer
// recording replaces an older one instead of silently piling up.

const DB_NAME = 'nook-pending-audio';
const STORE = 'audio';
const KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function run(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => { resolve(req.result); db.close(); };
    req.onerror = () => { reject(req.error); db.close(); };
  }));
}

// Every call is best-effort: persistence is a safety net and must never be
// the reason a recording flow breaks.
export async function savePendingAudio(blob, meta = {}) {
  if (!blob || !blob.size) return false;
  try {
    await run('readwrite', s => s.put({ blob, savedAt: Date.now(), ...meta }, KEY));
    return true;
  } catch { return false; }
}

export async function loadPendingAudio() {
  try {
    const rec = await run('readonly', s => s.get(KEY));
    if (!rec?.blob?.size) return null;
    return rec;
  } catch { return null; }
}

export async function clearPendingAudio() {
  try { await run('readwrite', s => s.delete(KEY)); } catch { /* nothing to clean up */ }
}
