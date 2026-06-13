import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
  indexedDB,
} from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applySavedContactNamesToConversations,
  completeQueuedMessage,
  deserializeCachePayload,
  enqueueOutgoingMessage,
  listQueuedOutgoingMessages,
  markQueuedMessageSending,
  messagesWithLocalState,
  pruneRecentMessages,
  readCachedMessages,
  serializeCachePayload,
  upsertCachedMessage,
} from "./localChatCache";
import { BackendConversation, BackendMessage, BackendProfile } from "@/features/chats/backendTypes";

beforeAll(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: indexedDB });
  Object.defineProperty(globalThis, "IDBCursor", { configurable: true, value: IDBCursor });
  Object.defineProperty(globalThis, "IDBCursorWithValue", { configurable: true, value: IDBCursorWithValue });
  Object.defineProperty(globalThis, "IDBDatabase", { configurable: true, value: IDBDatabase });
  Object.defineProperty(globalThis, "IDBFactory", { configurable: true, value: IDBFactory });
  Object.defineProperty(globalThis, "IDBIndex", { configurable: true, value: IDBIndex });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: IDBKeyRange });
  Object.defineProperty(globalThis, "IDBObjectStore", { configurable: true, value: IDBObjectStore });
  Object.defineProperty(globalThis, "IDBOpenDBRequest", { configurable: true, value: IDBOpenDBRequest });
  Object.defineProperty(globalThis, "IDBRequest", { configurable: true, value: IDBRequest });
  Object.defineProperty(globalThis, "IDBTransaction", { configurable: true, value: IDBTransaction });
  Object.defineProperty(globalThis, "IDBVersionChangeEvent", { configurable: true, value: IDBVersionChangeEvent });
});

function profile(input: Partial<BackendProfile> & { id: string; displayName: string }): BackendProfile {
  return {
    about: "",
    avatarUrl: null,
    isOnline: false,
    lastSeenAt: null,
    phone: null,
    ...input,
  };
}

function message(id: string, createdAt: string): BackendMessage {
  return {
    attachments: [],
    body: id,
    conversationId: "c1",
    createdAt,
    id,
    kind: "text",
    senderId: "u2",
    status: "sent",
  };
}

describe("local chat cache helpers", () => {
  it("serializes and deserializes cache payloads", () => {
    const payload = { id: "c1", title: "Orbita" };
    expect(deserializeCachePayload<typeof payload>(serializeCachePayload(payload))).toEqual(payload);
    expect(deserializeCachePayload("{bad json")).toBeNull();
  });

  it("keeps only the latest messages when pruning", () => {
    const messages = Array.from({ length: 105 }, (_, index) =>
      message(`m${index}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()),
    );

    const pruned = pruneRecentMessages(messages, 100);
    expect(pruned).toHaveLength(100);
    expect(pruned[0].id).toBe("m5");
    expect(pruned[99].id).toBe("m104");
  });

  it("preserves optimistic local message state over server-shaped messages", () => {
    const server = [message("m1", "2026-01-01T00:00:00.000Z")];
    const local = [{ ...server[0], localState: "queued" as const }];

    expect(messagesWithLocalState(server, local)[0].localState).toBe("queued");
  });

  it("persists and orders queued outgoing messages", async () => {
    await enqueueOutgoingMessage({
      attemptCount: 0,
      body: "second",
      conversationId: "c1",
      createdAt: "2026-01-01T00:00:02.000Z",
      kind: "text",
      localId: "local-second",
      senderId: "u1",
      status: "queued",
      userId: "queue-user",
    });
    await enqueueOutgoingMessage({
      attemptCount: 0,
      body: "first",
      conversationId: "c1",
      createdAt: "2026-01-01T00:00:01.000Z",
      kind: "text",
      localId: "local-first",
      senderId: "u1",
      status: "queued",
      userId: "queue-user",
    });

    const queued = await listQueuedOutgoingMessages("queue-user");
    expect(queued.map((item) => item.localId)).toEqual(["local-first", "local-second"]);
  });

  it("transitions queued messages through sending and completion", async () => {
    const local = {
      ...message("local-complete", "2026-01-01T00:00:00.000Z"),
      localState: "queued" as const,
      senderId: "u1",
    };
    const server = {
      ...message("server-complete", "2026-01-01T00:00:03.000Z"),
      body: local.body,
      senderId: "u1",
    };
    await upsertCachedMessage("complete-user", local);
    await enqueueOutgoingMessage({
      attemptCount: 0,
      body: local.body,
      conversationId: local.conversationId,
      createdAt: local.createdAt,
      kind: local.kind,
      localId: local.id,
      senderId: local.senderId,
      status: "queued",
      userId: "complete-user",
    });

    await markQueuedMessageSending(local.id);
    expect((await listQueuedOutgoingMessages("complete-user"))[0].status).toBe("sending");

    await completeQueuedMessage(local.id, server);
    expect(await listQueuedOutgoingMessages("complete-user")).toEqual([]);
    expect((await readCachedMessages("complete-user", local.conversationId)).map((item) => item.id)).toEqual([
      server.id,
    ]);
  });

  it("prioritizes the viewer's saved contact name for direct conversations", () => {
    const viewer = profile({ id: "u1", displayName: "Me" });
    const peer = profile({ id: "u2", displayName: "Their Profile Name", phone: "+919999999999" });
    const savedContact = profile({ id: "u2", displayName: "My Saved Name", phone: "+919999999999" });
    const conversation: BackendConversation = {
      avatarUrl: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "c1",
      inviteCode: null,
      kind: "direct",
      lastMessage: null,
      participants: [
        { ...viewer, role: "member" },
        { ...peer, role: "member" },
      ],
      title: peer.displayName,
      unreadCount: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const [renamed] = applySavedContactNamesToConversations([conversation], [savedContact], viewer.id);
    expect(renamed.title).toBe("My Saved Name");
    expect(renamed.participants.find((participant) => participant.id === peer.id)?.displayName).toBe("My Saved Name");
  });
});
