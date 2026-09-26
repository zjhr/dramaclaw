import { api } from "@/lib/api";

const DB_NAME = "dramaclaw";
const STORE = "directorDeskChatArchive";

export type DirectorDeskChatArchive = {
  nodeId: string;
  projectId: string | null;
  keys: Record<string, string>;
  archivedAt: number;
};

const memory = new Map<string, DirectorDeskChatArchive>();
const restoreTimers = new Map<string, number[]>();

function matchingKeys(nodeId: string): string[] {
  if (typeof localStorage === "undefined") return [];
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.includes("director-desk") || !key.includes(nodeId)) continue;
    keys.push(key);
  }
  return keys;
}

function projectIdFromKeys(keys: Record<string, string>, nodeId: string): string | null {
  const marker = `supertale:director-desk:`;
  for (const key of Object.keys(keys)) {
    const start = key.indexOf(marker);
    if (start < 0) continue;
    const rest = key.slice(start + marker.length);
    const splitAt = rest.lastIndexOf(`/${nodeId}`);
    if (splitAt <= 0) continue;
    return rest.slice(0, splitAt);
  }
  return null;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function idbPut(archive: DirectorDeskChatArchive): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(archive, archive.nodeId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

async function idbGet(nodeId: string): Promise<DirectorDeskChatArchive | null> {
  const db = await openDb();
  if (!db) return null;
  const record = await new Promise<DirectorDeskChatArchive | null>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(nodeId);
    request.onsuccess = () => resolve((request.result as DirectorDeskChatArchive | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
  db.close();
  return record;
}

function writeArchiveToLocalStorage(archive: DirectorDeskChatArchive): void {
  if (typeof localStorage === "undefined") return;
  for (const [key, value] of Object.entries(archive.keys)) {
    localStorage.setItem(key, value);
  }
}

function messagesFromArchive(archive: DirectorDeskChatArchive): Array<{ role: string; text: string }> {
  for (const [key, raw] of Object.entries(archive.keys)) {
    if (!key.includes("superchat:messages:")) continue;
    try {
      const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string; text?: string }> } | null;
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      return messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .filter((message) => typeof message.text === "string" && message.text.trim())
        .map((message) => ({ role: message.role as string, text: message.text as string }));
    } catch {
      return [];
    }
  }
  return [];
}

async function replayArchiveToServer(archive: DirectorDeskChatArchive): Promise<void> {
  if (!archive.projectId) return;
  const messages = messagesFromArchive(archive);
  if (messages.length === 0) return;
  await api.post("api/v1/chat/director-desk/restore", {
    json: {
      scope: { kind: "directorDesk", id: `${archive.projectId}/${archive.nodeId}` },
      messages,
    },
  });
}

function scheduleServerReplay(archive: DirectorDeskChatArchive): void {
  const previous = restoreTimers.get(archive.nodeId) ?? [];
  for (const timer of previous) window.clearTimeout(timer);
  const timers = [0, 1500, 3000].map((delay) => window.setTimeout(() => {
    void replayArchiveToServer(archive).catch(() => undefined);
  }, delay));
  restoreTimers.set(archive.nodeId, timers);
}

export function stashDirectorDeskChats(nodeIds: string[]): void {
  for (const nodeId of nodeIds) {
    const keys = matchingKeys(nodeId);
    if (keys.length === 0) continue;
    const stored: Record<string, string> = {};
    for (const key of keys) {
      const value = localStorage.getItem(key);
      if (value != null) stored[key] = value;
    }
    const archive: DirectorDeskChatArchive = {
      nodeId,
      projectId: projectIdFromKeys(stored, nodeId),
      keys: stored,
      archivedAt: Date.now(),
    };
    memory.set(nodeId, archive);
    void idbPut(archive);
    for (const key of keys) localStorage.removeItem(key);
  }
}

export function restoreDirectorDeskChats(nodeIds: string[]): void {
  for (const nodeId of nodeIds) {
    const cached = memory.get(nodeId);
    if (cached) {
      writeArchiveToLocalStorage(cached);
      scheduleServerReplay(cached);
      continue;
    }
    void idbGet(nodeId).then((archive) => {
      if (!archive) return;
      memory.set(nodeId, archive);
      writeArchiveToLocalStorage(archive);
      scheduleServerReplay(archive);
    });
  }
}
