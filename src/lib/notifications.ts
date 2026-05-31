import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";

type ForegroundNotificationContext = {
  activeConversationId: string;
  appState: string;
  isChatScreenOpen: boolean;
};

const foregroundNotificationContext: ForegroundNotificationContext = {
  activeConversationId: "",
  appState: "active",
  isChatScreenOpen: false,
};

export function setForegroundNotificationContext(context: Partial<ForegroundNotificationContext>) {
  if (typeof context.activeConversationId === "string") {
    foregroundNotificationContext.activeConversationId = context.activeConversationId;
  }
  if (typeof context.appState === "string") {
    foregroundNotificationContext.appState = context.appState;
  }
  if (typeof context.isChatScreenOpen === "boolean") {
    foregroundNotificationContext.isChatScreenOpen = context.isChatScreenOpen;
  }
}

export function extractConversationIdFromNotificationData(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const value = data as Record<string, unknown>;
  if (typeof value.conversationId === "string" && value.conversationId.trim()) {
    return value.conversationId.trim();
  }
  if (typeof value.conversation_id === "string" && value.conversation_id.trim()) {
    return value.conversation_id.trim();
  }

  // Some providers relay nested payloads as stringified JSON.
  const nestedBody = typeof value.body === "string" ? safeJsonParse(value.body) : null;
  if (nestedBody && typeof nestedBody === "object") {
    const nested = nestedBody as Record<string, unknown>;
    if (typeof nested.conversationId === "string" && nested.conversationId.trim()) {
      return nested.conversationId.trim();
    }
    if (typeof nested.conversation_id === "string" && nested.conversation_id.trim()) {
      return nested.conversation_id.trim();
    }
  }

  return "";
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as Record<string, unknown> | undefined;
    const conversationId = extractConversationIdFromNotificationData(data);
    const shouldSuppress =
      foregroundNotificationContext.appState === "active" &&
      foregroundNotificationContext.isChatScreenOpen &&
      Boolean(foregroundNotificationContext.activeConversationId) &&
      conversationId === foregroundNotificationContext.activeConversationId;

    return {
      shouldPlaySound: !shouldSuppress,
      shouldSetBadge: false,
      shouldShowBanner: !shouldSuppress,
      shouldShowList: !shouldSuppress,
    };
  },
});

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export async function registerForPushNotifications(): Promise<string | null | undefined> {
  const isAndroidExpoGo = Platform.OS === "android" && Constants.appOwnership === "expo";
  if (isAndroidExpoGo) {
    return undefined;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("messages", {
      name: "Messages",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#6551C4",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  const current = await Notifications.getPermissionsAsync();
  const finalStatus =
    current.status === "granted" ? current : await Notifications.requestPermissionsAsync();

  if (finalStatus.status !== "granted") {
    return null;
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    undefined;
  try {
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return token.data;
  } catch (error) {
    console.warn("Push notification registration failed.", error);
    return undefined;
  }
}
