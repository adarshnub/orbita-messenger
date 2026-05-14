import { BackendConversation, BackendMessage, BackendProfile, BackendStatus, BootstrapPayload } from "@/features/chats/backendTypes";
import { supabase } from "./supabase";

type ApiAction =
  | "bootstrap"
  | "update_profile"
  | "search_users"
  | "add_contact_by_phone"
  | "create_direct_conversation"
  | "create_group"
  | "add_group_members"
  | "list_messages"
  | "mark_conversation_read"
  | "send_message"
  | "create_status"
  | "list_statuses";

async function callApi<T>(action: ApiAction, payload: Record<string, unknown> = {}) {
  if (!supabase) {
    throw new Error("Supabase is not configured. Add .env credentials first.");
  }

  const token = await getAccessToken();
  const { data, error } = await supabase.functions.invoke("messenger-api", {
    body: { action, payload },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (error && isExpiredTokenError(error.message)) {
    const retryToken = await getAccessToken({ forceRefresh: true });
    const retry = await supabase.functions.invoke("messenger-api", {
      body: { action, payload },
      headers: {
        Authorization: `Bearer ${retryToken}`,
      },
    });
    if (retry.error) {
      throw new Error(retry.error.message);
    }
    if (retry.data?.error) {
      throw new Error(retry.data.error);
    }
    return retry.data as T;
  }

  if (error) throw new Error(error.message);

  if (data?.error) {
    throw new Error(data.error);
  }

  return data as T;
}

async function getAccessToken(options: { forceRefresh?: boolean } = {}) {
  if (!supabase) throw new Error("Supabase is not configured. Add .env credentials first.");

  if (options.forceRefresh) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session?.access_token) {
      await supabase.auth.signOut();
      throw new Error("Your session expired. Please sign in again.");
    }
    return data.session.access_token;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    await supabase.auth.signOut();
    throw new Error("Your session expired. Please sign in again.");
  }

  const expiresAt = data.session.expires_at ? data.session.expires_at * 1000 : 0;
  if (expiresAt && expiresAt < Date.now() + 60_000) {
    return getAccessToken({ forceRefresh: true });
  }

  return data.session.access_token;
}

function isExpiredTokenError(message: string) {
  return /expired|invalid.*token|token.*invalid|jwt/i.test(message);
}

export const messengerApi = {
  bootstrap() {
    return callApi<BootstrapPayload>("bootstrap");
  },
  updateProfile(input: { displayName: string; about: string }) {
    return callApi<{ profile: BackendProfile }>("update_profile", input);
  },
  searchUsers(query: string) {
    return callApi<{ users: BackendProfile[] }>("search_users", { query });
  },
  addContactByPhone(phone: string) {
    return callApi<{ contact: BackendProfile }>("add_contact_by_phone", { phone });
  },
  createDirectConversation(otherUserId: string) {
    return callApi<{ conversation: BackendConversation }>("create_direct_conversation", {
      otherUserId,
    });
  },
  createGroup(title: string, memberIds: string[]) {
    return callApi<{ conversation: BackendConversation }>("create_group", { title, memberIds });
  },
  addGroupMembers(conversationId: string, memberIds: string[]) {
    return callApi<{ conversation: BackendConversation }>("add_group_members", {
      conversationId,
      memberIds,
    });
  },
  listMessages(conversationId: string) {
    return callApi<{ messages: BackendMessage[] }>("list_messages", { conversationId });
  },
  markConversationRead(conversationId: string) {
    return callApi<{ ok: true }>("mark_conversation_read", { conversationId });
  },
  sendMessage(input: { conversationId: string; kind: BackendMessage["kind"]; body: string }) {
    return callApi<{ message: BackendMessage }>("send_message", input);
  },
  createStatus(input: { text: string; visibility: BackendStatus["visibility"] }) {
    return callApi<{ status: BackendStatus }>("create_status", input);
  },
  listStatuses() {
    return callApi<{ statuses: BackendStatus[] }>("list_statuses");
  },
};
