import { describe, expect, it } from "vitest";
import {
  applySavedContactNamesToConversations,
  deserializeCachePayload,
  messagesWithLocalState,
  pruneRecentMessages,
  serializeCachePayload,
} from "./localChatCache";
import { BackendConversation, BackendMessage, BackendProfile } from "@/features/chats/backendTypes";

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
    const local = [{ ...server[0], localState: "failed" as const }];

    expect(messagesWithLocalState(server, local)[0].localState).toBe("failed");
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
