import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";

type ForegroundNotificationContext = {
  activeConversationId: string;
  appState: string;
  isChatScreenOpen: boolean;
};

type FeedbackCueKind = "message_sent" | "message_received";
const FEEDBACK_CHANNEL_ID = "feedback-cues";
let feedbackPermissionChecked = false;
let feedbackPermissionGranted = false;

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

function isFeedbackOnlyNotificationData(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  return value.feedbackOnly === true;
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as Record<string, unknown> | undefined;
    if (isFeedbackOnlyNotificationData(data)) {
      return {
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      };
    }

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

export async function playInAppCueSound(kind: FeedbackCueKind) {
  if (Platform.OS === "web") return;
  const canPlay = await ensureFeedbackCueReady();
  if (!canPlay) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: kind === "message_received" ? "New message" : "Sent",
        body: kind === "message_received" ? "Message received" : "Message sent",
        data: { feedbackOnly: true, kind },
        sound: "default",
        ...(Platform.OS === "android" ? { channelId: FEEDBACK_CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch {
    // Sound cues are optional and may be blocked by notification permissions.
  }
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export async function registerForPushNotifications(): Promise<string | null | undefined> {
  const isAndroidExpoGo = Platform.OS === "android" && Constants.appOwnership === "expo";

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("messages", {
      name: "Messages",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#6551C4",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync(FEEDBACK_CHANNEL_ID, {
      name: "In-app Feedback",
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: "default",
      vibrationPattern: [0, 120],
      lightColor: "#6551C4",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.SECRET,
    });
  }

  const current = await Notifications.getPermissionsAsync();
  const finalStatus =
    current.status === "granted" ? current : await Notifications.requestPermissionsAsync();
  feedbackPermissionChecked = true;
  feedbackPermissionGranted = finalStatus.status === "granted";

  if (finalStatus.status !== "granted") {
    return isAndroidExpoGo ? undefined : null;
  }

  if (isAndroidExpoGo) {
    // Expo Go cannot provide an Expo push token for remote push on Android,
    // but we still complete local permission/channel setup for in-app cue sounds.
    return undefined;
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

async function ensureFeedbackCueReady() {
  if (Platform.OS === "web") return false;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(FEEDBACK_CHANNEL_ID, {
      name: "In-app Feedback",
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: "default",
      vibrationPattern: [0, 120],
      lightColor: "#6551C4",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.SECRET,
    });
  }

  if (feedbackPermissionChecked) return feedbackPermissionGranted;

  const current = await Notifications.getPermissionsAsync();
  const finalStatus =
    current.status === "granted" ? current : await Notifications.requestPermissionsAsync();
  feedbackPermissionChecked = true;
  feedbackPermissionGranted = finalStatus.status === "granted";
  return feedbackPermissionGranted;
}
