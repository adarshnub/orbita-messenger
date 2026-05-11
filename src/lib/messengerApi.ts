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
  | "send_message"
  | "create_status"
  | "list_statuses";

async function callApi<T>(action: ApiAction, payload: Record<string, unknown> = {}) {
  if (!supabase) {
    throw new Error("Supabase is not configured. Add .env credentials first.");
  }

  const { data, error } = await supabase.functions.invoke("messenger-api", {
    body: { action, payload },
  });

  if (error) {
    throw new Error(error.message);
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  return data as T;
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
