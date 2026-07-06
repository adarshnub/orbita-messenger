import { beforeEach, describe, expect, it, vi } from "vitest";

const { asyncStorage, secureStore } = vi.hoisted(() => ({
  asyncStorage: {
    getItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  },
  secureStore: {
    deleteItemAsync: vi.fn(),
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
  },
}));

vi.mock("expo-secure-store", () => secureStore);
vi.mock("@react-native-async-storage/async-storage", () => ({ default: asyncStorage }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { hostUri: "192.168.1.25:8081" }, manifest: null } }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

import {
  clearTaskManagerAdminSession,
  isAdminSessionExpired,
  loadTaskManagerAdminSession,
  saveTaskManagerAdminSession,
  TASK_MANAGER_EMPLOYEE_ROLES,
  taskManagerAdminApi,
  type TaskManagerAdminSession,
} from "./taskManagerAdminApi";

const futureIso = new Date(Date.now() + 60 * 60_000).toISOString();
const now = Date.UTC(2026, 5, 4, 12, 0, 0);

function session(overrides: Partial<TaskManagerAdminSession> = {}): TaskManagerAdminSession {
  return {
    apiBaseUrl: "https://task.example.com",
    expiresAt: futureIso,
    orgId: "org_1",
    orgName: "Orbita",
    token: "admin-token",
    userId: "user_1",
    userName: "Admin User",
    ...overrides,
  };
}

describe("Task Manager admin session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    asyncStorage.removeItem.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
  });

  it("keeps admin mode hidden without a valid stored session", async () => {
    secureStore.getItemAsync.mockResolvedValue(null);

    await expect(loadTaskManagerAdminSession()).resolves.toBeNull();
  });

  it("makes admin mode visible when a valid admin session is stored", async () => {
    const stored = session();
    secureStore.getItemAsync.mockResolvedValue(JSON.stringify(stored));

    await expect(loadTaskManagerAdminSession()).resolves.toEqual(stored);
  });

  it("clears expired admin sessions", async () => {
    secureStore.getItemAsync.mockResolvedValue(JSON.stringify(session({ expiresAt: "2000-01-01T00:00:00.000Z" })));

    await expect(loadTaskManagerAdminSession()).resolves.toBeNull();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("orbita.taskManagerAdminSession.v1");
    expect(asyncStorage.removeItem).toHaveBeenCalledWith("orbita.taskManagerAdminSession.v1");
  });

  it("treats sessions expiring inside the refresh window as expired", () => {
    expect(isAdminSessionExpired({ expiresAt: new Date(now + 29_000).toISOString() }, now)).toBe(true);
    expect(isAdminSessionExpired({ expiresAt: new Date(now + 31_000).toISOString() }, now)).toBe(false);
  });

  it("supports member and admin employee roles", () => {
    expect(TASK_MANAGER_EMPLOYEE_ROLES).toEqual(["member", "admin"]);
  });

  it("stores admin sessions in SecureStore and falls back to AsyncStorage", async () => {
    const stored = session();
    secureStore.setItemAsync.mockRejectedValueOnce(new Error("unavailable"));

    await saveTaskManagerAdminSession(stored);

    expect(secureStore.setItemAsync).toHaveBeenCalledWith("orbita.taskManagerAdminSession.v1", JSON.stringify(stored));
    expect(asyncStorage.setItem).toHaveBeenCalledWith("orbita.taskManagerAdminSession.v1", JSON.stringify(stored));
  });

  it("clears admin mode on demand", async () => {
    await clearTaskManagerAdminSession();

    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("orbita.taskManagerAdminSession.v1");
    expect(asyncStorage.removeItem).toHaveBeenCalledWith("orbita.taskManagerAdminSession.v1");
  });
});

describe("Task Manager admin API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    asyncStorage.removeItem.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
  });

  it("updates task status with the admin bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _id: "task_1", status: "done" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await taskManagerAdminApi.updateTaskStatus(session({ apiBaseUrl: "http://localhost:4000" }), "task_1", "done");

    expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.25:4000/orbita/admin/orgs/org_1/tasks/task_1/status", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "done" }),
    });
  });

  it("loads department members with the admin bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ _id: "dept_1", name: "Ops", members: [{ user_id: "user_2", name: "Anu", roles: ["lead"] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(taskManagerAdminApi.department(session({ apiBaseUrl: "http://localhost:4000" }), "dept_1")).resolves.toEqual({
      _id: "dept_1",
      name: "Ops",
      members: [{ user_id: "user_2", name: "Anu", roles: ["lead"] }],
    });

    expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.25:4000/orbita/admin/orgs/org_1/departments/dept_1", {
      method: "GET",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("loads tasks for a selected department with the admin bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ _id: "task_1", title: "Nursing task" }],
    });
    vi.stubGlobal("fetch", fetchMock);

    await taskManagerAdminApi.tasks(session({ apiBaseUrl: "http://localhost:4000" }), { departmentId: "dept_1" });

    expect(fetchMock).toHaveBeenCalledWith("http://192.168.1.25:4000/orbita/admin/orgs/org_1/tasks?department_id=dept_1", {
      method: "GET",
      headers: {
        Authorization: "Bearer admin-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("clears admin mode when task status refresh auth fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: "Forbidden" }),
      }),
    );

    await expect(taskManagerAdminApi.updateTaskStatus(session(), "task_1", "done")).rejects.toThrow("Forbidden");
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("orbita.taskManagerAdminSession.v1");
    expect(asyncStorage.removeItem).toHaveBeenCalledWith("orbita.taskManagerAdminSession.v1");
  });
});
