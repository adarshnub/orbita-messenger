import {
  BackendConversation,
  BackendMessage,
  BackendProfile,
  BootstrapPayload,
} from "@/features/chats/backendTypes";

export type CachedChatMessage = BackendMessage & { localState?: "sending" | "failed" };

export const MESSAGE_CACHE_LIMIT = 100;

export function isLocalChatCacheEnabled() {
  return false;
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
  return null;
}

export async function writeBootstrapCache(_userId: string, _payload: BootstrapPayload) {
  return undefined;
}

export async function readCachedMessages(_userId: string, _conversationId: string): Promise<CachedChatMessage[]> {
  return [];
}

export async function writeConversationMessages(_userId: string, _conversationId: string, _messages: CachedChatMessage[]) {
  return undefined;
}

export async function upsertCachedMessage(_userId: string, _message: CachedChatMessage) {
  return undefined;
}

export async function replaceCachedMessage(
  _userId: string,
  _conversationId: string,
  _oldMessageId: string,
  _nextMessage: BackendMessage,
) {
  return undefined;
}

export async function markCachedMessageFailed(_userId: string, _message: CachedChatMessage) {
  return undefined;
}
