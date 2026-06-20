import {
  BackendAttachment,
  BackendConversation,
  BackendMessage,
  BackendProfile,
  BackendStatus,
  BootstrapPayload,
} from "@/features/chats/backendTypes";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { supabase } from "./supabase";

const rawOrbitaApiUrl = process.env.EXPO_PUBLIC_ORBITA_API_URL?.replace(/\/$/, "");
const orbitaApiUrl = resolveOrbitaApiUrl(rawOrbitaApiUrl);
const API_TIMEOUT_MS = 12_000;

type ApiAction =
  | "bootstrap"
  | "update_profile"
  | "search_users"
  | "add_contact_by_phone"
  | "create_direct_conversation"
  | "create_group"
  | "add_group_members"
  | "add_task_thread_members"
  | "list_messages"
  | "mark_conversation_read"
  | "register_push_token"
  | "send_message"
  | "forward_messages"
  | "create_status"
  | "list_statuses"
  | "create_taskmanager_admin_session";

export type TaskManagerAdminSessionResponse =
  | {
      available: false;
      reason?: string;
    }
  | {
      available: true;
      apiBaseUrl: string;
      session: {
        token: string;
        expires_at: string;
        org_id: string;
        org_name: string;
        user_id: string;
        user_name: string;
      };
    };

async function callApi<T>(action: ApiAction, payload: Record<string, unknown> = {}) {
  if (!supabase) {
    throw new Error("Supabase is not configured. Add .env credentials first.");
  }
  if (!orbitaApiUrl) {
    throw new Error("Orbita backend is not configured. Add EXPO_PUBLIC_ORBITA_API_URL to .env.");
  }

  const token = await getAccessToken();
  try {
    return await callBackendApi<T>(action, payload, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isExpiredTokenError(message)) throw error;

    const retryToken = await getAccessToken({ forceRefresh: true });
    return callBackendApi<T>(action, payload, retryToken);
  }
}

async function callBackendApi<T>(action: ApiAction, payload: Record<string, unknown>, token: string) {
  const body = JSON.stringify({ action, payload });
  const result = await backendRequest(`/api/messenger`, token, body);
  return parseBackendResponse<T>(result.response, result.data);
}

async function backendRequest(path: string, token: string, body: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${orbitaApiUrl}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Orbita backend request timed out. Check that the backend is running at ${orbitaApiUrl}.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const data = (await response.json().catch(() => null)) as unknown;
  return { data, response };
}

function parseBackendResponse<T>(response: Response, data: unknown) {

  if (!response.ok) {
    const message = apiError(data) ?? `Orbita backend request failed: ${response.status}`;
    throw new Error(message);
  }

  const error = apiError(data);
  if (error) {
    throw new Error(error);
  }

  return data as T;
}

async function uploadBackendMedia<T>(form: FormData, token: string, endpoint = "media") {
  const result = await backendUploadRequest(`/api/messenger/${endpoint}`, token, form);
  return parseBackendResponse<T>(result.response, result.data);
}

async function backendUploadRequest(path: string, token: string, form: FormData) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${orbitaApiUrl}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Orbita backend request timed out. Check that the backend is running at ${orbitaApiUrl}.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const data = (await response.json().catch(() => null)) as unknown;
  return { data, response };
}

function apiError(data: unknown) {
  if (!data || typeof data !== "object" || !("error" in data)) return null;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
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

function resolveOrbitaApiUrl(value?: string) {
  if (!value) return "";
  const normalizedValue = normalizeOrbitaApiBase(value);
  if (Platform.OS === "web") return normalizedValue;

  try {
    const url = new URL(normalizedValue);
    const pointsAtLocalMachine = ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
    if (!pointsAtLocalMachine) return normalizedValue;

    const host = expoDevHost() ?? (Platform.OS === "android" ? "10.0.2.2" : "localhost");
    url.hostname = host;
    return url.toString().replace(/\/$/, "");
  } catch {
    return normalizedValue;
  }
}

function normalizeOrbitaApiBase(input: string) {
  const trimmed = input.replace(/\/$/, "");
  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname
      .replace(/\/api\/?$/i, "")
      .replace(/\/api\/messenger\/?$/i, "")
      || "/";
    url.pathname = normalizedPath;
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed
      .replace(/\/api\/?$/i, "")
      .replace(/\/api\/messenger\/?$/i, "");
  }
}

function expoDevHost() {
  const expoConfigHost = (Constants.expoConfig as { hostUri?: string } | null)?.hostUri;
  const manifestHost = (Constants.manifest as { debuggerHost?: string } | null)?.debuggerHost;
  const hostUri = expoConfigHost ?? manifestHost;
  if (!hostUri) return null;
  return hostUri.replace(/^https?:\/\//, "").split(":")[0] || null;
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
  addContactByPhone(phone: string, nickname?: string) {
    return callApi<{ contact: BackendProfile }>("add_contact_by_phone", { phone, nickname });
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
  addTaskThreadMembers(conversationId: string, memberIds: string[]) {
    return callApi<{ conversation: BackendConversation }>("add_task_thread_members", {
      conversationId,
      memberIds,
    });
  },
  listMessages(input: string | { beforeCreatedAt?: string; conversationId: string; limit?: number }) {
    const payload = typeof input === "string" ? { conversationId: input } : input;
    return callApi<{ hasMore: boolean; messages: BackendMessage[] }>("list_messages", payload);
  },
  markConversationRead(conversationId: string) {
    return callApi<{ ok: true }>("mark_conversation_read", { conversationId });
  },
  registerPushToken(pushToken: string | null) {
    return callApi<{ ok: true }>("register_push_token", { pushToken });
  },
  sendMessage(input: {
    clientMessageId?: string;
    conversationId: string;
    kind: BackendMessage["kind"];
    body: string;
    attachmentId?: string;
    taskManagerText?: string;
  }) {
    return callApi<{
      message: BackendMessage;
      taskManagerForward?: { forwarded: boolean; reason?: string };
    }>("send_message", input);
  },
  forwardMessage(input: { messageId: string; destinationConversationIds: string[] }) {
    return callApi<{ messages: BackendMessage[] }>("forward_messages", input);
  },
  async uploadMedia(input: {
    file:
      | {
          uri: string;
          name: string;
          type: string;
        }
      | File;
    kind: BackendAttachment["kind"];
    durationMs?: number | null;
    waveformSamples?: number[] | null;
  }) {
    const buildForm = () => {
      const next = new FormData();
      next.append("kind", input.kind);
      if (input.durationMs) next.append("durationMs", String(Math.round(input.durationMs)));
      if (input.waveformSamples?.length) next.append("waveformSamples", JSON.stringify(input.waveformSamples));
      if (typeof File !== "undefined" && input.file instanceof File) {
        next.append("filename", input.file.name);
        next.append("file", input.file);
      } else {
        next.append("filename", input.file.name);
        next.append("file", input.file as unknown as Blob);
      }
      return next;
    };
    const token = await getAccessToken();
    try {
      return await uploadBackendMedia<{ attachment: BackendAttachment }>(buildForm(), token, "media");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isExpiredTokenError(message)) throw error;
      const retryToken = await getAccessToken({ forceRefresh: true });
      return uploadBackendMedia<{ attachment: BackendAttachment }>(buildForm(), retryToken, "media");
    }
  },
  async uploadProfileAvatar(input: {
    file:
      | {
          uri: string;
          name: string;
          type: string;
        }
      | File;
  }) {
    const buildForm = () => {
      const next = new FormData();
      if (typeof File !== "undefined" && input.file instanceof File) {
        next.append("filename", input.file.name);
        next.append("file", input.file);
      } else {
        next.append("filename", input.file.name);
        next.append("file", input.file as unknown as Blob);
      }
      return next;
    };
    const token = await getAccessToken();
    try {
      return await uploadBackendMedia<{ profile: BackendProfile }>(buildForm(), token, "avatar");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isExpiredTokenError(message)) throw error;
      const retryToken = await getAccessToken({ forceRefresh: true });
      return uploadBackendMedia<{ profile: BackendProfile }>(buildForm(), retryToken, "avatar");
    }
  },
  createStatus(input: { text: string; visibility: BackendStatus["visibility"] }) {
    return callApi<{ status: BackendStatus }>("create_status", input);
  },
  listStatuses() {
    return callApi<{ statuses: BackendStatus[] }>("list_statuses");
  },
  createTaskManagerAdminSession(input: { conversationId?: string } = {}) {
    return callApi<TaskManagerAdminSessionResponse>("create_taskmanager_admin_session", input);
  },
};
