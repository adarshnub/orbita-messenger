import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

const STORAGE_KEY = "orbita.taskManagerAdminSession.v1";

export const TASK_MANAGER_EMPLOYEE_ROLES = ["member", "admin"] as const;

export type TaskManagerAdminSession = {
  apiBaseUrl: string;
  token: string;
  expiresAt: string;
  orgId: string;
  orgName: string;
  userId: string;
  userName: string;
};

export type TaskManagerAdminUser = {
  _id: string;
  name: string;
  role: "admin" | "member";
  departments?: string[];
  preferred_language?: string;
  agent_channel?: "whatsapp" | "orbita";
  channels?: {
    whatsapp?: string;
    orbita?: {
      profile_id?: string;
      conversation_id?: string;
    };
  };
};

export type TaskManagerAdminTask = {
  _id: string;
  display_number?: string | null;
  parent_task_id?: string | null;
  root_task_id?: string | null;
  subtask_sequence?: number | null;
  orbita_thread_status?: "ready" | "pending" | "failed";
  thread_member_ids?: string[];
  title: string;
  status: "open" | "in_progress" | "done" | "discarded";
  assignee_id: string;
  creator_id: string;
  due_date?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type TaskManagerAdminSummary = {
  employees: number;
  tasks: {
    open: number;
    in_progress: number;
    done: number;
    discarded: number;
    overdue: number;
  };
  completion_rate: number;
  recent_activity: TaskManagerAdminTask[];
};

export type TaskManagerDepartment = {
  _id: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  member_count?: number;
};

export type TaskManagerDepartmentDetails = TaskManagerDepartment & {
  members: Array<{
    user_id: string;
    name: string;
    role?: "admin" | "member";
    roles?: string[];
  }>;
};

export type TaskManagerChatMessage = {
  _id: string;
  user_id: string;
  direction: "in" | "out";
  channel: string;
  kind: string;
  text: string | null;
  created_at: string;
};

export function isAdminSessionExpired(session: Pick<TaskManagerAdminSession, "expiresAt">, now = Date.now()) {
  return new Date(session.expiresAt).getTime() <= now + 30_000;
}

export async function saveTaskManagerAdminSession(session: TaskManagerAdminSession) {
  const value = JSON.stringify(session);
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, value);
  } catch {
    await AsyncStorage.setItem(STORAGE_KEY, value);
  }
}

export async function loadTaskManagerAdminSession(): Promise<TaskManagerAdminSession | null> {
  let value: string | null = null;
  try {
    value = await SecureStore.getItemAsync(STORAGE_KEY);
  } catch {
    value = await AsyncStorage.getItem(STORAGE_KEY);
  }
  if (!value) return null;
  const session = JSON.parse(value) as TaskManagerAdminSession;
  if (isAdminSessionExpired(session)) {
    await clearTaskManagerAdminSession();
    return null;
  }
  return session;
}

export async function clearTaskManagerAdminSession() {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {
    // Ignore SecureStore availability failures and clear AsyncStorage below.
  }
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
}

async function adminFetch<T>(
  session: TaskManagerAdminSession,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (isAdminSessionExpired(session)) {
    await clearTaskManagerAdminSession();
    throw new Error("Task Manager admin session expired.");
  }

  const apiBaseUrl = resolveTaskManagerAdminApiBaseUrl(session.apiBaseUrl);
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      await clearTaskManagerAdminSession();
    }
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Task Manager admin request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const taskManagerAdminApi = {
  me(session: TaskManagerAdminSession) {
    return adminFetch<{ user: TaskManagerAdminUser; org: { _id: string; name: string }; permissions: string[] }>(
      session,
      `/orbita/admin/orgs/${session.orgId}/me`,
    );
  },
  summary(session: TaskManagerAdminSession) {
    return adminFetch<TaskManagerAdminSummary>(session, `/orbita/admin/orgs/${session.orgId}/summary`);
  },
  users(session: TaskManagerAdminSession) {
    return adminFetch<TaskManagerAdminUser[]>(session, `/orbita/admin/orgs/${session.orgId}/users`);
  },
  createUser(session: TaskManagerAdminSession, body: Partial<TaskManagerAdminUser> & { name: string }) {
    return adminFetch<TaskManagerAdminUser>(session, `/orbita/admin/orgs/${session.orgId}/users`, {
      method: "POST",
      body,
    });
  },
  updateUser(session: TaskManagerAdminSession, userId: string, body: Partial<TaskManagerAdminUser>) {
    return adminFetch<TaskManagerAdminUser>(session, `/orbita/admin/orgs/${session.orgId}/users/${userId}`, {
      method: "PATCH",
      body,
    });
  },
  userChats(session: TaskManagerAdminSession, userId: string) {
    return adminFetch<TaskManagerChatMessage[]>(
      session,
      `/orbita/admin/orgs/${session.orgId}/users/${userId}/chats?limit=100`,
    );
  },
  tasks(session: TaskManagerAdminSession) {
    return adminFetch<TaskManagerAdminTask[]>(session, `/orbita/admin/orgs/${session.orgId}/tasks`);
  },
  createSubtask(
    session: TaskManagerAdminSession,
    taskId: string,
    body: {
      assignee_id: string;
      title: string;
      description?: string | null;
      due_date?: string | null;
      thread_member_ids?: string[];
    },
  ) {
    return adminFetch<TaskManagerAdminTask>(session, `/orbita/admin/orgs/${session.orgId}/tasks/${taskId}/subtasks`, {
      method: "POST",
      body,
    });
  },
  addTaskThreadMembers(session: TaskManagerAdminSession, taskId: string, userIds: string[]) {
    return adminFetch<TaskManagerAdminTask>(session, `/orbita/admin/orgs/${session.orgId}/tasks/${taskId}/thread/members`, {
      method: "POST",
      body: { user_ids: userIds },
    });
  },
  updateTaskStatus(session: TaskManagerAdminSession, taskId: string, status: TaskManagerAdminTask["status"]) {
    return adminFetch<TaskManagerAdminTask>(session, `/orbita/admin/orgs/${session.orgId}/tasks/${taskId}/status`, {
      method: "POST",
      body: { status },
    });
  },
  departments(session: TaskManagerAdminSession) {
    return adminFetch<TaskManagerDepartment[]>(session, `/orbita/admin/orgs/${session.orgId}/departments`);
  },
  department(session: TaskManagerAdminSession, departmentId: string) {
    return adminFetch<TaskManagerDepartmentDetails>(
      session,
      `/orbita/admin/orgs/${session.orgId}/departments/${departmentId}`,
    );
  },
  settings(session: TaskManagerAdminSession) {
    return adminFetch<Record<string, unknown>>(session, `/orbita/admin/orgs/${session.orgId}/settings`);
  },
  updateSettings(session: TaskManagerAdminSession, body: Record<string, unknown>) {
    return adminFetch<Record<string, unknown>>(session, `/orbita/admin/orgs/${session.orgId}/settings`, {
      method: "PATCH",
      body,
    });
  },
  taskReports(session: TaskManagerAdminSession) {
    return adminFetch<{
      summary: TaskManagerAdminSummary["tasks"] & { total: number; completion_rate: number };
      by_assignee: { user_id: string; total: number; done: number }[];
    }>(session, `/orbita/admin/orgs/${session.orgId}/reports/tasks`);
  },
};

function resolveTaskManagerAdminApiBaseUrl(value: string) {
  const normalizedValue = value.replace(/\/$/, "");
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

function expoDevHost() {
  const constants = Constants as unknown as {
    expoConfig?: { hostUri?: string } | null;
    expoGoConfig?: { debuggerHost?: string } | null;
    experienceUrl?: string;
    linkingUri?: string;
    manifest?: { debuggerHost?: string; hostUri?: string } | null;
    manifest2?: {
      extra?: {
        expoClient?: { hostUri?: string };
        expoGo?: { debuggerHost?: string };
      };
    } | null;
  };
  const candidates = [
    constants.expoConfig?.hostUri,
    constants.expoGoConfig?.debuggerHost,
    constants.manifest?.debuggerHost,
    constants.manifest?.hostUri,
    constants.manifest2?.extra?.expoClient?.hostUri,
    constants.manifest2?.extra?.expoGo?.debuggerHost,
    constants.linkingUri,
    constants.experienceUrl,
  ];

  for (const candidate of candidates) {
    const host = hostFromDevUri(candidate);
    if (host) return host;
  }
  return null;
}

function hostFromDevUri(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const nestedUrl = parsed.searchParams.get("url");
    if (nestedUrl) return hostFromDevUri(decodeURIComponent(nestedUrl));
    return parsed.hostname || null;
  } catch {
    return value.replace(/^https?:\/\//, "").split(":")[0] || null;
  }
}
