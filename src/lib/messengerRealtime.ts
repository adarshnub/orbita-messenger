import { supabase } from "./supabase";
import type { BackendMessage } from "@/features/chats/backendTypes";

type RealtimeHandlers = {
  conversationIds: string[];
  onConversationEvent: (conversationId: string) => void;
  onMessageInserted?: (message: BackendMessage) => void;
  onSubscribed?: () => void;
  onRealtimeEvent: (event: MessengerRealtimeEvent) => void;
  onUserEvent: () => void;
  userId: string;
};

export type MessengerRealtimeEvent = {
  conversationId: string | null;
  kind: string;
  payload: Record<string, unknown>;
};

export function subscribeMessengerRealtime({
  conversationIds,
  onConversationEvent,
  onMessageInserted,
  onSubscribed,
  onRealtimeEvent,
  onUserEvent,
  userId,
}: RealtimeHandlers) {
  if (!supabase) return () => undefined;
  const client = supabase;

  const channels = [
    client
      .channel(`messenger:user:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `user_id=eq.${userId}`,
          schema: "public",
          table: "conversation_participants",
        },
        onUserEvent,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `user_id=eq.${userId}`,
          schema: "public",
          table: "message_receipts",
        },
        onUserEvent,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `owner_id=eq.${userId}`,
          schema: "public",
          table: "contacts",
        },
        onUserEvent,
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          filter: `target_user_id=eq.${userId}`,
          schema: "public",
          table: "realtime_events",
        },
        (payload) => {
          const conversationId =
            typeof payload.new?.conversation_id === "string" ? payload.new.conversation_id : null;
          const kind = typeof payload.new?.kind === "string" ? payload.new.kind : "";
          const eventPayload =
            payload.new?.payload && typeof payload.new.payload === "object"
              ? payload.new.payload as Record<string, unknown>
              : {};
          onRealtimeEvent({ conversationId, kind, payload: eventPayload });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") onSubscribed?.();
      }),
  ];

  conversationIds.forEach((conversationId) => {
    channels.push(
      client
        .channel(`messenger:conversation:${conversationId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            filter: `conversation_id=eq.${conversationId}`,
            schema: "public",
            table: "messages",
          },
          (payload) => {
            if (payload.eventType === "INSERT") {
              const message = mapRealtimeMessage(payload.new);
              if (message) onMessageInserted?.(message);
            }
            onConversationEvent(conversationId);
          },
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            filter: `conversation_id=eq.${conversationId}`,
            schema: "public",
            table: "conversation_participants",
          },
          () => onConversationEvent(conversationId),
        )
        .subscribe(),
    );
  });

  return () => {
    channels.forEach((channel) => {
      client.removeChannel(channel);
    });
  };
}

function mapRealtimeMessage(row: unknown): BackendMessage | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  const payload = value.encrypted_payload;
  const encryptedPayload =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const body = typeof encryptedPayload.body === "string" ? encryptedPayload.body : "";
  const kind = typeof value.kind === "string" ? value.kind : "text";
  const forwardedFrom =
    encryptedPayload.forwardedFrom && typeof encryptedPayload.forwardedFrom === "object"
      ? (encryptedPayload.forwardedFrom as BackendMessage["forwardedFrom"])
      : null;

  if (
    typeof value.id !== "string" ||
    typeof value.conversation_id !== "string" ||
    typeof value.sender_id !== "string" ||
    typeof value.created_at !== "string"
  ) {
    return null;
  }

  return {
    attachments: [],
    body,
    clientMessageId: typeof value.client_message_id === "string" ? value.client_message_id : null,
    conversationId: value.conversation_id,
    createdAt: value.created_at,
    forwardedFrom,
    id: value.id,
    kind: isBackendMessageKind(kind) ? kind : "text",
    senderId: value.sender_id,
    status: "sent",
  };
}

function isBackendMessageKind(value: string): value is BackendMessage["kind"] {
  return ["text", "image", "video", "document", "audio", "voice"].includes(value);
}
