import { supabase } from "./supabase";

type RealtimeHandlers = {
  conversationIds: string[];
  onConversationEvent: (conversationId: string) => void;
  onSubscribed?: () => void;
  onRealtimeEvent: (conversationId: string | null) => void;
  onUserEvent: () => void;
  userId: string;
};

export function subscribeMessengerRealtime({
  conversationIds,
  onConversationEvent,
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
          onRealtimeEvent(conversationId);
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
          () => onConversationEvent(conversationId),
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
