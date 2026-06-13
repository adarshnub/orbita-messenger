import {
  BackendAttachment,
  BackendConversation,
  BackendMessage,
  BackendProfile,
  BackendStatus,
  BootstrapPayload,
} from "@/features/chats/backendTypes";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type LocalMessageState = "sending" | "queued" | "failed";
export type CachedChatMessage = BackendMessage & { localState?: LocalMessageState };
export type QueuedOutgoingAttachment = {
  localId: string;
  kind: BackendAttachment["kind"];
  name: string;
  mimeType: string;
  sizeBytes?: number | null;
  durationMs?: number | null;
  file: Blob;
};
export type QueuedOutgoingMessage = {
  attemptCount: number;
  attachment?: QueuedOutgoingAttachment | null;
  attachmentId?: string;
  body: string;
  conversationId: string;
  createdAt: string;
  kind: BackendMessage["kind"];
  lastError?: string;
  localId: string;
  senderId: string;
  status: "queued" | "sending" | "failed";
  taskManagerText?: string;
  userId: string;
};

export const MESSAGE_CACHE_LIMIT = 100;
const DATABASE_NAME = "orbita-web-cache";
const DATABASE_VERSION = 1;

type StoredMessage = CachedChatMessage & { userId: string };
type StoredBootstrap = BootstrapPayload & { userId: string; updatedAt: string };

interface OrbitaWebCacheDb extends DBSchema {
  bootstrap: {
    key: string;
    value: StoredBootstrap;
  };
  messages: {
    indexes: {
      byConversation: [string, string, string];
    };
    key: [string, string, string];
    value: StoredMessage;
  };
  outbox: {
    indexes: {
      byUser: [string, string];
    };
    key: string;
    value: QueuedOutgoingMessage;
  };
}

let dbPromise: Promise<IDBPDatabase<OrbitaWebCacheDb> | null> | null = null;

export function isLocalChatCacheEnabled() {
  return typeof indexedDB !== "undefined";
}

export function pruneRecentMessages<T extends Pick<BackendMessage, "createdAt" | "id">>(messages: T[], limit = MESSAGE_CACHE_LIMIT) {
  return [...messages]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-limit);
}

export function serializeCachePayload(value: unknown) {
  return JSON.stringify(value);
}

export function deserializeCachePayload<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function messagesWithLocalState(messages: BackendMessage[], localMessages: CachedChatMessage[]): CachedChatMessage[] {
  const localById = new Map(localMessages.filter((message) => message.localState).map((message) => [message.id, message]));
  return messages.map((message) => localById.get(message.id) ?? message);
}

export function applySavedContactNamesToConversations(
  conversations: BackendConversation[],
  contacts: BackendProfile[],
  viewerId: string,
) {
  if (!viewerId || !contacts.length) return conversations;
  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));

  return conversations.map((conversation) => {
    let changed = false;
    const participants = conversation.participants.map((participant) => {
      if (participant.id === viewerId) return participant;
      const savedName = contactById.get(participant.id)?.displayName.trim();
      if (!savedName || savedName === participant.displayName) return participant;
      changed = true;
      return { ...participant, displayName: savedName };
    });

    if (conversation.kind !== "direct") {
      return changed ? { ...conversation, participants } : conversation;
    }

    const peer = participants.find((participant) => participant.id !== viewerId);
    const title = peer?.displayName || conversation.title;
    return changed || title !== conversation.title
      ? { ...conversation, participants, title }
      : conversation;
  });
}

export async function readCachedBootstrap(_userId: string): Promise<BootstrapPayload | null> {
  const db = await getDatabase();
  if (!db || !_userId) return null;
  const row = await db.get("bootstrap", _userId);
  if (!row) return null;
  return {
    contacts: row.contacts,
    conversations: row.conversations,
    profile: row.profile,
    statuses: row.statuses,
  };
}

export async function writeBootstrapCache(userId: string, payload: BootstrapPayload) {
  const db = await getDatabase();
  if (!db || !userId) return;
  await db.put("bootstrap", {
    ...payload,
    updatedAt: new Date().toISOString(),
    userId,
  });
}

export async function readCachedMessages(userId: string, conversationId: string): Promise<CachedChatMessage[]> {
  const db = await getDatabase();
  if (!db || !userId || !conversationId) return [];
  const rows = await db.getAllFromIndex(
    "messages",
    "byConversation",
    IDBKeyRange.bound([userId, conversationId, ""], [userId, conversationId, "\uffff"]),
  );
  return rows
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
    .map(({ userId: _storedUserId, ...message }) => message);
}

export async function writeConversationMessages(userId: string, conversationId: string, messages: CachedChatMessage[]) {
  const db = await getDatabase();
  if (!db || !userId || !conversationId) return;
  const tx = db.transaction("messages", "readwrite");
  const index = tx.store.index("byConversation");
  let cursor = await index.openCursor(IDBKeyRange.bound([userId, conversationId, ""], [userId, conversationId, "\uffff"]));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  for (const message of pruneRecentMessages(messages)) {
    await tx.store.put({ ...message, userId });
  }
  await tx.done;
}

export async function upsertCachedMessage(userId: string, message: CachedChatMessage) {
  const db = await getDatabase();
  if (!db || !userId) return;
  await db.put("messages", { ...message, userId });
  await pruneConversation(db, userId, message.conversationId);
}

export async function replaceCachedMessage(
  userId: string,
  conversationId: string,
  oldMessageId: string,
  nextMessage: BackendMessage,
) {
  const db = await getDatabase();
  if (!db || !userId) return;
  const tx = db.transaction("messages", "readwrite");
  await tx.store.delete([userId, conversationId, oldMessageId]);
  await tx.store.put({ ...nextMessage, userId });
  await tx.done;
  await pruneConversation(db, userId, conversationId);
}

export async function markCachedMessageFailed(userId: string, message: CachedChatMessage) {
  await upsertCachedMessage(userId, { ...message, localState: "failed" });
}

export async function enqueueOutgoingMessage(message: QueuedOutgoingMessage) {
  const db = await getDatabase();
  if (!db) return;
  await db.put("outbox", message);
}

export async function listQueuedOutgoingMessages(userId: string): Promise<QueuedOutgoingMessage[]> {
  const db = await getDatabase();
  if (!db || !userId) return [];
  const rows = await db.getAllFromIndex("outbox", "byUser", IDBKeyRange.bound([userId, ""], [userId, "\uffff"]));
  return rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.localId.localeCompare(b.localId));
}

export async function markQueuedMessageSending(localId: string) {
  await updateQueuedMessage(localId, (message) => ({
    ...message,
    attemptCount: message.attemptCount + 1,
    lastError: undefined,
    status: "sending",
  }));
}

export async function completeQueuedMessage(localId: string, serverMessage: BackendMessage) {
  const db = await getDatabase();
  if (!db) return;
  const queued = await db.get("outbox", localId);
  const tx = db.transaction(["outbox", "messages"], "readwrite");
  await tx.objectStore("outbox").delete(localId);
  if (queued) {
    await tx.objectStore("messages").delete([queued.userId, queued.conversationId, localId]);
    await tx.objectStore("messages").put({ ...serverMessage, userId: queued.userId });
  }
  await tx.done;
}

export async function failQueuedMessage(localId: string, reason: string) {
  await updateQueuedMessage(localId, (message) => ({
    ...message,
    lastError: reason,
    status: "failed",
  }));
}

export async function deleteQueuedMessage(localId: string) {
  const db = await getDatabase();
  if (!db) return;
  await db.delete("outbox", localId);
}

async function getDatabase() {
  if (!isLocalChatCacheEnabled()) return null;
  if (!dbPromise) {
    dbPromise = openDB<OrbitaWebCacheDb>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("bootstrap")) {
          db.createObjectStore("bootstrap", { keyPath: "userId" });
        }
        if (!db.objectStoreNames.contains("messages")) {
          const store = db.createObjectStore("messages", { keyPath: ["userId", "conversationId", "id"] });
          store.createIndex("byConversation", ["userId", "conversationId", "createdAt"]);
        }
        if (!db.objectStoreNames.contains("outbox")) {
          const store = db.createObjectStore("outbox", { keyPath: "localId" });
          store.createIndex("byUser", ["userId", "createdAt"]);
        }
      },
    }).catch(() => null);
  }
  return dbPromise;
}

async function pruneConversation(db: IDBPDatabase<OrbitaWebCacheDb>, userId: string, conversationId: string) {
  const rows = await db.getAllFromIndex(
    "messages",
    "byConversation",
    IDBKeyRange.bound([userId, conversationId, ""], [userId, conversationId, "\uffff"]),
  );
  const prunedIds = new Set(pruneRecentMessages(rows).map((message) => message.id));
  const tx = db.transaction("messages", "readwrite");
  for (const row of rows) {
    if (!row.localState && !prunedIds.has(row.id)) {
      await tx.store.delete([userId, conversationId, row.id]);
    }
  }
  await tx.done;
}

async function updateQueuedMessage(localId: string, update: (message: QueuedOutgoingMessage) => QueuedOutgoingMessage) {
  const db = await getDatabase();
  if (!db) return;
  const message = await db.get("outbox", localId);
  if (!message) return;
  await db.put("outbox", update(message));
}
