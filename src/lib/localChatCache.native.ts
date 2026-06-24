import type * as SQLite from "expo-sqlite";
import {
  BackendAttachment,
  BackendConversation,
  BackendMessage,
  BackendProfile,
  BackendStatus,
  BootstrapPayload,
} from "@/features/chats/backendTypes";

export type LocalMessageState = "sending" | "queued" | "failed";
export type CachedChatMessage = BackendMessage & { localState?: LocalMessageState };
export type QueuedOutgoingAttachment = {
  localId: string;
  kind: BackendAttachment["kind"];
  name: string;
  mimeType: string;
  sizeBytes?: number | null;
  durationMs?: number | null;
  waveformSamples?: number[] | null;
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
  replyTo?: BackendMessage["replyTo"];
  replyToMessageId?: string | null;
  senderId: string;
  status: "queued" | "sending" | "failed";
  taskManagerText?: string;
  userId: string;
};

const DATABASE_NAME = "orbita-chat-cache.db";
const SCHEMA_VERSION = "1";
export const MESSAGE_CACHE_LIMIT = 100;

type SQLiteDatabase = SQLite.SQLiteDatabase;

type PayloadRow = {
  payload: string;
};

type MessageRow = {
  payload: string;
  local_state: LocalMessageState | null;
};

let dbPromise: Promise<SQLiteDatabase | null> | null = null;

export function isLocalChatCacheEnabled() {
  return typeof document === "undefined";
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

async function getDatabase() {
  if (!dbPromise) {
    dbPromise = Promise.all([import("react-native"), import("expo-sqlite")])
      .then(([reactNative, sqlite]) => {
        if (reactNative.Platform.OS === "web") return null;
        return sqlite.openDatabaseAsync(DATABASE_NAME);
      })
      .then(async (db) => {
        if (!db) return null;
        await migrate(db);
        return db;
      })
      .catch(() => null);
  }
  return dbPromise;
}

async function migrate(db: SQLiteDatabase) {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cache_meta (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      user_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, contact_id)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (user_id, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_participants (
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, conversation_id, participant_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      local_state TEXT,
      payload TEXT NOT NULL,
      PRIMARY KEY (user_id, conversation_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS attachments (
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (user_id, message_id, attachment_id)
    );
    CREATE TABLE IF NOT EXISTS statuses (
      user_id TEXT NOT NULL,
      status_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, status_id)
    );
    CREATE INDEX IF NOT EXISTS messages_by_conversation_created
      ON messages (user_id, conversation_id, created_at DESC);
  `);
}

export async function readCachedBootstrap(userId: string): Promise<BootstrapPayload | null> {
  const db = await getDatabase();
  if (!db || !userId) return null;

  const profileRow = await db.getFirstAsync<PayloadRow>("SELECT payload FROM profiles WHERE user_id = ?", userId);
  const profile = profileRow ? deserializeCachePayload<BackendProfile>(profileRow.payload) : null;
  if (!profile) return null;

  const contactRows = await db.getAllAsync<PayloadRow>(
    "SELECT payload FROM contacts WHERE user_id = ? ORDER BY updated_at DESC",
    userId,
  );
  const conversationRows = await db.getAllAsync<PayloadRow>(
    "SELECT payload FROM conversations WHERE user_id = ? ORDER BY updated_at DESC",
    userId,
  );
  const statusRows = await db.getAllAsync<PayloadRow>(
    "SELECT payload FROM statuses WHERE user_id = ? ORDER BY updated_at DESC",
    userId,
  );

  return {
    profile,
    contacts: contactRows.map((row) => deserializeCachePayload<BackendProfile>(row.payload)).filter(Boolean) as BackendProfile[],
    conversations: conversationRows
      .map((row) => deserializeCachePayload<BackendConversation>(row.payload))
      .filter(Boolean) as BackendConversation[],
    statuses: statusRows.map((row) => deserializeCachePayload<BackendStatus>(row.payload)).filter(Boolean) as BackendStatus[],
  };
}

export async function writeBootstrapCache(userId: string, payload: BootstrapPayload) {
  const db = await getDatabase();
  if (!db || !userId) return;
  const now = new Date().toISOString();

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "INSERT OR REPLACE INTO cache_meta (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
      userId,
      "schema_version",
      SCHEMA_VERSION,
      now,
    );
    await db.runAsync(
      "INSERT OR REPLACE INTO cache_meta (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
      userId,
      "last_bootstrap_sync_at",
      now,
      now,
    );
    await db.runAsync(
      "INSERT OR REPLACE INTO profiles (user_id, payload, updated_at) VALUES (?, ?, ?)",
      userId,
      serializeCachePayload(payload.profile),
      now,
    );

    await db.runAsync("DELETE FROM contacts WHERE user_id = ?", userId);
    for (const contact of payload.contacts) {
      await db.runAsync(
        "INSERT OR REPLACE INTO contacts (user_id, contact_id, payload, updated_at) VALUES (?, ?, ?, ?)",
        userId,
        contact.id,
        serializeCachePayload(contact),
        now,
      );
    }

    await db.runAsync("DELETE FROM conversations WHERE user_id = ?", userId);
    await db.runAsync("DELETE FROM conversation_participants WHERE user_id = ?", userId);
    for (const conversation of payload.conversations) {
      await db.runAsync(
        "INSERT OR REPLACE INTO conversations (user_id, conversation_id, kind, title, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)",
        userId,
        conversation.id,
        conversation.kind,
        conversation.title,
        conversation.updatedAt,
        serializeCachePayload(conversation),
      );
      for (const participant of conversation.participants) {
        await db.runAsync(
          "INSERT OR REPLACE INTO conversation_participants (user_id, conversation_id, participant_id, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
          userId,
          conversation.id,
          participant.id,
          serializeCachePayload(participant),
          now,
        );
      }
    }

    await db.runAsync("DELETE FROM statuses WHERE user_id = ?", userId);
    for (const status of payload.statuses) {
      await db.runAsync(
        "INSERT OR REPLACE INTO statuses (user_id, status_id, payload, updated_at) VALUES (?, ?, ?, ?)",
        userId,
        status.id,
        serializeCachePayload(status),
        status.createdAt,
      );
    }
  });
}

export async function readCachedMessages(userId: string, conversationId: string): Promise<CachedChatMessage[]> {
  const db = await getDatabase();
  if (!db || !userId || !conversationId) return [];
  const rows = await db.getAllAsync<MessageRow>(
    "SELECT payload, local_state FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY created_at ASC",
    userId,
    conversationId,
  );

  return rows
    .map((row) => {
      const message = deserializeCachePayload<CachedChatMessage>(row.payload);
      if (!message) return null;
      return row.local_state ? { ...message, localState: row.local_state } : message;
    })
    .filter(Boolean) as CachedChatMessage[];
}

export async function writeConversationMessages(userId: string, conversationId: string, messages: CachedChatMessage[]) {
  const db = await getDatabase();
  if (!db || !userId || !conversationId) return;
  const pruned = pruneRecentMessages(messages);

  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM messages WHERE user_id = ? AND conversation_id = ?", userId, conversationId);
    await db.runAsync(
      "DELETE FROM attachments WHERE user_id = ? AND message_id NOT IN (SELECT message_id FROM messages WHERE user_id = ?)",
      userId,
      userId,
    );
    for (const message of pruned) {
      await insertMessage(db, userId, message);
    }
  });
}

export async function upsertCachedMessage(userId: string, message: CachedChatMessage) {
  const db = await getDatabase();
  if (!db || !userId) return;
  await db.withTransactionAsync(async () => {
    await insertMessage(db, userId, message);
    await pruneConversation(db, userId, message.conversationId);
  });
}

export async function replaceCachedMessage(userId: string, conversationId: string, oldMessageId: string, nextMessage: BackendMessage) {
  const db = await getDatabase();
  if (!db || !userId) return;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "DELETE FROM messages WHERE user_id = ? AND conversation_id = ? AND message_id = ?",
      userId,
      conversationId,
      oldMessageId,
    );
    await db.runAsync("DELETE FROM attachments WHERE user_id = ? AND message_id = ?", userId, oldMessageId);
    await insertMessage(db, userId, nextMessage);
    await pruneConversation(db, userId, conversationId);
  });
}

export async function markCachedMessageFailed(userId: string, message: CachedChatMessage) {
  const failed = { ...message, localState: "failed" as const };
  await upsertCachedMessage(userId, failed);
}

export async function enqueueOutgoingMessage(_message: QueuedOutgoingMessage) {
  return undefined;
}

export async function listQueuedOutgoingMessages(_userId: string): Promise<QueuedOutgoingMessage[]> {
  return [];
}

export async function markQueuedMessageSending(_localId: string) {
  return undefined;
}

export async function completeQueuedMessage(_localId: string, _serverMessage: BackendMessage) {
  return undefined;
}

export async function failQueuedMessage(_localId: string, _reason: string) {
  return undefined;
}

export async function deleteQueuedMessage(_localId: string) {
  return undefined;
}

async function insertMessage(db: SQLiteDatabase, userId: string, message: CachedChatMessage) {
  await db.runAsync(
    "INSERT OR REPLACE INTO messages (user_id, conversation_id, message_id, sender_id, created_at, local_state, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    userId,
    message.conversationId,
    message.id,
    message.senderId,
    message.createdAt,
    message.localState ?? null,
    serializeCachePayload(message),
  );
  await db.runAsync("DELETE FROM attachments WHERE user_id = ? AND message_id = ?", userId, message.id);
  for (const attachment of message.attachments ?? []) {
    await insertAttachment(db, userId, message.id, attachment);
  }
}

async function insertAttachment(db: SQLiteDatabase, userId: string, messageId: string, attachment: BackendAttachment) {
  await db.runAsync(
    "INSERT OR REPLACE INTO attachments (user_id, message_id, attachment_id, payload) VALUES (?, ?, ?, ?)",
    userId,
    messageId,
    attachment.id,
    serializeCachePayload(attachment),
  );
}

async function pruneConversation(db: SQLiteDatabase, userId: string, conversationId: string) {
  await db.runAsync(
    `DELETE FROM attachments
     WHERE user_id = ?
       AND message_id IN (
         SELECT message_id FROM messages
         WHERE user_id = ? AND conversation_id = ?
         ORDER BY created_at DESC
         LIMIT -1 OFFSET ?
       )`,
    userId,
    userId,
    conversationId,
    MESSAGE_CACHE_LIMIT,
  );
  await db.runAsync(
    `DELETE FROM messages
     WHERE user_id = ? AND conversation_id = ?
       AND message_id IN (
         SELECT message_id FROM messages
         WHERE user_id = ? AND conversation_id = ?
         ORDER BY created_at DESC
         LIMIT -1 OFFSET ?
       )`,
    userId,
    conversationId,
    userId,
    conversationId,
    MESSAGE_CACHE_LIMIT,
  );
}
