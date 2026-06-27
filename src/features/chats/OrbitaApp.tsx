import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import * as DeviceContacts from "expo-contacts";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Easing,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  useWindowDimensions,
  View,
  ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  BackendAttachment,
  BackendConversation,
  BackendMessage,
  BackendProfile,
  BackendReplyPreview,
  BackendStatus,
} from "@/features/chats/backendTypes";
import {
  attachmentFromMessage,
  formatBytes,
  formatDurationMs,
  messagePreviewText,
} from "@/features/chats/messageUtils";
import { messengerApi } from "@/lib/messengerApi";
import {
  clearTaskManagerAdminSession,
  loadTaskManagerAdminSession,
  saveTaskManagerAdminSession,
  TASK_MANAGER_EMPLOYEE_ROLES,
  taskManagerAdminApi,
  type TaskManagerAdminSession,
  type TaskManagerAdminSummary,
  type TaskManagerAdminTask,
  type TaskManagerAdminUser,
  type TaskManagerChatMessage,
  type TaskManagerDepartment,
  type TaskManagerDepartmentDetails,
} from "@/lib/taskManagerAdminApi";
import {
  applySavedContactNamesToConversations,
  completeQueuedMessage,
  enqueueOutgoingMessage,
  failQueuedMessage,
  listQueuedOutgoingMessages,
  markCachedMessageFailed,
  markQueuedMessageSending,
  readCachedBootstrap,
  readCachedMessages,
  replaceCachedMessage,
  upsertCachedMessage,
  writeBootstrapCache,
  writeConversationMessages,
  type QueuedOutgoingMessage,
} from "@/lib/localChatCache";
import { hapticMessageReceived, hapticMessageSent } from "@/lib/haptics";
import { orbitaAudioWaveform } from "orbita-audio-waveform";
import { normalizePhone } from "@/lib/phone";
import {
  hasSupabaseConfig,
  signInWithDevOtpBypass,
  signInWithPhone,
  supabase,
  verifyPhoneOtp,
} from "@/lib/supabase";
import { subscribeMessengerRealtime } from "@/lib/messengerRealtime";
import {
  extractConversationIdFromNotificationData,
  registerForPushNotifications,
  setForegroundNotificationContext,
} from "@/lib/notifications";
import { colors, radii, shadow } from "@/theme/colors";

type Tab = "chats" | "status" | "contacts" | "calls" | "settings" | "admin";
type AuthMode = "signin" | "signup";
type AppThemeMode = "light" | "dark";
type AccentThemeId = "green" | "blue" | "purple" | "rose" | "amber";
type ChatMessage = BackendMessage & { localState?: "sending" | "queued" | "failed" };
type MessageActionAnchor = {
  height: number;
  mine: boolean;
  width: number;
  x: number;
  y: number;
};
type MessageActionTarget = { anchor?: MessageActionAnchor; message: ChatMessage } | null;
type TypingParticipant = {
  displayName: string;
  expiresAt: number;
  userId: string;
};
type TypingBroadcastPayload = {
  conversationId?: string;
  displayName?: string;
  event?: "start" | "stop";
  sentAt?: string;
  userId?: string;
};
type ComposerAttachment = {
  localId: string;
  kind: BackendAttachment["kind"];
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes?: number | null;
  durationMs?: number | null;
  waveformSamples?: number[] | null;
};
type ForwardTarget = {
  avatarUrl?: string | null;
  id: string;
  isBot?: boolean;
  type: "conversation" | "contact";
  title: string;
  subtitle: string;
};
type VoiceRecordingBackend = "expo" | "native";
type ChatListContact = BackendProfile & { existingConversationId?: string };
type UnsavedPeer = {
  defaultName: string;
  phone: string;
};
type AdminSectionId = "overview" | "employees" | "departments" | "tasks" | "chats" | "reports" | "settings";

const KEYBOARD_COMPOSER_GAP = 18;
const KEYBOARD_SAFETY_GAP = Platform.OS === "android" ? 34 : 14;
const EDGE_SWIPE_WIDTH = 34;
const EDGE_SWIPE_TRIGGER = 72;
const EDGE_SWIPE_VERTICAL_LIMIT = 64;
const MESSAGE_RECONCILE_WINDOW_MS = 12_000;
const TYPING_REFRESH_MS = 2_400;
const TYPING_IDLE_MS = 1_900;
const TYPING_EXPIRE_MS = 4_800;
const AGENT_THINKING_POLL_MS = 3_500;
const AGENT_THINKING_TIMEOUT_MS = 45_000;
const AGENT_FOLLOW_LATEST_MS = 90_000;
const CHAT_PAGE_SIZE = 24;
const VOICE_WAVEFORM_BARS = 48;
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};
const tabs: Array<{ id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { id: "chats", label: "Chats", icon: "chatbubbles-outline" },
  { id: "admin", label: "Admin", icon: "briefcase-outline" },
  { id: "contacts", label: "Contacts", icon: "people-outline" },
  { id: "settings", label: "Settings", icon: "settings-outline" },
];

const DEV_BYPASS_OTP = "123456";
const DEV_OTP_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_ENABLE_DEV_OTP === "1";
const OTP_RESEND_SECONDS = 45;
const OTP_SIGNUP_BLOCKED_PATTERN = /signups?\s+not\s+allowed\s+for\s+otp/i;
const OTP_USER_EXISTS_PATTERN = /(?:user|phone).*(?:already|exists|registered)|(?:already|exists|registered).*(?:user|phone)/i;
const THEME_STORAGE_KEY = "orbita.themeMode";
const ACCENT_THEME_STORAGE_KEY = "orbita.accentTheme";
const MESSAGE_ACTION_MENU_WIDTH = 176;
const MESSAGE_ACTION_MENU_HEIGHT = 92;
const MESSAGE_ACTION_MENU_GAP = 6;
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

const ACCENT_THEMES: Array<{
  id: AccentThemeId;
  label: string;
  primary: string;
  primaryDark: string;
  primarySoft: string;
  accent: string;
  accentSoft: string;
  bubbleMine: string;
  darkBubbleMine: string;
  darkAccentSoft: string;
}> = [
  {
    id: "green",
    label: "Orbita green",
    primary: "#00A884",
    primaryDark: "#008069",
    primarySoft: "#D9FDD3",
    accent: "#06CF9C",
    accentSoft: "#E7FCE3",
    bubbleMine: "#D9FDD3",
    darkBubbleMine: "#005C4B",
    darkAccentSoft: "rgba(6,207,156,0.12)",
  },
  {
    id: "blue",
    label: "Signal blue",
    primary: "#2563EB",
    primaryDark: "#1D4ED8",
    primarySoft: "#DBEAFE",
    accent: "#38BDF8",
    accentSoft: "#E0F2FE",
    bubbleMine: "#DBEAFE",
    darkBubbleMine: "#1E3A8A",
    darkAccentSoft: "rgba(56,189,248,0.15)",
  },
  {
    id: "purple",
    label: "Cosmic violet",
    primary: "#8B5CF6",
    primaryDark: "#6D28D9",
    primarySoft: "#EDE9FE",
    accent: "#C084FC",
    accentSoft: "#F3E8FF",
    bubbleMine: "#EDE9FE",
    darkBubbleMine: "#4C1D95",
    darkAccentSoft: "rgba(192,132,252,0.16)",
  },
  {
    id: "rose",
    label: "Rose coral",
    primary: "#F43F5E",
    primaryDark: "#BE123C",
    primarySoft: "#FFE4E6",
    accent: "#FB7185",
    accentSoft: "#FFF1F2",
    bubbleMine: "#FFE4E6",
    darkBubbleMine: "#881337",
    darkAccentSoft: "rgba(251,113,133,0.16)",
  },
  {
    id: "amber",
    label: "Amber gold",
    primary: "#F59E0B",
    primaryDark: "#B45309",
    primarySoft: "#FEF3C7",
    accent: "#FBBF24",
    accentSoft: "#FFFBEB",
    bubbleMine: "#FEF3C7",
    darkBubbleMine: "#78350F",
    darkAccentSoft: "rgba(251,191,36,0.16)",
  },
];
const AGENT_QUICK_PROMPTS: Array<{ id: string; label: string; prompt: string }> = [
  {
    id: "team_overdue_widget",
    label: "My Team - Overdue Tasks",
    prompt:
      'Create and send me a secure magic link widget titled "My Team - Overdue Tasks". ' +
      "For everyone reporting to me, show overdue tasks first (with due date and overdue duration if any), then in-progress tasks, then recent completed tasks. " +
      "Keep the layout compact and mobile-friendly.",
  },
  {
    id: "team_status_snapshot",
    label: "Team Status Snapshot",
    prompt:
      "Share a team snapshot for people reporting to me: overdue tasks, in-progress tasks, and last completed tasks. " +
      "Prefer a secure widget link I can open.",
  },
  {
    id: "overdue_only",
    label: "Only Overdue Items",
    prompt:
      "List overdue tasks for people reporting to me with due date and overdue duration for each task.",
  },
];

if (Platform.OS === "android") {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

function animateNextListLayout() {
  LayoutAnimation.configureNext(
    LayoutAnimation.create(180, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
  );
}

function isActiveTaskThreadStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return !normalized || normalized === "open" || normalized === "active" || normalized === "in_progress";
}

function isCompletedTaskThreadStatus(status?: string | null) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "done" || normalized === "completed" || normalized === "closed" || normalized === "discarded";
}

function taskThreadStatusLabel(status?: string | null) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "done" || normalized === "completed") return "completed";
  if (normalized === "discarded" || normalized === "closed") return "closed";
  return normalized.replace("_", " ");
}

function taskThreadArchiveTitle(status?: string | null) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "done" || normalized === "completed") return "Task completed";
  return "Task closed";
}

type AppThemeContextValue = {
  accentTheme: AccentThemeId;
  accentThemes: typeof ACCENT_THEMES;
  isDarkTheme: boolean;
  setAccentTheme: (theme: AccentThemeId) => void;
  setThemeMode: (mode: AppThemeMode) => void;
  themeColors: (typeof ACCENT_THEMES)[number];
  themeMode: AppThemeMode;
  toggleTheme: () => void;
};

const AppThemeContext = createContext<AppThemeContextValue>({
  accentTheme: "green",
  accentThemes: ACCENT_THEMES,
  isDarkTheme: false,
  setAccentTheme: () => undefined,
  setThemeMode: () => undefined,
  themeColors: ACCENT_THEMES[0],
  themeMode: "light",
  toggleTheme: () => undefined,
});

function useAppTheme() {
  return useContext(AppThemeContext);
}

function usePersistedTheme() {
  const [themeMode, setThemeModeState] = useState<AppThemeMode>("light");
  const [accentTheme, setAccentThemeState] = useState<AccentThemeId>("green");
  const isDarkTheme = themeMode === "dark";
  const themeColors = ACCENT_THEMES.find((item) => item.id === accentTheme) ?? ACCENT_THEMES[0];

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(THEME_STORAGE_KEY),
      AsyncStorage.getItem(ACCENT_THEME_STORAGE_KEY),
    ])
      .then(([savedTheme, savedAccentTheme]) => {
        if (savedTheme === "light" || savedTheme === "dark") {
          setThemeModeState(savedTheme);
        }
        if (ACCENT_THEMES.some((item) => item.id === savedAccentTheme)) {
          setAccentThemeState(savedAccentTheme as AccentThemeId);
        }
      })
      .catch(() => undefined);
  }, []);

  const setAccentTheme = useCallback((theme: AccentThemeId) => {
    setAccentThemeState(theme);
    void AsyncStorage.setItem(ACCENT_THEME_STORAGE_KEY, theme).catch(() => undefined);
  }, []);

  const setThemeMode = useCallback((mode: AppThemeMode) => {
    setThemeModeState(mode);
    void AsyncStorage.setItem(THEME_STORAGE_KEY, mode).catch(() => undefined);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeMode(themeMode === "dark" ? "light" : "dark");
  }, [setThemeMode, themeMode]);

  return useMemo<AppThemeContextValue>(
    () => ({
      accentTheme,
      accentThemes: ACCENT_THEMES,
      isDarkTheme,
      setAccentTheme,
      setThemeMode,
      themeColors,
      themeMode,
      toggleTheme,
    }),
    [accentTheme, isDarkTheme, setAccentTheme, setThemeMode, themeColors, themeMode, toggleTheme],
  );
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function appVersionLabel() {
  const version =
    Constants.nativeAppVersion ??
    Constants.expoConfig?.version ??
    "0.1.0";
  const build = Constants.nativeBuildVersion ?? Constants.expoConfig?.android?.versionCode?.toString();
  return build ? `Version ${version} (build ${build})` : `Version ${version}`;
}

function defaultDueDateParts() {
  const due = new Date();
  due.setHours(18, 0, 0, 0);
  const yyyy = String(due.getFullYear());
  const mm = String(due.getMonth() + 1).padStart(2, "0");
  const dd = String(due.getDate()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: "6:00 PM" };
}

function dueDatePartsToIso(datePart: string, timePart: string) {
  if (!datePart) return null;
  const time = parseTwelveHourTime(timePart) ?? { hours: 18, minutes: 0 };
  const hours = String(time.hours).padStart(2, "0");
  const minutes = String(time.minutes).padStart(2, "0");
  const date = new Date(`${datePart}T${hours}:${minutes}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseTwelveHourTime(value: string): { hours: number; minutes: number } | null {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isInteger(hour) || hour < 1 || hour > 12 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  const meridiem = match[3]?.toLowerCase();
  return {
    hours: meridiem === "pm" ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour,
    minutes: minute,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeWaveSamples(samples?: number[] | null, targetCount = 22) {
  const source = samples?.filter((sample) => Number.isFinite(sample)) ?? [];
  if (!source.length) return [];

  const resampled: number[] = [];
  for (let index = 0; index < targetCount; index += 1) {
    const position = (index / Math.max(1, targetCount - 1)) * (source.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(source.length - 1, Math.ceil(position));
    const progress = position - lowerIndex;
    const lower = source[lowerIndex] ?? 0;
    const upper = source[upperIndex] ?? lower;
    resampled.push(lower + (upper - lower) * progress);
  }

  const min = Math.min(...resampled);
  const max = Math.max(...resampled);
  if (max - min < 0.004) return [];
  const range = Math.max(0.015, max - min);
  return resampled.map((sample) => clamp(0.1 + ((sample - min) / range) * 0.9, 0.08, 1));
}

function meteringToWaveLevel(metering?: number) {
  if (!Number.isFinite(metering)) return 0.08;
  const normalized = ((metering ?? -70) + 62) / 62;
  return clamp(0.08 + normalized * normalized * 0.92, 0.08, 1);
}

function expoVoiceMimeType(uri?: string | null) {
  const normalized = uri?.toLowerCase() ?? "";
  if (normalized.endsWith(".m4a")) return "audio/mp4";
  if (normalized.endsWith(".aac")) return "audio/aac";
  if (normalized.endsWith(".3gp")) return "audio/3gpp";
  if (normalized.endsWith(".webm")) return "audio/webm";
  return Platform.OS === "web" ? "audio/webm" : "audio/mp4";
}

function expoVoiceExtension(mimeType: string) {
  if (mimeType === "audio/webm") return ".webm";
  if (mimeType === "audio/aac") return ".aac";
  if (mimeType === "audio/3gpp") return ".3gp";
  return ".m4a";
}

function getFriendlyOtpRequestRecovery(
  message: string,
  authMode: AuthMode,
): { message: string; nextMode?: AuthMode } | null {
  if (authMode === "signin" && OTP_SIGNUP_BLOCKED_PATTERN.test(message)) {
    return {
      message: "No Orbita account exists for this phone yet. Enter your name and tap Create account to get started.",
      nextMode: "signup",
    };
  }

  if (authMode === "signup" && OTP_USER_EXISTS_PATTERN.test(message)) {
    return {
      message: "An Orbita account already exists for this phone. Sign in with OTP to continue.",
      nextMode: "signin",
    };
  }

  return null;
}

function waveLevelToBarHeight(level: number, minHeight = 9, maxHeight = 30) {
  return minHeight + Math.round(clamp(level, 0.08, 1) * (maxHeight - minHeight));
}

function mergeAttachmentWaveforms(serverMessage: BackendMessage, localMessage?: BackendMessage | null): BackendMessage {
  const mergedMessage: BackendMessage = localMessage
    ? {
        ...serverMessage,
        clientMessageId: serverMessage.clientMessageId ?? localMessage.clientMessageId ?? null,
        forwardedFrom: serverMessage.forwardedFrom ?? localMessage.forwardedFrom ?? null,
        replyTo: serverMessage.replyTo ?? localMessage.replyTo ?? null,
        replyToMessageId: serverMessage.replyToMessageId ?? localMessage.replyToMessageId ?? null,
      }
    : serverMessage;
  if (!localMessage?.attachments?.length || !serverMessage.attachments.length) return mergedMessage;
  const localAttachment = localMessage.attachments[0];
  const serverAttachment = serverMessage.attachments[0];
  if (serverAttachment.waveformSamples?.length || !localAttachment.waveformSamples?.length) return mergedMessage;
  return {
    ...mergedMessage,
    attachments: [
      {
        ...serverAttachment,
        waveformSamples: localAttachment.waveformSamples,
      },
      ...serverMessage.attachments.slice(1),
    ],
  };
}

function normalizeUrl(url: string) {
  return url.startsWith("www.") ? `https://${url}` : url;
}

function splitTrailingPunctuation(url: string) {
  const match = url.match(/^(.+?)([.,!?;:]+)?$/);
  return {
    cleanUrl: match?.[1] ?? url,
    trailing: match?.[2] ?? "",
  };
}

function openMessageUrl(url: string) {
  void Linking.openURL(normalizeUrl(url)).catch(() => undefined);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageSignature(message: Pick<BackendMessage, "senderId" | "body" | "kind" | "attachments">) {
  const attachment = message.attachments?.[0];
  const attachmentKey = attachment ? `${attachment.kind}:${attachment.filename}` : "";
  return `${message.senderId}::${message.kind}::${message.body.trim().toLowerCase()}::${attachmentKey}`;
}

function isSameLocalAndServerMessage(localMessage: ChatMessage, serverMessage: BackendMessage) {
  if (
    localMessage.localState &&
    serverMessage.clientMessageId &&
    localMessage.id === serverMessage.clientMessageId
  ) {
    return true;
  }
  if (localMessage.senderId !== serverMessage.senderId) return false;
  if (messageSignature(localMessage) !== messageSignature(serverMessage)) return false;
  return Math.abs(Date.parse(localMessage.createdAt) - Date.parse(serverMessage.createdAt)) <= MESSAGE_RECONCILE_WINDOW_MS;
}

function isTaskManagerAgentConversation(conversation: BackendConversation) {
  return conversation.participants.some((participant) => participant.about?.trim().toLowerCase() === "task manager agent");
}

function isAgentProgressMessage(message: Pick<BackendMessage, "attachments" | "body">) {
  if (message.attachments?.length) return false;
  const normalized = message.body
    .trim()
    .toLowerCase()
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80) return false;
  const compact = normalized.replace(/[.!?\s]+$/g, "");
  return (
    [
      "on it",
      "working on it",
      "working on that",
      "processing",
      "give me a moment",
      "one moment",
      "just a moment",
      "let me check",
    ].includes(compact) ||
    /^(got it|sure|okay|ok)[, -]+(one moment|checking|let me check)$/.test(compact)
  );
}

function userFacingTaskManagerError(reason?: string) {
  const normalized = (reason ?? "").trim().toLowerCase();
  if (normalized.includes("conversation is not linked to task manager")) {
    return "Your account is not linked by admin yet.";
  }
  return reason || "Unable to reach Task Manager agent right now.";
}

function shortDisplayName(name: string) {
  return name.trim().split(/\s+/)[0] || name.trim() || "Someone";
}

function typingDisplayName(name: string) {
  const trimmed = name.trim();
  if (/^\+?[\d\s().-]{6,}$/.test(trimmed)) return trimmed;
  return shortDisplayName(trimmed);
}

function typingStatusText(participants: TypingParticipant[]) {
  if (!participants.length) return "";
  const names = participants.map((participant) => typingDisplayName(participant.displayName));
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are typing...`;
}

function messageDateKey(iso: string) {
  return new Date(iso).toDateString();
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function messageDateLabel(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const dayDelta = Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000);
  if (dayDelta === 0) return "Today";
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta > 1 && dayDelta < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function conversationFallbackPreview(conversation: BackendConversation) {
  const humanMemberCount = conversation.participants.filter(
    (participant) => participant.about?.trim().toLowerCase() !== "task manager agent",
  ).length;
  if (conversation.taskThread) {
    return `${humanMemberCount} task member${humanMemberCount === 1 ? "" : "s"}`;
  }
  if (conversation.kind === "direct") return "1:1 conversation";
  return `${humanMemberCount} member${humanMemberCount === 1 ? "" : "s"}`;
}

function conversationSubtitle(conversation: BackendConversation) {
  const humanMemberCount = conversation.participants.filter(
    (participant) => participant.about?.trim().toLowerCase() !== "task manager agent",
  ).length;
  if (conversation.taskThread) {
    return `${humanMemberCount} task member${humanMemberCount === 1 ? "" : "s"}`;
  }
  if (conversation.kind === "group") {
    return `${humanMemberCount} member${humanMemberCount === 1 ? "" : "s"}`;
  }
  return "Direct message";
}

function participantDisplayName(conversation: BackendConversation, userId: string, currentUserId: string) {
  if (userId === currentUserId) return "You";
  return conversation.participants.find((participant) => participant.id === userId)?.displayName ?? "Member";
}

function buildReplyPreviewFromMessage(message: BackendMessage): BackendReplyPreview {
  return {
    messageId: message.id,
    senderId: message.senderId,
    body: messagePreviewText(message).slice(0, 180),
    kind: message.kind,
  };
}

function replyPreviewText(reply: BackendReplyPreview | null | undefined) {
  if (!reply) return "";
  const text = reply.body.trim();
  if (text) return text;
  if (reply.kind === "image") return "Photo";
  if (reply.kind === "voice" || reply.kind === "audio") return "Voice note";
  if (reply.kind === "document") return "Document";
  return "Message";
}

function taskManagerReplyText(reply: BackendReplyPreview | null, messageText: string) {
  const quote = replyPreviewText(reply);
  return quote ? `[Replying to quoted message: ${quote}]\n${messageText}` : messageText;
}

function hasOrbitaMention(text: string) {
  return /(^|[\s([{"'`])@orbita\b/i.test(text);
}

function isTaskConversation(conversation: BackendConversation) {
  return Boolean(conversation.taskThread);
}

function shouldExpectTaskManagerAgentReply(conversation: BackendConversation, text: string) {
  if (!isTaskManagerAgentConversation(conversation)) return false;
  return !isTaskConversation(conversation) || hasOrbitaMention(text);
}

function orbitaMentionQuery(text: string) {
  const match = text.match(/(?:^|\s)@([a-z0-9_]*)$/i);
  if (!match) return null;
  const query = match[1] ?? "";
  return "orbita".startsWith(query.toLowerCase()) ? query : null;
}

function insertOrbitaMention(text: string) {
  if (/(?:^|\s)@[a-z0-9_]*$/i.test(text)) {
    return text.replace(/(^|\s)@[a-z0-9_]*$/i, (_match, prefix) => `${prefix}@orbita `);
  }
  return `${text}${text && !/\s$/.test(text) ? " " : ""}@orbita `;
}

function shouldShowSenderIdentity(conversation: BackendConversation) {
  return conversation.kind === "group" || isTaskConversation(conversation);
}

function peerLabel(profile: BackendProfile) {
  return profile.phone || profile.displayName || "Orbita user";
}

function searchableText(values: Array<string | null | undefined>) {
  return values.filter(Boolean).join(" ").trim().toLowerCase();
}

function keyboardClearance(height?: number, bottomInset = 0, keyboardTop?: number, windowHeight?: number) {
  const keyboardHeight = Math.max(0, Math.round(height ?? 0));
  const hasKeyboardTop = typeof keyboardTop === "number" && keyboardTop > 0 && typeof windowHeight === "number";
  const overlap =
    hasKeyboardTop
      ? Math.max(0, Math.round(windowHeight - keyboardTop))
      : 0;
  const neededClearance = hasKeyboardTop ? overlap : keyboardHeight;
  if (!neededClearance) return 0;
  return neededClearance + bottomInset + KEYBOARD_SAFETY_GAP;
}

function useKeyboardClearance(enabled = true) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [clearance, setClearance] = useState(0);

  useEffect(() => {
    if (!enabled || Platform.OS === "web") {
      setClearance(0);
      return undefined;
    }

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setClearance(keyboardClearance(event.endCoordinates.height, insets.bottom, event.endCoordinates.screenY, height));
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => setClearance(0));

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [enabled, height, insets.bottom]);

  return clearance;
}

function mergeMessages(incoming: BackendMessage[], local: ChatMessage[]) {
  const pending = local.filter((message) => message.localState);
  const localById = new Map(local.map((message) => [message.id, message]));
  const localByClientId = new Map(
    local
      .filter((message) => message.clientMessageId)
      .map((message) => [message.clientMessageId as string, message]),
  );
  const stable = incoming.map((incomingMessage) => {
    const localMatch =
      localById.get(incomingMessage.id) ||
      (incomingMessage.clientMessageId ? localByClientId.get(incomingMessage.clientMessageId) : undefined);
    return localMatch ? mergeMessagePayload(localMatch, incomingMessage) : incomingMessage;
  });
  const stableById = new Set(stable.map((message) => message.id));

  pending.forEach((pendingMessage) => {
    if (stableById.has(pendingMessage.id)) return;
    const match = stable.some((serverMessage) => isSameLocalAndServerMessage(pendingMessage, serverMessage));
    if (!match) stable.push(pendingMessage);
  });

  stable.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return stable;
}

function mergeMessagePayload(existing: ChatMessage, incoming: BackendMessage): BackendMessage {
  return {
    ...incoming,
    attachments: incoming.attachments.length ? incoming.attachments : existing.attachments,
    clientMessageId: incoming.clientMessageId ?? existing.clientMessageId ?? null,
    forwardedFrom: incoming.forwardedFrom ?? existing.forwardedFrom ?? null,
    replyTo: incoming.replyTo ?? existing.replyTo ?? null,
    replyToMessageId: incoming.replyToMessageId ?? existing.replyToMessageId ?? null,
    status: incoming.status ?? existing.status,
  };
}

function upsertMessage(messages: ChatMessage[], incoming: BackendMessage): ChatMessage[] {
  const existingById = messages.find((message) => message.id === incoming.id);
  if (existingById) {
    const mergedIncoming = mergeMessagePayload(existingById, incoming);
    return messages
      .map((message) => (message.id === incoming.id ? mergedIncoming : message))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  const withoutDuplicate = messages;
  const matchingLocal = withoutDuplicate.find((message) => {
    if (!message.localState) return false;
    return isSameLocalAndServerMessage(message, incoming);
  });
  const mergedIncoming = matchingLocal ? mergeMessagePayload(matchingLocal, incoming) : incoming;
  const next = matchingLocal
    ? withoutDuplicate.map((message) => (message.id === matchingLocal.id ? mergedIncoming : message))
    : [...withoutDuplicate, mergedIncoming];

  return next.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function isNetworkSendError(error: unknown) {
  if (Platform.OS !== "web") return false;
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (!(error instanceof Error)) return false;
  return /abort|failed to fetch|network|timeout|load failed/i.test(error.message);
}

function createLocalMessageId() {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local-${random}`;
}

function OrbitaLogo({ size = 64 }: { size?: number }) {
  const { themeColors } = useAppTheme();
  const scan = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const glint = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const scanLoop = Animated.loop(
      Animated.timing(scan, {
        toValue: 1,
        duration: 1800,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.05, duration: 980, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 980, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    const glintLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glint, { toValue: 1, duration: 1200, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(glint, { toValue: 0, duration: 900, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    scanLoop.start();
    pulseLoop.start();
    glintLoop.start();
    return () => {
      scanLoop.stop();
      pulseLoop.stop();
      glintLoop.stop();
    };
  }, [glint, pulse, scan]);

  const scanTranslate = scan.interpolate({ inputRange: [0, 1], outputRange: [-size * 0.42, size * 0.42] });
  const glintOpacity = glint.interpolate({ inputRange: [0, 0.45, 1], outputRange: [0.25, 1, 0.35] });

  return (
    <Animated.View style={[styles.logoFrame, { backgroundColor: themeColors.primaryDark, width: size, height: size, borderRadius: size * 0.28, transform: [{ scale: pulse }] }]}>
      <View style={[styles.logoCore, { backgroundColor: themeColors.primary, width: size * 0.72, height: size * 0.72, borderRadius: size * 0.2 }]} />
      <View style={[styles.logoNode, styles.logoNodeTop, { backgroundColor: themeColors.accent, width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08 }]} />
      <View style={[styles.logoNode, styles.logoNodeLeft, { backgroundColor: themeColors.accent, width: size * 0.13, height: size * 0.13, borderRadius: size * 0.065 }]} />
      <View style={[styles.logoNode, styles.logoNodeRight, { backgroundColor: themeColors.accent, width: size * 0.12, height: size * 0.12, borderRadius: size * 0.06 }]} />
      <View style={[styles.logoSignal, { backgroundColor: themeColors.primarySoft, width: size * 0.5, top: size * 0.32 }]} />
      <View style={[styles.logoSignal, { backgroundColor: themeColors.primarySoft, width: size * 0.38, top: size * 0.48 }]} />
      <Animated.View
        style={[
          styles.logoScan,
          {
            backgroundColor: themeColors.accent,
            height: size * 0.78,
            opacity: glintOpacity,
            transform: [{ translateX: scanTranslate }, { rotate: "18deg" }],
          },
        ]}
      />
      <Ionicons color="#FFFFFF" name="sparkles" size={Math.max(22, size * 0.38)} />
    </Animated.View>
  );
}

function OrbitaBrand({ compact, inverse }: { compact?: boolean; inverse?: boolean }) {
  return (
    <View style={styles.brandRow}>
      <OrbitaLogo size={compact ? 40 : 48} />
      <View>
        <Text style={[styles.brandTitle, compact && styles.brandTitleCompact, inverse && styles.brandTitleInverse]}>Orbita</Text>
        {!compact ? <Text style={[styles.brandTagline, inverse && styles.brandTaglineInverse]}>AI-native messaging</Text> : null}
      </View>
    </View>
  );
}

function AuthSignalScene({ inline = false }: { inline?: boolean }) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const float = useRef(new Animated.Value(0)).current;
  const scan = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    const scanLoop = Animated.loop(
      Animated.timing(scan, { toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: true }),
    );
    floatLoop.start();
    scanLoop.start();
    return () => {
      floatLoop.stop();
      scanLoop.stop();
    };
  }, [float, scan]);

  const drift = float.interpolate({ inputRange: [0, 1], outputRange: [0, -10] });
  const scanY = scan.interpolate({ inputRange: [0, 1], outputRange: [-18, 160] });
  const nodePulse = float.interpolate({ inputRange: [0, 1], outputRange: [0.68, 1] });

  return (
    <View pointerEvents="none" style={[styles.authSignalScene, inline && styles.authSignalSceneInline]}>
      <Animated.View style={[styles.authSignalCore, !isDarkTheme && styles.authSignalCoreLight, { transform: [{ translateY: drift }] }]}>
        <OrbitaLogo size={82} />
        <Animated.View style={[styles.authScanLine, !isDarkTheme && styles.authScanLineLight, { backgroundColor: themeColors.accent, transform: [{ translateY: scanY }] }]} />
        <Animated.View style={[styles.authNode, !isDarkTheme && styles.authNodeLight, styles.authNodeOne, { backgroundColor: themeColors.primary, opacity: nodePulse }]} />
        <Animated.View style={[styles.authNode, styles.authNodeTwo, !isDarkTheme && styles.authNodeTwoLight, { backgroundColor: themeColors.accent, opacity: nodePulse }]} />
        <Animated.View style={[styles.authNode, styles.authNodeThree, !isDarkTheme && styles.authNodeThreeLight, { backgroundColor: themeColors.primaryDark, opacity: nodePulse }]} />
        <View style={[styles.authTrace, !isDarkTheme && styles.authTraceLight, styles.authTraceOne]} />
        <View style={[styles.authTrace, !isDarkTheme && styles.authTraceLight, styles.authTraceTwo]} />
        <View style={[styles.authTrace, !isDarkTheme && styles.authTraceLight, styles.authTraceThree]} />
      </Animated.View>
    </View>
  );
}

function Avatar({
  avatarUrl,
  isBot = false,
  name,
  size = 46,
}: {
  avatarUrl?: string | null;
  isBot?: boolean;
  name: string;
  size?: number;
}) {
  const { themeColors } = useAppTheme();
  const [failed, setFailed] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);
  useEffect(() => {
    if (!isBot) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 920, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 920, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isBot, pulse]);

  const hasImage = Boolean(avatarUrl) && !failed;
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.62, 0.2] });
  return (
    <View style={[styles.avatarWrap, { width: size, height: size }]}>
      {isBot ? (
        <>
          <Animated.View
            style={[
              styles.botAvatarPulse,
              {
                width: size + 8,
                height: size + 8,
                borderRadius: (size + 8) / 2,
                borderColor: themeColors.primary,
                backgroundColor: themeColors.darkAccentSoft,
                opacity: pulseOpacity,
                transform: [{ scale: pulseScale }],
              },
            ]}
          />
          <View style={[styles.botAvatarRing, { borderColor: themeColors.accent, width: size + 4, height: size + 4, borderRadius: (size + 4) / 2 }]} />
        </>
      ) : null}
      <View style={[styles.avatar, { backgroundColor: themeColors.primary, width: size, height: size, borderRadius: size / 2 }]}>
      {hasImage ? (
        <Image
          source={{ uri: avatarUrl! }}
          onError={() => setFailed(true)}
          style={[styles.avatarImage, { width: size, height: size, borderRadius: size / 2 }]}
        />
      ) : isBot ? (
        <View style={[styles.botAvatarFace, { borderColor: themeColors.primarySoft }]}>
          <View style={styles.botAvatarEyeRow}>
            <View style={[styles.botAvatarEye, { backgroundColor: themeColors.primaryDark }]} />
            <View style={[styles.botAvatarEye, { backgroundColor: themeColors.primaryDark }]} />
          </View>
          <View style={[styles.botAvatarMouth, { backgroundColor: themeColors.primary }]} />
          <View style={[styles.botAvatarChip, { backgroundColor: themeColors.accent, borderColor: themeColors.primarySoft }]}>
            <Ionicons color={themeColors.primaryDark} name="sparkles" size={9} />
          </View>
        </View>
      ) : (
        <Text style={[styles.avatarText, { fontSize: size > 52 ? 20 : 15 }]}>{initials(name || "U")}</Text>
      )}
      </View>
    </View>
  );
}

function SkeletonBlock({ style }: { style?: StyleProp<ViewStyle> }) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const opacity = useRef(new Animated.Value(0.42)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.86, duration: 760, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.42, duration: 760, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.View style={[styles.skeletonBlock, isDarkTheme && styles.skeletonBlockDark, style, { opacity }]} />;
}

function ChatRowsSkeleton({ count = 5 }: { count?: number }) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <View key={index} style={[styles.chatRow, isDarkTheme && styles.chatRowDark]}>
          <SkeletonBlock style={styles.skeletonAvatar} />
          <View style={styles.chatListRowBody}>
            <View style={styles.chatListTextColumn}>
              <SkeletonBlock style={styles.skeletonTitle} />
              <SkeletonBlock style={[styles.skeletonLine, index % 2 === 0 ? styles.skeletonLineLong : styles.skeletonLineMid]} />
            </View>
            <View style={styles.chatListMetaColumn}>
              <SkeletonBlock style={styles.skeletonTime} />
              <SkeletonBlock style={styles.skeletonUnreadBadge} />
            </View>
          </View>
        </View>
      ))}
    </>
  );
}

function MessageListSkeleton() {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <>
      <View style={[styles.messageWrap, styles.messageTheirs]}>
        <View style={[styles.skeletonBubble, styles.skeletonBubbleIncoming, isDarkTheme && styles.skeletonBubbleIncomingDark]}>
          <SkeletonBlock style={styles.skeletonMessageLineWide} />
          <SkeletonBlock style={styles.skeletonMessageLineMid} />
        </View>
      </View>
      <View style={[styles.messageWrap, styles.messageMine]}>
        <View style={[styles.skeletonBubble, styles.skeletonBubbleOutgoing, isDarkTheme && styles.skeletonBubbleOutgoingDark]}>
          <SkeletonBlock style={styles.skeletonMessageLineWide} />
          <SkeletonBlock style={styles.skeletonMessageLineShort} />
        </View>
      </View>
      <View style={[styles.messageWrap, styles.messageTheirs]}>
        <View style={[styles.skeletonBubble, styles.skeletonBubbleIncoming, isDarkTheme && styles.skeletonBubbleIncomingDark]}>
          <SkeletonBlock style={styles.skeletonMessageLineMid} />
          <SkeletonBlock style={styles.skeletonMedia} />
        </View>
      </View>
      <View style={[styles.messageWrap, styles.messageMine]}>
        <View style={[styles.skeletonBubble, styles.skeletonBubbleOutgoing, isDarkTheme && styles.skeletonBubbleOutgoingDark]}>
          <SkeletonBlock style={styles.skeletonMessageLineShort} />
        </View>
      </View>
    </>
  );
}

function MessageBody({ mine, text }: { mine: boolean; text: string }) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <Text
      style={[
        styles.messageText,
        isDarkTheme && !mine && styles.messageTextDark,
        mine && (isDarkTheme ? styles.messageTextMineDark : styles.messageTextMine),
      ]}
    >
      {renderMessageInline(text, mine, isDarkTheme, "message")}
    </Text>
  );
}

function SwipeableMessageBubble({
  children,
  message,
  mine,
  onActions,
  onReply,
  themeColors,
}: {
  children: ReactNode;
  message: ChatMessage;
  mine: boolean;
  onActions: (target: NonNullable<MessageActionTarget>) => void;
  onReply: () => void;
  themeColors: (typeof ACCENT_THEMES)[number];
}) {
  const { isDarkTheme } = useAppTheme();
  const [hovered, setHovered] = useState(false);
  const frameRef = useRef<View | null>(null);
  const translateX = useRef(new Animated.Value(0)).current;
  const replyTriggeredRef = useRef(false);
  const openActions = useCallback(() => {
    const fallback = () => onActions({ message });
    const frame = frameRef.current;
    if (!frame?.measureInWindow) {
      fallback();
      return;
    }
    frame.measureInWindow((x, y, width, height) => {
      onActions({ anchor: { height, mine, width, x, y }, message });
    });
  }, [message, mine, onActions]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) => {
          const mostlyHorizontal = Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.35;
          const correctDirection = mine ? gestureState.dx < -12 : gestureState.dx > 12;
          return mostlyHorizontal && correctDirection;
        },
        onPanResponderMove: (_event, gestureState) => {
          const x = mine ? clamp(gestureState.dx, -58, 0) : clamp(gestureState.dx, 0, 58);
          translateX.setValue(x);
        },
        onPanResponderRelease: (_event, gestureState) => {
          const correctDistance = mine ? gestureState.dx <= -52 : gestureState.dx >= 52;
          const shouldReply = correctDistance && Math.abs(gestureState.dy) <= 38;
          Animated.spring(translateX, {
            bounciness: 5,
            speed: 18,
            toValue: 0,
            useNativeDriver: true,
          }).start();
          if (shouldReply && !replyTriggeredRef.current) {
            replyTriggeredRef.current = true;
            onReply();
            setTimeout(() => {
              replyTriggeredRef.current = false;
            }, 260);
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateX, {
            bounciness: 5,
            speed: 18,
            toValue: 0,
            useNativeDriver: true,
          }).start();
        },
        onShouldBlockNativeResponder: () => false,
      }),
    [mine, onReply, translateX],
  );
  const replyOpacity = translateX.interpolate({
    inputRange: mine ? [-58, -24, 0] : [0, 24, 58],
    outputRange: mine ? [1, 0.65, 0] : [0, 0.65, 1],
  });

  return (
    <View ref={frameRef} style={styles.swipeBubbleFrame}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.replySwipeCue,
          mine ? styles.replySwipeCueMine : styles.replySwipeCueTheirs,
          isDarkTheme && styles.replySwipeCueDark,
          { opacity: replyOpacity },
        ]}
      >
        <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="return-up-back" size={16} />
      </Animated.View>
      <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX }] }}>
        <Pressable
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onLongPress={openActions}
          style={({ pressed }) => [
            styles.bubble,
            mine ? styles.mineBubble : styles.theirBubble,
            mine && { backgroundColor: isDarkTheme ? themeColors.darkBubbleMine : themeColors.bubbleMine },
            isDarkTheme && mine && styles.mineBubbleDark,
            isDarkTheme && !mine && styles.theirBubbleDark,
            pressed && styles.bubblePressed,
          ]}
        >
          {children}
          {Platform.OS === "web" ? (
            <Pressable
              accessibilityLabel="Message actions"
              onPress={openActions}
              style={({ pressed }) => [
                styles.messageMenuButton,
                mine ? styles.messageMenuButtonMine : styles.messageMenuButtonTheirs,
                isDarkTheme && styles.messageMenuButtonDark,
                hovered && styles.messageMenuButtonVisible,
                pressed && styles.pressablePressed,
              ]}
            >
              <Ionicons color={isDarkTheme ? "rgba(233,237,239,0.88)" : colors.muted} name="chevron-down" size={16} />
            </Pressable>
          ) : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}

function MessageReplyQuote({
  mine,
  reply,
  senderName,
  themeColors,
}: {
  mine: boolean;
  reply: BackendReplyPreview;
  senderName: string;
  themeColors: (typeof ACCENT_THEMES)[number];
}) {
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[
      styles.replyQuote,
      mine && (isDarkTheme ? styles.replyQuoteMineDark : styles.replyQuoteMine),
      !mine && isDarkTheme && styles.replyQuoteDark,
    ]}>
      <View style={[styles.replyQuoteBar, { backgroundColor: mine ? themeColors.accent : themeColors.primaryDark }]} />
      <View style={styles.replyQuoteBody}>
        <Text numberOfLines={1} style={[
          styles.replyQuoteName,
          mine && (isDarkTheme ? styles.replyQuoteNameMineDark : styles.replyQuoteNameMine),
          { color: isDarkTheme && mine ? themeColors.accent : themeColors.primaryDark },
        ]}>
          {senderName}
        </Text>
        <Text numberOfLines={2} style={[styles.replyQuoteText, mine && (isDarkTheme ? styles.replyQuoteTextMineDark : styles.replyQuoteTextMine)]}>
          {replyPreviewText(reply)}
        </Text>
      </View>
    </View>
  );
}

function renderMessageInline(text: string, mine: boolean, isDarkTheme: boolean, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^)\s]+)\)|((?:https?:\/\/|www\.)[^\s<]+)/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(...renderMessageFormatting(text.slice(cursor, match.index), mine, isDarkTheme, `${keyPrefix}-text-${cursor}`));
    }

    const label = match[1] || match[3] || "";
    const rawUrl = match[2] || match[3] || "";
    const { cleanUrl, trailing } = splitTrailingPunctuation(rawUrl);
    nodes.push(
      <Text
        accessibilityRole="link"
        key={`${keyPrefix}-link-${match.index}`}
        onPress={() => openMessageUrl(cleanUrl)}
        style={[styles.messageLink, mine && (isDarkTheme ? styles.messageLinkMineDark : styles.messageLinkMine)]}
      >
        {label === rawUrl ? cleanUrl : label}
      </Text>,
    );
    if (trailing) nodes.push(<Text key={`${keyPrefix}-trail-${match.index}`}>{trailing}</Text>);
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(...renderMessageFormatting(text.slice(cursor), mine, isDarkTheme, `${keyPrefix}-text-${cursor}`));
  }

  return nodes;
}

function renderMessageFormatting(text: string, mine: boolean, isDarkTheme: boolean, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const formatPattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*\n]+)\*)|(_([^_\n]+)_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = formatPattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(...renderMessageMentions(text.slice(cursor, match.index), mine, isDarkTheme, `${keyPrefix}-plain-${cursor}`));
    }

    const code = match[2];
    const strong = match[4] || match[6];
    const emphasis = match[8] || match[10];
    if (code) {
      nodes.push(
        <Text key={`${keyPrefix}-code-${match.index}`} style={[styles.messageCode, mine && (isDarkTheme ? styles.messageCodeMineDark : styles.messageCodeMine)]}>
          {code}
        </Text>,
      );
    } else if (strong) {
      nodes.push(
        <Text key={`${keyPrefix}-strong-${match.index}`} style={styles.messageStrong}>
          {strong}
        </Text>,
      );
    } else if (emphasis) {
      nodes.push(
        <Text key={`${keyPrefix}-em-${match.index}`} style={styles.messageEmphasis}>
          {emphasis}
        </Text>,
      );
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(...renderMessageMentions(text.slice(cursor), mine, isDarkTheme, `${keyPrefix}-plain-${cursor}`));
  }
  return nodes;
}

function renderMessageMentions(text: string, mine: boolean, isDarkTheme: boolean, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const mentionPattern = /@orbita\b/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    nodes.push(
      <Text
        key={`${keyPrefix}-mention-${match.index}`}
        style={[styles.messageMention, mine && styles.messageMentionMine, isDarkTheme && styles.messageMentionDark]}
      >
        {match[0]}
      </Text>,
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderComposerMentionText(text: string, isDarkTheme: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  const mentionPattern = /@orbita\b/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    nodes.push(
      <Text key={`composer-mention-${match.index}`} style={[styles.composerInputMention, isDarkTheme && styles.composerInputMentionDark]}>
        {match[0]}
      </Text>,
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function StatusSkeleton() {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <>
      <View style={[styles.statusComposer, isDarkTheme && styles.statusComposerDark]}>
        <SkeletonBlock style={styles.skeletonAvatarLarge} />
        <View style={styles.chatRowBody}>
          <SkeletonBlock style={styles.skeletonTitle} />
          <SkeletonBlock style={styles.skeletonLineMid} />
        </View>
      </View>
      <View style={[styles.statusCard, isDarkTheme && styles.statusCardDark]}>
        <View style={styles.row}>
          <SkeletonBlock style={styles.skeletonAvatar} />
          <View style={styles.chatRowBody}>
            <SkeletonBlock style={styles.skeletonTitle} />
            <SkeletonBlock style={styles.skeletonLineShort} />
          </View>
        </View>
        <SkeletonBlock style={styles.skeletonStatusText} />
      </View>
    </>
  );
}

function SettingsSkeleton() {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <>
      <View style={[styles.profileCard, isDarkTheme && styles.profileCardDark]}>
        <SkeletonBlock style={styles.skeletonAvatarXL} />
        <View style={styles.chatRowBody}>
          <SkeletonBlock style={styles.skeletonTitleWide} />
          <SkeletonBlock style={styles.skeletonLineMid} />
          <SkeletonBlock style={styles.skeletonLineShort} />
        </View>
      </View>
      {Array.from({ length: 3 }).map((_, index) => (
        <View key={index} style={[styles.settingRow, isDarkTheme && styles.settingRowDark]}>
          <SkeletonBlock style={styles.skeletonIcon} />
          <View style={styles.chatRowBody}>
            <SkeletonBlock style={styles.skeletonTitle} />
            <SkeletonBlock style={styles.skeletonLineLong} />
          </View>
        </View>
      ))}
    </>
  );
}

function AppShellSkeleton() {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={[styles.safe, isDarkTheme && styles.safeDark]}>
      <View style={[styles.appFrame, isDarkTheme && styles.appFrameDark]}>
        <View style={[styles.workspace, isDarkTheme && styles.workspaceDark]}>
          <View style={[styles.header, styles.headerMobile, isDarkTheme && styles.headerDark]}>
            <View style={styles.brandRow}>
              <SkeletonBlock style={styles.skeletonLogo} />
              <SkeletonBlock style={styles.skeletonBrand} />
            </View>
            <View style={styles.headerActions}>
              <SkeletonBlock style={styles.skeletonIconButton} />
              <SkeletonBlock style={styles.skeletonIconButton} />
              <SkeletonBlock style={styles.skeletonIconButton} />
            </View>
          </View>
          <View style={[styles.content, styles.contentMobile, isDarkTheme && styles.contentMobileDark]}>
            <View style={[styles.listPanel, styles.mobilePanel, isDarkTheme && styles.listPanelDark]}>
              <View style={[styles.panelTitle, isDarkTheme && styles.panelTitleDark]}>
                <SkeletonBlock style={styles.skeletonPanelHeading} />
                <SkeletonBlock style={styles.skeletonIconButton} />
              </View>
              <ScrollView contentContainerStyle={[styles.listContent, isDarkTheme && styles.listContentDark]}>
                <ChatRowsSkeleton count={6} />
              </ScrollView>
            </View>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

function IconButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void | Promise<void>;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        !isDarkTheme && { backgroundColor: themeColors.accentSoft, borderColor: themeColors.primarySoft },
        isDarkTheme && styles.iconButtonDark,
        isDarkTheme && { backgroundColor: themeColors.darkAccentSoft, borderColor: themeColors.primaryDark },
        pressed && styles.pressablePressed,
      ]}
    >
      <Ionicons color={isDarkTheme ? "#FFFFFF" : themeColors.primaryDark} name={icon} size={21} />
    </Pressable>
  );
}

export function OrbitaApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const themeContext = usePersistedTheme();

  useEffect(() => {
    if (!supabase) {
      setCheckingSession(false);
      return undefined;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingSession(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setCheckingSession(false);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <AppThemeContext.Provider value={themeContext}>
      {checkingSession ? (
        <FullScreenLoader />
      ) : !session ? (
        <LoginScreen onSignedIn={setSession} />
      ) : (
        <MessengerShell session={session} />
      )}
    </AppThemeContext.Provider>
  );
}

function FullScreenLoader() {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <SafeAreaView style={[styles.safe, isDarkTheme && styles.safeDark]}>
      <View style={[styles.loadingScreen, isDarkTheme && styles.loadingScreenDark]}>
        <OrbitaLogo />
        <Text style={[styles.loadingLabel, isDarkTheme && styles.loadingLabelDark]}>Syncing your universe...</Text>
      </View>
    </SafeAreaView>
  );
}

function LoginScreen({ onSignedIn }: { onSignedIn: (session: Session | null) => void }) {
  const { isDarkTheme, themeColors, toggleTheme } = useAppTheme();
  const { width } = useWindowDimensions();
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpFallbackActive, setOtpFallbackActive] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const keyboardInset = useKeyboardClearance();

  useEffect(() => {
    if (!resendSeconds) return undefined;
    const timer = setTimeout(() => setResendSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => clearTimeout(timer);
  }, [resendSeconds]);

  function switchMode(nextMode: AuthMode) {
    if (loading) return;
    setAuthMode(nextMode);
    setOtp("");
    setOtpSent(false);
    setOtpFallbackActive(false);
    setNotice("");
    setResendSeconds(0);
  }

  function editLoginDetails() {
    setOtp("");
    setOtpSent(false);
    setOtpFallbackActive(false);
    setNotice("");
    setResendSeconds(0);
  }

  async function requestOtp(isResend = false) {
    const normalizedPhone = normalizePhone(phone);
    const normalizedName = displayName.trim();
    if (!normalizedPhone) {
      setNotice("Enter your phone number first.");
      return;
    }
    if (authMode === "signup" && !normalizedName) {
      setNotice("Enter your name to create your Orbita profile.");
      return;
    }
    if (isResend && resendSeconds > 0) return;
    if (!hasSupabaseConfig) {
      setNotice("Add Supabase credentials to .env before logging in.");
      return;
    }

    setLoading(true);
    const result = await signInWithPhone(normalizedPhone, {
      displayName: authMode === "signup" ? normalizedName : undefined,
      shouldCreateUser: authMode === "signup",
    });
    setLoading(false);

    if (result.error) {
      const recovery = getFriendlyOtpRequestRecovery(result.error.message, authMode);
      if (recovery) {
        setPhone(normalizedPhone);
        setOtp("");
        setOtpSent(false);
        setOtpFallbackActive(false);
        setResendSeconds(0);
        if (recovery.nextMode) setAuthMode(recovery.nextMode);
        setNotice(recovery.message);
        return;
      }

      if (DEV_OTP_ENABLED) {
        setPhone(normalizedPhone);
        setDisplayName(normalizedName);
        setOtp("");
        setOtpSent(true);
        setOtpFallbackActive(true);
        setResendSeconds(0);
        setNotice(`SMS OTP failed: ${result.error.message}. Dev OTP is enabled for this build; enter ${DEV_BYPASS_OTP} to continue while the SMS provider is fixed.`);
      } else {
        setOtpSent(false);
        setOtpFallbackActive(false);
        setNotice(result.error.message);
      }
      return;
    }

    setPhone(normalizedPhone);
    setDisplayName(normalizedName);
    setOtp("");
    setOtpSent(true);
    setOtpFallbackActive(false);
    setResendSeconds(OTP_RESEND_SECONDS);
    setNotice(`${isResend ? "New OTP sent" : "OTP sent"} to your phone. Enter the code to continue.`);
  }

  async function verifyOtp() {
    if (!otp.trim()) {
      setNotice("Enter the OTP code.");
      return;
    }

    const normalizedPhone = normalizePhone(phone);
    const normalizedName = displayName.trim();
    const isDevBypass = DEV_OTP_ENABLED && otp.trim() === DEV_BYPASS_OTP;

    if (!normalizedPhone) {
      setNotice("Enter your phone number first.");
      return;
    }

    setLoading(true);
    const result = isDevBypass
      ? await signInWithDevOtpBypass(normalizedPhone, authMode === "signup" ? normalizedName : undefined)
      : await verifyPhoneOtp(normalizedPhone, otp.trim(), authMode === "signup" ? normalizedName : undefined);
    setLoading(false);

    if (result.error) {
      setNotice(result.error.message);
      return;
    }

    onSignedIn(result.data.session);
  }

  const authTitle = otpSent
    ? "Enter secure code"
    : authMode === "signup"
      ? "Create your Orbita"
      : "Welcome back";
  const authCopy = otpSent
    ? otpFallbackActive
      ? `SMS delivery failed for ${phone || "your phone"}. Use the development code or retry SMS after fixing the provider.`
      : `We sent a one-time code to ${phone || "your phone"}.`
    : authMode === "signup"
      ? "Build your AI-ready messaging profile with a verified phone number."
      : "Sign in with your phone OTP to continue your encrypted workspace.";
  const primaryLabel = otpSent ? "Verify and continue" : authMode === "signup" ? "Create account" : "Send phone OTP";
  const resendLabel = otpFallbackActive ? "Retry SMS OTP" : resendSeconds > 0 ? `Resend in ${resendSeconds}s` : "Resend OTP";
  const authIconColor = isDarkTheme ? themeColors.accent : themeColors.primaryDark;
  const authPlaceholderColor = isDarkTheme ? "rgba(255,255,255,0.52)" : "rgba(17,27,33,0.42)";
  const isAuthWide = Platform.OS === "web" && width >= 980;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={[styles.safe, isDarkTheme && styles.safeDark]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        enabled={Platform.OS !== "web"}
        style={styles.loginKeyboard}
      >
      <ScrollView
        contentContainerStyle={[styles.loginScroll, keyboardInset ? { paddingBottom: keyboardInset } : null]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.loginScreen, !isDarkTheme && styles.loginScreenLight]}>
          <View style={[styles.loginBackdropGrid, !isDarkTheme && styles.loginBackdropGridLight]} />
          <View style={[styles.loginGlow, !isDarkTheme && styles.loginGlowLight, { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft }]} />
          {!isAuthWide ? <AuthSignalScene /> : null}
          <View style={[styles.loginContent, isAuthWide && styles.loginContentWide]}>
            <View style={[styles.loginAuthColumn, isAuthWide && styles.loginAuthColumnWide]}>
              <View style={styles.loginHero}>
                <View style={styles.loginTopRow}>
                  <OrbitaBrand inverse={isDarkTheme} />
                  <Pressable
                    accessibilityLabel={isDarkTheme ? "Switch to light theme" : "Switch to dark theme"}
                    onPress={toggleTheme}
                    style={({ pressed }) => [
                      styles.authThemeButton,
                      !isDarkTheme && styles.authThemeButtonLight,
                      !isDarkTheme && { borderColor: themeColors.primarySoft, backgroundColor: themeColors.accentSoft },
                      pressed && styles.pressablePressed,
                    ]}
                  >
                    <Ionicons color={authIconColor} name={isDarkTheme ? "sunny-outline" : "moon-outline"} size={18} />
                  </Pressable>
                </View>
                <View style={[styles.loginBadge, !isDarkTheme && styles.loginBadgeLight, !isDarkTheme && { backgroundColor: themeColors.accentSoft }]}>
                  <Ionicons color={authIconColor} name="sparkles" size={14} />
                  <Text style={[styles.loginBadgeText, !isDarkTheme && styles.loginBadgeTextLight]}>AI signal layer</Text>
                </View>
                <Text style={[styles.loginTitle, isAuthWide && styles.loginTitleWide, !isDarkTheme && styles.loginTitleLight]}>{authTitle}</Text>
                <Text style={[styles.loginCopy, isAuthWide && styles.loginCopyWide, !isDarkTheme && styles.loginCopyLight]}>{authCopy}</Text>
              </View>
              <View style={[styles.loginForm, isAuthWide && styles.loginFormWide, !isDarkTheme && styles.loginFormLight]}>
                {!otpSent ? (
                  <View style={[styles.authModeSwitch, !isDarkTheme && styles.authModeSwitchLight]}>
                    <Pressable
                      onPress={() => switchMode("signin")}
                      style={({ pressed }) => [
                        styles.authModeButton,
                        authMode === "signin" && styles.authModeButtonActive,
                        !isDarkTheme && authMode === "signin" && [styles.authModeButtonActiveLight, { backgroundColor: themeColors.primaryDark }],
                        pressed && styles.pressablePressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.authModeText,
                          !isDarkTheme && styles.authModeTextLight,
                          authMode === "signin" && styles.authModeTextActive,
                          !isDarkTheme && authMode === "signin" && styles.authModeTextActiveLight,
                        ]}
                      >
                        Sign in
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => switchMode("signup")}
                      style={({ pressed }) => [
                        styles.authModeButton,
                        authMode === "signup" && styles.authModeButtonActive,
                        !isDarkTheme && authMode === "signup" && [styles.authModeButtonActiveLight, { backgroundColor: themeColors.primaryDark }],
                        pressed && styles.pressablePressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.authModeText,
                          !isDarkTheme && styles.authModeTextLight,
                          authMode === "signup" && styles.authModeTextActive,
                          !isDarkTheme && authMode === "signup" && styles.authModeTextActiveLight,
                        ]}
                      >
                        Create
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
                {authMode === "signup" && !otpSent ? (
                  <View style={[styles.inputShell, !isDarkTheme && styles.inputShellLight]}>
                    <Ionicons color={authIconColor} name="person-outline" size={18} />
                    <TextInput
                      autoCapitalize="words"
                      autoCorrect={false}
                      editable={!loading}
                      onChangeText={setDisplayName}
                      placeholder="Your name"
                      placeholderTextColor={authPlaceholderColor}
                      style={[styles.loginInput, !isDarkTheme && styles.loginInputLight]}
                      value={displayName}
                    />
                  </View>
                ) : null}
                <View style={[styles.inputShell, !isDarkTheme && styles.inputShellLight]}>
                  <Ionicons color={authIconColor} name="call-outline" size={18} />
                  <TextInput
                    editable={!otpSent && !loading}
                    keyboardType="phone-pad"
                    onChangeText={setPhone}
                    placeholder="+91 phone number"
                    placeholderTextColor={authPlaceholderColor}
                    style={[styles.loginInput, !isDarkTheme && styles.loginInputLight]}
                    value={phone}
                  />
                </View>
                {otpSent ? (
                  <>
                    <View style={[styles.inputShell, !isDarkTheme && styles.inputShellLight]}>
                      <Ionicons color={authIconColor} name="keypad-outline" size={18} />
                      <TextInput
                        autoFocus={Platform.OS !== "web"}
                        keyboardType="number-pad"
                        onChangeText={setOtp}
                        placeholder="OTP code"
                        placeholderTextColor={authPlaceholderColor}
                        style={[styles.loginInput, !isDarkTheme && styles.loginInputLight, styles.otpInput]}
                        value={otp}
                      />
                    </View>
                    <View style={styles.otpActionRow}>
                      <Pressable
                        disabled={loading || resendSeconds > 0}
                        onPress={() => requestOtp(true)}
                        style={({ pressed }) => [styles.textActionButton, pressed && styles.pressablePressed]}
                      >
                        <Text
                          style={[
                            styles.textAction,
                            !isDarkTheme && [styles.textActionLight, { color: themeColors.primaryDark }],
                            (loading || resendSeconds > 0) && styles.textActionDisabled,
                            !isDarkTheme && (loading || resendSeconds > 0) && styles.textActionDisabledLight,
                          ]}
                        >
                          {resendLabel}
                        </Text>
                      </Pressable>
                      <Pressable
                        disabled={loading}
                        onPress={editLoginDetails}
                        style={({ pressed }) => [styles.textActionButton, pressed && styles.pressablePressed]}
                      >
                        <Text style={[styles.textAction, !isDarkTheme && [styles.textActionLight, { color: themeColors.primaryDark }]]}>Edit details</Text>
                      </Pressable>
                    </View>
                  </>
                ) : null}
                <Pressable
                  disabled={loading || !hasSupabaseConfig}
                  onPress={otpSent ? verifyOtp : () => requestOtp(false)}
                  style={({ pressed }) => [
                    styles.loginButton,
                    { backgroundColor: themeColors.primaryDark },
                    pressed && styles.pressablePressed,
                    (loading || !hasSupabaseConfig) && styles.buttonDisabled,
                  ]}
                >
                  {loading ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons color="#FFFFFF" name={otpSent ? "shield-checkmark-outline" : "flash-outline"} size={18} />
                      <Text style={styles.loginButtonText}>{primaryLabel}</Text>
                    </>
                  )}
                </Pressable>
                {notice ? <Text style={[styles.loginNoticeText, !isDarkTheme && [styles.loginNoticeTextLight, { color: themeColors.primaryDark }]]}>{notice}</Text> : null}
                {!hasSupabaseConfig ? (
                  <Text style={[styles.loginHintText, !isDarkTheme && styles.loginHintTextLight]}>
                    Required: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.
                  </Text>
                ) : null}
              </View>
              <View style={styles.loginLegalRow}>
                <Text style={[styles.loginLegalText, !isDarkTheme && styles.loginLegalTextLight]}>
                  By continuing, you agree to Orbita processing your data as described in our{" "}
                </Text>
                <Link href={"/privacy" as never} asChild>
                  <Pressable style={({ pressed }) => [styles.loginLegalLinkButton, pressed && styles.pressablePressed]}>
                    <Text style={[styles.loginLegalLink, !isDarkTheme && [styles.loginLegalLinkLight, { color: themeColors.primaryDark }]]}>
                      Privacy Policy
                    </Text>
                  </Pressable>
                </Link>
                <Text style={[styles.loginLegalText, !isDarkTheme && styles.loginLegalTextLight]}>.</Text>
              </View>
            </View>
            {isAuthWide ? (
              <View style={[styles.authVisualPanel, !isDarkTheme && styles.authVisualPanelLight, !isDarkTheme && { borderColor: themeColors.primarySoft }]}>
                <View style={[styles.authVisualHalo, !isDarkTheme && styles.authVisualHaloLight, { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft }]} />
                <AuthSignalScene inline />
                <View style={[styles.authVisualRail, styles.authVisualRailTop, !isDarkTheme && styles.authVisualRailLight]} />
                <View style={[styles.authVisualRail, styles.authVisualRailMiddle, !isDarkTheme && styles.authVisualRailLight]} />
                <View style={[styles.authVisualRail, styles.authVisualRailBottom, !isDarkTheme && styles.authVisualRailLight]} />
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessengerShell({ session }: { session: Session }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { isDarkTheme, themeColors } = useAppTheme();
  const isWide = width >= 840;
  const [activeTab, setActiveTab] = useState<Tab>("chats");
  const [appLifecycleState, setAppLifecycleState] = useState(AppState.currentState);
  const [profile, setProfile] = useState<BackendProfile | null>(null);
  const [contacts, setContacts] = useState<BackendProfile[]>([]);
  const [conversations, setConversations] = useState<BackendConversation[]>([]);
  const [taskOrgMembersByConversationId, setTaskOrgMembersByConversationId] = useState<Record<string, BackendProfile[]>>({});
  const [statuses, setStatuses] = useState<BackendStatus[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedMessages, setSelectedMessages] = useState<ChatMessage[]>([]);
  const [replyingToMessage, setReplyingToMessage] = useState<ChatMessage | null>(null);
  const [draft, setDraft] = useState("");
  const [composerAttachment, setComposerAttachment] = useState<ComposerAttachment | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMessagesFor, setLoadingMessagesFor] = useState("");
  const [loadingOlderFor, setLoadingOlderFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [uploadingProfilePhoto, setUploadingProfilePhoto] = useState(false);
  const [error, setError] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
  const [adminSession, setAdminSession] = useState<TaskManagerAdminSession | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminNotice, setAdminNotice] = useState("");
  const [adminSummary, setAdminSummary] = useState<TaskManagerAdminSummary | null>(null);
  const [adminUsers, setAdminUsers] = useState<TaskManagerAdminUser[]>([]);
  const [adminTasks, setAdminTasks] = useState<TaskManagerAdminTask[]>([]);
  const [adminDepartments, setAdminDepartments] = useState<TaskManagerDepartment[]>([]);
  const [adminReports, setAdminReports] = useState<Awaited<ReturnType<typeof taskManagerAdminApi.taskReports>> | null>(null);
  const [adminSettings, setAdminSettings] = useState<Record<string, unknown> | null>(null);
  const [adminChats, setAdminChats] = useState<TaskManagerChatMessage[]>([]);
  const [adminSelectedUserId, setAdminSelectedUserId] = useState("");
  const [adminEmployeeName, setAdminEmployeeName] = useState("");
  const [adminEmployeeRole, setAdminEmployeeRole] = useState<"admin" | "member">("member");
  const [agentThinkingFor, setAgentThinkingFor] = useState<Record<string, string>>({});
  const [typingByConversation, setTypingByConversation] = useState<Record<string, Record<string, TypingParticipant>>>({});
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [subtaskParentConversation, setSubtaskParentConversation] = useState<BackendConversation | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const [forwardPickerOpen, setForwardPickerOpen] = useState(false);
  const [messageActionTarget, setMessageActionTarget] = useState<MessageActionTarget>(null);
  const [saveContactPeer, setSaveContactPeer] = useState<UnsavedPeer | null>(null);
  const bootstrapRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const typingChannelRef = useRef<{ channel: RealtimeChannel; conversationId: string } | null>(null);
  const typingExpiryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingRefreshAtRef = useRef(0);
  const typingIsActiveRef = useRef(false);
  const activeTabRef = useRef<Tab>("chats");
  const appLifecycleStateRef = useRef(AppState.currentState);
  const conversationsRef = useRef<BackendConversation[]>([]);
  const messagesByConversationRef = useRef<Record<string, ChatMessage[]>>({});
  const contactsRef = useRef<BackendProfile[]>([]);
  const agentThinkingForRef = useRef<Record<string, string>>({});
  const hasMoreMessagesRef = useRef<Record<string, boolean>>({});
  const selectedIdRef = useRef("");
  const hasVisibleBootstrapRef = useRef(false);
  const lastUnreadTotalRef = useRef<number | null>(null);
  const incomingHapticAtRef = useRef(0);
  const bootstrapHasLoadedRef = useRef(false);
  const adminModeCheckInFlightRef = useRef(false);
  const adminSessionRef = useRef<TaskManagerAdminSession | null>(null);
  const pushTokenRef = useRef<string | null>(null);
  const processingOutboxRef = useRef(false);
  const openingAgentFromFabRef = useRef(false);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  const visibleTabs = useMemo(() => (adminSession ? tabs : tabs.filter((tab) => tab.id !== "admin")), [adminSession]);
  const visibleTabIds = useMemo(() => new Set(visibleTabs.map((tab) => tab.id)), [visibleTabs]);
  const conversationIds = useMemo(() => conversations.map((conversation) => conversation.id), [conversations]);
  const conversationKey = conversationIds.join("|");
  const profileId = profile?.id ?? "";
  const unreadTotal = useMemo(
    () => conversations.reduce((total, conversation) => total + conversation.unreadCount, 0),
    [conversations],
  );
  const selectedTypingParticipants = useMemo(() => {
    if (!selected) return [];
    const now = Date.now();
    return Object.values(typingByConversation[selected.id] ?? {})
      .filter((participant) => participant.expiresAt > now)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [selected, typingByConversation]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    const activeConversationId = selectedIdRef.current;
    if (
      activeConversationId &&
      selectedMessages.length &&
      selectedMessages.every((message) => message.conversationId === activeConversationId)
    ) {
      messagesByConversationRef.current = {
        ...messagesByConversationRef.current,
        [activeConversationId]: selectedMessages,
      };
    }
  }, [selectedMessages]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  useEffect(() => {
    agentThinkingForRef.current = agentThinkingFor;
  }, [agentThinkingFor]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    if (!visibleTabIds.has(activeTab)) {
      setActiveTab("chats");
    }
  }, [activeTab, visibleTabIds]);

  useEffect(() => {
    adminSessionRef.current = adminSession;
  }, [adminSession]);

  useEffect(() => {
    appLifecycleStateRef.current = appLifecycleState;
  }, [appLifecycleState]);

  useEffect(() => {
    hasVisibleBootstrapRef.current = Boolean(profile);
  }, [profile]);

  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => setError(""), 2800);
    return () => clearTimeout(timer);
  }, [error]);

  const playIncomingHaptic = useCallback(() => {
    const now = Date.now();
    if (now - incomingHapticAtRef.current < 700) return;
    incomingHapticAtRef.current = now;
    void hapticMessageReceived();
  }, []);

  const removeTypingParticipant = useCallback((conversationId: string, userId: string) => {
    const timerKey = `${conversationId}:${userId}`;
    const timer = typingExpiryTimers.current.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      typingExpiryTimers.current.delete(timerKey);
    }
    setTypingByConversation((current) => {
      const conversationTyping = current[conversationId];
      if (!conversationTyping?.[userId]) return current;
      const nextConversationTyping = { ...conversationTyping };
      delete nextConversationTyping[userId];
      const next = { ...current };
      if (Object.keys(nextConversationTyping).length) {
        next[conversationId] = nextConversationTyping;
      } else {
        delete next[conversationId];
      }
      return next;
    });
  }, []);

  const registerTypingEvent = useCallback((payload: TypingBroadcastPayload) => {
    const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : "";
    const userId = typeof payload.userId === "string" ? payload.userId : "";
    if (!conversationId || !userId || userId === profileId) return;

    if (payload.event === "stop") {
      removeTypingParticipant(conversationId, userId);
      return;
    }

    if (payload.event !== "start") return;
    const savedContact = contactsRef.current.find((contact) => contact.id === userId);
    const participant = conversationsRef.current
      .find((conversation) => conversation.id === conversationId)
      ?.participants.find((conversationParticipant) => conversationParticipant.id === userId);
    const fallbackDisplayName = typeof payload.displayName === "string" && payload.displayName.trim()
      ? payload.displayName.trim()
      : "Someone";
    const displayName = savedContact?.displayName || participant?.displayName || participant?.phone || fallbackDisplayName;
    const expiresAt = Date.now() + TYPING_EXPIRE_MS;
    setTypingByConversation((current) => ({
      ...current,
      [conversationId]: {
        ...(current[conversationId] ?? {}),
        [userId]: { displayName, expiresAt, userId },
      },
    }));

    const timerKey = `${conversationId}:${userId}`;
    const existing = typingExpiryTimers.current.get(timerKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => removeTypingParticipant(conversationId, userId), TYPING_EXPIRE_MS);
    typingExpiryTimers.current.set(timerKey, timer);
  }, [profileId, removeTypingParticipant]);

  const sendTypingEvent = useCallback((event: "start" | "stop", conversationId = selectedId) => {
    if (!profile || !conversationId) return;
    const activeConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
    if (!activeConversation || isTaskManagerAgentConversation(activeConversation)) return;
    const currentChannel = typingChannelRef.current;
    if (!currentChannel || currentChannel.conversationId !== conversationId) return;

    void currentChannel.channel.send({
      type: "broadcast",
      event: "typing",
      payload: {
        conversationId,
        displayName: profile.displayName,
        event,
        sentAt: new Date().toISOString(),
        userId: profile.id,
      } satisfies TypingBroadcastPayload,
    });
  }, [profile, selectedId]);

  const stopTyping = useCallback((conversationId = selectedId) => {
    if (typingIdleTimer.current) {
      clearTimeout(typingIdleTimer.current);
      typingIdleTimer.current = null;
    }
    if (typingIsActiveRef.current) {
      sendTypingEvent("stop", conversationId);
    }
    typingIsActiveRef.current = false;
    typingRefreshAtRef.current = 0;
  }, [selectedId, sendTypingEvent]);

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    if (!selected || !profile || isTaskManagerAgentConversation(selected)) return;

    if (!value.trim()) {
      stopTyping(selected.id);
      return;
    }

    const now = Date.now();
    if (!typingIsActiveRef.current || now - typingRefreshAtRef.current >= TYPING_REFRESH_MS) {
      sendTypingEvent("start", selected.id);
      typingIsActiveRef.current = true;
      typingRefreshAtRef.current = now;
    }

    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    typingIdleTimer.current = setTimeout(() => stopTyping(selected.id), TYPING_IDLE_MS);
  }, [profile, selected, sendTypingEvent, stopTyping]);

  const hydrateBootstrapFromCache = useCallback(async () => {
    const cached = await readCachedBootstrap(session.user.id);
    if (!cached || !cached.profile) return;

    const displayConversations = applySavedContactNamesToConversations(cached.conversations, cached.contacts, cached.profile.id);
    lastUnreadTotalRef.current = displayConversations.reduce((total, conversation) => total + conversation.unreadCount, 0);
    hasVisibleBootstrapRef.current = true;
    contactsRef.current = cached.contacts;
    conversationsRef.current = displayConversations;
    setProfile(cached.profile);
    setContacts(cached.contacts);
    setConversations(displayConversations);
    setStatuses(cached.statuses);
    setLoading(false);
  }, [session.user.id]);

  const loadBootstrap = useCallback(async () => {
    if (!supabase) return;
    const maxAttempts = bootstrapHasLoadedRef.current ? 1 : 3;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const data = await messengerApi.bootstrap();
        const nextUnreadTotal = data.conversations.reduce((total, conversation) => total + conversation.unreadCount, 0);
        if (lastUnreadTotalRef.current !== null && nextUnreadTotal > lastUnreadTotalRef.current) {
          playIncomingHaptic();
        }
        lastUnreadTotalRef.current = nextUnreadTotal;
        bootstrapHasLoadedRef.current = true;
        const displayConversations = applySavedContactNamesToConversations(data.conversations, data.contacts, data.profile.id);
        contactsRef.current = data.contacts;
        conversationsRef.current = displayConversations;
        setProfile(data.profile);
        setContacts(data.contacts);
        setConversations(displayConversations);
        setStatuses(data.statuses);
        setError("");
        setLoading(false);
        void writeBootstrapCache(data.profile.id, {
          ...data,
          conversations: displayConversations,
        }).catch(() => undefined);
        return;
      } catch (nextError) {
        lastError = nextError;
        if (attempt < maxAttempts) {
          await delay(450 * attempt);
        }
      }
    }

    setError(
      hasVisibleBootstrapRef.current
        ? "Showing saved chats. Could not sync."
        : lastError instanceof Error
          ? lastError.message
          : "Unable to load backend data.",
    );
    setLoading(false);
  }, [playIncomingHaptic]);

  const refreshAdminData = useCallback(async (
    sessionOverride?: TaskManagerAdminSession | null,
    options: { silent?: boolean } = {},
  ): Promise<boolean> => {
    const currentSession = sessionOverride ?? adminSessionRef.current;
    if (!currentSession) return false;
    if (!options.silent) setAdminLoading(true);
    try {
      const [summary, users, tasks, departments, reports, settings] = await Promise.all([
        taskManagerAdminApi.summary(currentSession),
        taskManagerAdminApi.users(currentSession),
        taskManagerAdminApi.tasks(currentSession),
        taskManagerAdminApi.departments(currentSession),
        taskManagerAdminApi.taskReports(currentSession),
        taskManagerAdminApi.settings(currentSession),
      ]);
      setAdminSummary(summary);
      setAdminUsers(users);
      setAdminTasks(tasks);
      setAdminDepartments(departments);
      setAdminReports(reports);
      setAdminSettings(settings);
      setAdminNotice("");
      return true;
    } catch (nextError) {
      setAdminNotice(nextError instanceof Error ? nextError.message : "Unable to load admin data.");
      adminSessionRef.current = null;
      setAdminSession(null);
      if (activeTabRef.current === "admin") setActiveTab("chats");
      return false;
    } finally {
      if (!options.silent) setAdminLoading(false);
    }
  }, []);

  const loadTaskManagerAdminMode = useCallback(async (options: { silent?: boolean } = {}) => {
    if (adminModeCheckInFlightRef.current) return;
    adminModeCheckInFlightRef.current = true;
    try {
      const saved = await loadTaskManagerAdminSession();
      if (saved) {
        const refreshed = await refreshAdminData(saved, options);
        if (refreshed) {
          setAdminSession(saved);
          return;
        }
        await clearTaskManagerAdminSession();
      }

      const result = await messengerApi.createTaskManagerAdminSession();
      if (!result.available) {
        if (__DEV__ && result.reason) {
          console.warn(`[task-manager-admin] ${result.reason}`);
        }
        setAdminSession(null);
        setAdminNotice("");
        return;
      }
      const nextSession: TaskManagerAdminSession = {
        apiBaseUrl: result.apiBaseUrl,
        token: result.session.token,
        expiresAt: result.session.expires_at,
        orgId: result.session.org_id,
        orgName: result.session.org_name,
        userId: result.session.user_id,
        userName: result.session.user_name,
      };
      await saveTaskManagerAdminSession(nextSession);
      const refreshed = await refreshAdminData(nextSession, options);
      if (refreshed) {
        setAdminSession(nextSession);
      }
    } catch (error) {
      if (__DEV__) {
        console.warn("[task-manager-admin] Admin session check failed.", error);
      }
      await clearTaskManagerAdminSession();
      setAdminSession(null);
      setAdminNotice("");
    } finally {
      adminModeCheckInFlightRef.current = false;
    }
  }, [refreshAdminData]);

  useEffect(() => {
    if (!profile) return undefined;
    void loadTaskManagerAdminMode();
    return undefined;
  }, [loadTaskManagerAdminMode, profile?.id]);

  const markConversationReadLocally = useCallback((
    conversationId: string,
    options: { forceRemoteSync?: boolean } = {},
  ) => {
    const hasUnread = conversationsRef.current.some(
      (conversation) => conversation.id === conversationId && conversation.unreadCount > 0,
    );
    if (hasUnread || options.forceRemoteSync) {
      void messengerApi.markConversationRead(conversationId).catch(() => undefined);
    }
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation,
      ),
    );
  }, []);

  const updateConversationPreview = useCallback((message: BackendMessage) => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === message.conversationId
          ? { ...conversation, lastMessage: message, updatedAt: message.createdAt, unreadCount: 0 }
          : conversation,
      ),
    );
  }, []);

  const rememberMessages = useCallback((conversationId: string, messages: ChatMessage[]) => {
    messagesByConversationRef.current = {
      ...messagesByConversationRef.current,
      [conversationId]: messages,
    };
  }, []);

  const applyRealtimeMessage = useCallback((message: BackendMessage) => {
    const activeConversationId = selectedIdRef.current;
    const currentForConversation = messagesByConversationRef.current[message.conversationId] ?? [];
    const nextMessages = upsertMessage(currentForConversation, message);
    const displayMessage = nextMessages.find((item) => item.id === message.id || item.clientMessageId === message.clientMessageId) ?? message;
    rememberMessages(message.conversationId, nextMessages);

    if (activeConversationId === message.conversationId) {
      setSelectedMessages(nextMessages);
      if (message.senderId !== profileId) {
        playIncomingHaptic();
        markConversationReadLocally(message.conversationId, { forceRemoteSync: true });
      }
    }

    setConversations((current) =>
      current.map((conversation) => {
        if (conversation.id !== message.conversationId) return conversation;
        const shouldIncrementUnread = message.senderId !== profileId && activeConversationId !== message.conversationId;
        return {
          ...conversation,
          lastMessage: displayMessage,
          updatedAt: displayMessage.createdAt,
          unreadCount: shouldIncrementUnread ? conversation.unreadCount + 1 : conversation.unreadCount,
        };
      }),
    );

    if (message.senderId !== profileId && agentThinkingForRef.current[message.conversationId]) {
      setAgentThinkingFor((currentThinking) => {
        const next = { ...currentThinking };
        if (isAgentProgressMessage(message)) {
          next[message.conversationId] = message.createdAt;
        } else {
          delete next[message.conversationId];
        }
        return next;
      });
    }

    void writeConversationMessages(session.user.id, message.conversationId, nextMessages).catch(() => undefined);
  }, [markConversationReadLocally, playIncomingHaptic, profileId, rememberMessages, session.user.id]);

  const isPreviewOnlyMessageSet = useCallback((conversationId: string, messages: ChatMessage[]) => {
    if (messages.length !== 1) return false;
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    return conversation?.lastMessage?.id === messages[0]?.id;
  }, []);

  const mergeWithConversationPreview = useCallback((conversationId: string, messages: ChatMessage[]) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    const preview = conversation?.lastMessage;
    if (!preview) return messages;
    return upsertMessage(messages, preview);
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const data = await messengerApi.listMessages({ conversationId });
      hasMoreMessagesRef.current = {
        ...hasMoreMessagesRef.current,
        [conversationId]: data.hasMore,
      };
      const local = (messagesByConversationRef.current[conversationId] ?? []).filter(
        (message) => message.conversationId === conversationId,
      );
      const merged = mergeWithConversationPreview(conversationId, mergeMessages(data.messages, local));
      rememberMessages(conversationId, merged);
      if (selectedIdRef.current === conversationId) {
        setSelectedMessages(merged);
      }
      const knownIds = new Set(local.map((message) => message.id));
      const hadLoadedThread = local.some((message) => !message.localState);
      const hasFreshIncoming = hadLoadedThread && merged.some((message) => {
        if (message.senderId === profileId || knownIds.has(message.id)) return false;
        return Date.now() - Date.parse(message.createdAt) < 60_000;
      });
      if (hasFreshIncoming) playIncomingHaptic();
      const thinkingSince = agentThinkingForRef.current[conversationId];
      if (thinkingSince) {
        const since = Date.parse(thinkingSince);
        const agentMessagesSince = merged.filter(
          (message) => message.senderId !== profileId && Date.parse(message.createdAt) >= since,
        );
        const gotAgentReply = agentMessagesSince.some((message) => !isAgentProgressMessage(message));
        if (gotAgentReply) {
          setAgentThinkingFor((currentThinking) => {
            const next = { ...currentThinking };
            delete next[conversationId];
            return next;
          });
        } else {
          const latestProgress = [...agentMessagesSince].reverse().find(isAgentProgressMessage);
          if (latestProgress && latestProgress.createdAt !== thinkingSince) {
            setAgentThinkingFor((currentThinking) =>
              currentThinking[conversationId]
                ? { ...currentThinking, [conversationId]: latestProgress.createdAt }
                : currentThinking,
            );
          }
        }
      }
      void writeConversationMessages(session.user.id, conversationId, merged).catch(() => undefined);
      markConversationReadLocally(conversationId);
      setError("");
    } catch (nextError) {
      if (selectedIdRef.current === conversationId) {
        setError(nextError instanceof Error ? nextError.message : "Unable to load messages.");
      }
    } finally {
      setLoadingMessagesFor((current) => (current === conversationId ? "" : current));
    }
  }, [markConversationReadLocally, mergeWithConversationPreview, playIncomingHaptic, profileId, rememberMessages, session.user.id]);

  const loadOlderMessages = useCallback(async (conversationId: string) => {
    if (loadingOlderFor === conversationId) return;
    const currentMessages = messagesByConversationRef.current[conversationId] ?? [];
    const oldest = currentMessages.find((message) => !message.localState);
    if (!oldest || hasMoreMessagesRef.current[conversationId] === false) return;

    setLoadingOlderFor(conversationId);
    try {
      const data = await messengerApi.listMessages({
        beforeCreatedAt: oldest.createdAt,
        conversationId,
      });
      hasMoreMessagesRef.current = {
        ...hasMoreMessagesRef.current,
        [conversationId]: data.hasMore,
      };
      const currentForConversation = (messagesByConversationRef.current[conversationId] ?? currentMessages).filter(
        (message) => message.conversationId === conversationId,
      );
      const byId = new Map<string, ChatMessage>();
      [...data.messages, ...currentForConversation].forEach((message) => {
        byId.set(message.id, message);
      });
      const merged = mergeWithConversationPreview(
        conversationId,
        [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
      );
      rememberMessages(conversationId, merged);
      if (selectedIdRef.current === conversationId) {
        setSelectedMessages(merged);
      }
      void writeConversationMessages(session.user.id, conversationId, merged).catch(() => undefined);
    } catch (nextError) {
      if (selectedIdRef.current === conversationId) {
        setError(nextError instanceof Error ? nextError.message : "Unable to load older messages.");
      }
    } finally {
      setLoadingOlderFor((current) => (current === conversationId ? "" : current));
    }
  }, [loadingOlderFor, mergeWithConversationPreview, rememberMessages, session.user.id]);

  const scheduleBootstrapRefresh = useCallback(() => {
    if (bootstrapRefreshTimer.current) clearTimeout(bootstrapRefreshTimer.current);
    bootstrapRefreshTimer.current = setTimeout(() => {
      bootstrapRefreshTimer.current = null;
      void loadBootstrap();
    }, 500);
  }, [loadBootstrap]);

  const scheduleMessageRefresh = useCallback((conversationId: string) => {
    const current = messageRefreshTimers.current.get(conversationId);
    if (current) clearTimeout(current);
    const next = setTimeout(() => {
      messageRefreshTimers.current.delete(conversationId);
      void loadMessages(conversationId);
    }, 350);
    messageRefreshTimers.current.set(conversationId, next);
  }, [loadMessages]);

  useEffect(() => {
    return () => {
      if (bootstrapRefreshTimer.current) clearTimeout(bootstrapRefreshTimer.current);
      messageRefreshTimers.current.forEach((timer) => clearTimeout(timer));
      messageRefreshTimers.current.clear();
      typingExpiryTimers.current.forEach((timer) => clearTimeout(timer));
      typingExpiryTimers.current.clear();
      if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    };
  }, []);

  useEffect(() => {
    void hydrateBootstrapFromCache();
  }, [hydrateBootstrapFromCache]);

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setLoadingMessagesFor("");
      setSelectedMessages([]);
      return;
    }
    const inMemoryMessages = mergeWithConversationPreview(
      selectedId,
      messagesByConversationRef.current[selectedId] ?? [],
    );
    if (inMemoryMessages.length && !isPreviewOnlyMessageSet(selectedId, inMemoryMessages)) {
      setSelectedMessages(inMemoryMessages);
      setLoadingMessagesFor("");
      void loadMessages(selectedId);
      return () => {
        cancelled = true;
      };
    } else {
      setSelectedMessages(inMemoryMessages);
      setLoadingMessagesFor(selectedId);
    }
    void readCachedMessages(session.user.id, selectedId)
      .then((cachedMessages) => {
        if (cancelled) return;
        const hydratedCachedMessages = mergeWithConversationPreview(selectedId, cachedMessages);
        if (hydratedCachedMessages.length && !isPreviewOnlyMessageSet(selectedId, hydratedCachedMessages)) {
          messagesByConversationRef.current = {
            ...messagesByConversationRef.current,
            [selectedId]: hydratedCachedMessages,
          };
          setSelectedMessages(hydratedCachedMessages);
          setLoadingMessagesFor("");
          return;
        }
      })
      .finally(() => {
        if (!cancelled) loadMessages(selectedId);
      });
    return () => {
      cancelled = true;
    };
  }, [isPreviewOnlyMessageSet, loadMessages, mergeWithConversationPreview, selectedId, session.user.id]);

  useEffect(() => {
    if (!supabase || !selectedId || !profileId) return undefined;
    const activeConversation = conversationsRef.current.find((conversation) => conversation.id === selectedId);
    if (!activeConversation || isTaskManagerAgentConversation(activeConversation)) return undefined;

    const client = supabase;
    const channel = client
      .channel(`messenger:typing:${selectedId}`, {
        config: {
          broadcast: { self: false },
        },
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        registerTypingEvent(payload as TypingBroadcastPayload);
      });

    typingChannelRef.current = { channel, conversationId: selectedId };
    channel.subscribe();

    return () => {
      if (typingChannelRef.current?.channel === channel) {
        typingChannelRef.current = null;
      }
      if (typingIsActiveRef.current) {
        void channel.send({
          type: "broadcast",
          event: "typing",
          payload: {
            conversationId: selectedId,
            displayName: profile?.displayName ?? "Someone",
            event: "stop",
            sentAt: new Date().toISOString(),
            userId: profileId,
          } satisfies TypingBroadcastPayload,
        });
      }
      typingIsActiveRef.current = false;
      typingRefreshAtRef.current = 0;
      if (typingIdleTimer.current) {
        clearTimeout(typingIdleTimer.current);
        typingIdleTimer.current = null;
      }
      setTypingByConversation((current) => {
        if (!current[selectedId]) return current;
        const next = { ...current };
        delete next[selectedId];
        return next;
      });
      void client.removeChannel(channel);
    };
  }, [profile?.displayName, profileId, registerTypingEvent, selectedId]);

  useEffect(() => {
    if (!profileId) return undefined;

    const refreshActiveConversation = (conversationId = selectedId) => {
      scheduleBootstrapRefresh();
      if (conversationId) {
        scheduleMessageRefresh(conversationId);
      }
    };

    return subscribeMessengerRealtime({
      conversationIds,
      userId: profileId,
      onConversationEvent: (conversationId) => {
        refreshActiveConversation(conversationId === selectedId ? conversationId : "");
      },
      onMessageInserted: applyRealtimeMessage,
      onRealtimeEvent: (event) => {
        if (event.kind === "taskmanager_admin_status_changed") {
          void loadTaskManagerAdminMode({ silent: true });
          return;
        }
        refreshActiveConversation(event.conversationId && event.conversationId === selectedId ? event.conversationId : "");
      },
      onUserEvent: () => {
        scheduleBootstrapRefresh();
      },
    });
  }, [applyRealtimeMessage, conversationKey, loadTaskManagerAdminMode, profileId, scheduleBootstrapRefresh, scheduleMessageRefresh, selectedId]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    setForegroundNotificationContext({
      activeConversationId: selectedId,
      appState: appLifecycleState,
      isChatScreenOpen: activeTab === "chats" && Boolean(selectedId),
    });
  }, [activeTab, appLifecycleState, selectedId]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppLifecycleState(state);
      if (state !== "active") {
        stopTyping(selectedId);
        return;
      }
      void loadBootstrap();
      void loadTaskManagerAdminMode({ silent: true });
      if (selectedId) void loadMessages(selectedId);
    });

    return () => subscription.remove();
  }, [loadBootstrap, loadMessages, loadTaskManagerAdminMode, selectedId, stopTyping]);

  useEffect(() => {
    if (Platform.OS !== "android") return undefined;

    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (selectedId) {
        setSelectedId("");
        setSelectedMessages([]);
        setLoadingMessagesFor("");
        setActiveTab("chats");
        return true;
      }
      if (activeTab !== "chats") {
        setActiveTab("chats");
        return true;
      }
      return false;
    });

    return () => subscription.remove();
  }, [activeTab, selectedId]);

  useEffect(() => {
    const thinkingConversationIds = Object.keys(agentThinkingForRef.current);
    if (!thinkingConversationIds.length) return undefined;

    const interval = setInterval(() => {
      const currentThinking = agentThinkingForRef.current;
      const now = Date.now();

      Object.entries(currentThinking).forEach(([conversationId, thinkingSince]) => {
        const elapsed = now - Date.parse(thinkingSince);
        if (elapsed >= AGENT_THINKING_TIMEOUT_MS) {
          setAgentThinkingFor((current) => {
            const next = { ...current };
            delete next[conversationId];
            return next;
          });
          if (selectedIdRef.current === conversationId) {
            setError("Agent is taking longer than expected. Please try again.");
          }
          return;
        }

        scheduleMessageRefresh(conversationId);
      });
    }, AGENT_THINKING_POLL_MS);

    return () => clearInterval(interval);
  }, [agentThinkingFor, scheduleMessageRefresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (Platform.OS !== "web" && pushTokenRef.current !== null) {
      await messengerApi.registerPushToken(null).catch(() => undefined);
      pushTokenRef.current = null;
    }
    await supabase?.auth.signOut();
  }

  async function syncDeviceContacts() {
    if (Platform.OS === "web") {
      setSettingsNotice("Contact sync is available only on mobile.");
      return;
    }
    if (syncingContacts) return;
    setSyncingContacts(true);
    setError("");
    try {
      const permission = await DeviceContacts.requestPermissionsAsync();
      if (!permission.granted) {
        setSettingsNotice("Contact permission was not granted.");
        return;
      }

      const result = await DeviceContacts.getContactsAsync({
        fields: [DeviceContacts.Fields.PhoneNumbers],
        pageSize: 1000,
      });
      const seen = new Set<string>();
      const candidates = result.data.flatMap((contact) =>
        (contact.phoneNumbers ?? []).map((phoneNumber) => ({
          name: contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined,
          phone: normalizePhone(phoneNumber.number ?? ""),
        })),
      ).filter((contact) => {
        if (!contact.phone || contact.phone === normalizePhone(profile?.phone ?? "")) return false;
        if (seen.has(contact.phone)) return false;
        seen.add(contact.phone);
        return true;
      });

      let imported = 0;
      let skipped = 0;
      for (const contact of candidates) {
        try {
          await messengerApi.addContactByPhone(contact.phone, contact.name);
          imported += 1;
        } catch {
          skipped += 1;
        }
      }

      await loadBootstrap();
      setSettingsNotice(
        imported
          ? `Synced ${imported} contact${imported === 1 ? "" : "s"}. ${skipped ? `${skipped} not on Orbita yet.` : ""}`.trim()
          : skipped
            ? "No matching Orbita users found in your phone contacts yet."
            : "No phone contacts found to sync.",
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to sync contacts right now.");
    } finally {
      setSyncingContacts(false);
    }
  }

  async function retryBootstrap() {
    setLoading(true);
    await loadBootstrap();
  }

  const replaceLocalMessageWithServerMessage = useCallback((conversationId: string, localId: string, serverMessage: BackendMessage) => {
    const currentForConversation = messagesByConversationRef.current[conversationId] ?? [];
    const next = upsertMessage(
      currentForConversation.filter((message) => message.id !== localId && message.id !== serverMessage.id),
      serverMessage,
    );
    messagesByConversationRef.current = {
      ...messagesByConversationRef.current,
      [conversationId]: next,
    };
    if (selectedIdRef.current === conversationId) {
      setSelectedMessages(next);
    }
    updateConversationPreview(serverMessage);
  }, [updateConversationPreview]);

  const updateLocalQueuedMessageState = useCallback((conversationId: string, localId: string, localState: ChatMessage["localState"]) => {
    const currentForConversation = messagesByConversationRef.current[conversationId] ?? [];
    const next = currentForConversation.map((message) =>
      message.id === localId ? { ...message, localState } : message,
    );
    messagesByConversationRef.current = {
      ...messagesByConversationRef.current,
      [conversationId]: next,
    };
    if (selectedIdRef.current === conversationId) {
      setSelectedMessages(next);
    }
  }, []);

  const processQueuedOutbox = useCallback(async () => {
    if (Platform.OS !== "web" || !profileId || processingOutboxRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    processingOutboxRef.current = true;
    try {
      const queuedMessages = await listQueuedOutgoingMessages(profileId);
      for (const queued of queuedMessages) {
        try {
          await markQueuedMessageSending(queued.localId);
          updateLocalQueuedMessageState(queued.conversationId, queued.localId, "sending");
          let attachmentId = queued.attachmentId;
          if (!attachmentId && queued.attachment) {
            const file = new File([queued.attachment.file], queued.attachment.name, { type: queued.attachment.mimeType });
            const uploadResult = await messengerApi.uploadMedia({
              durationMs: queued.attachment.durationMs,
              file,
              kind: queued.attachment.kind,
              waveformSamples: queued.attachment.waveformSamples,
            });
            attachmentId = uploadResult.attachment.id;
            await enqueueOutgoingMessage({
              ...queued,
              attachmentId,
              attemptCount: queued.attemptCount + 1,
              lastError: undefined,
              status: "sending",
            });
          }
          const result = await messengerApi.sendMessage({
            attachmentId,
            body: queued.body,
            clientMessageId: queued.localId,
            conversationId: queued.conversationId,
            kind: queued.kind,
            replyToMessageId: queued.replyToMessageId ?? null,
            replyTo: queued.replyTo ?? null,
            ...(queued.taskManagerText && queued.taskManagerText !== queued.body ? { taskManagerText: queued.taskManagerText } : {}),
          });
          const queuedLocalMessage = messagesByConversationRef.current[queued.conversationId]?.find((message) => message.id === queued.localId);
          const mergedMessage = mergeAttachmentWaveforms(result.message, queuedLocalMessage);
          await completeQueuedMessage(queued.localId, mergedMessage);
          replaceLocalMessageWithServerMessage(queued.conversationId, queued.localId, mergedMessage);
          void hapticMessageSent();
          const conversation = conversationsRef.current.find((item) => item.id === queued.conversationId);
          if (
            conversation &&
            shouldExpectTaskManagerAgentReply(conversation, queued.taskManagerText || queued.body) &&
            result.taskManagerForward?.forwarded !== false
          ) {
            setAgentThinkingFor((current) => ({ ...current, [queued.conversationId]: mergedMessage.createdAt }));
          }
        } catch (nextError) {
          const reason = nextError instanceof Error ? nextError.message : "Unable to send queued message.";
          await failQueuedMessage(queued.localId, reason);
          updateLocalQueuedMessageState(queued.conversationId, queued.localId, "failed");
          if (!isNetworkSendError(nextError)) {
            setError(reason);
          }
          if (typeof navigator !== "undefined" && !navigator.onLine) break;
        }
      }
    } finally {
      processingOutboxRef.current = false;
    }
  }, [profileId, replaceLocalMessageWithServerMessage, updateLocalQueuedMessageState]);

  useEffect(() => {
    if (Platform.OS !== "web" || !profileId) return undefined;
    void processQueuedOutbox();
    const handleOnline = () => {
      void processQueuedOutbox();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [processQueuedOutbox, profileId]);

  useEffect(() => {
    if (Platform.OS === "web" && profileId && appLifecycleState === "active") {
      void processQueuedOutbox();
    }
  }, [appLifecycleState, processQueuedOutbox, profileId, selectedId]);

  async function uploadProfileAvatarFromSettings() {
    if (uploadingProfilePhoto) return;
    if (Platform.OS !== "web") {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setSettingsNotice("Photo library permission was not granted.");
        return;
      }
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      mediaTypes: ["images"],
      quality: 0.88,
      selectionLimit: 1,
    });
    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    setUploadingProfilePhoto(true);
    setError("");
    try {
      const fileName = asset.fileName || `avatar-${Date.now()}.jpg`;
      const mimeType = asset.mimeType || "image/jpeg";
      const uploaded = await messengerApi.uploadProfileAvatar({
        file: {
          uri: asset.uri,
          name: fileName,
          type: mimeType,
        },
      });

      setProfile(uploaded.profile);
      setSettingsNotice("Profile photo updated.");
      await loadBootstrap();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to upload profile photo right now.");
    } finally {
      setUploadingProfilePhoto(false);
    }
  }

  useEffect(() => {
    setComposerAttachment(null);
    setAttachmentMenuOpen(false);
    setReplyingToMessage(null);
    setMessageActionTarget(null);
  }, [selectedId]);

  const selectConversation = useCallback((conversationId: string) => {
    if (!conversationId) {
      setSelectedId("");
      setSelectedMessages([]);
      setLoadingMessagesFor("");
      setReplyingToMessage(null);
      return;
    }

    const inMemoryMessages = mergeWithConversationPreview(
      conversationId,
      messagesByConversationRef.current[conversationId] ?? [],
    );
    const canUseCachedMessages = inMemoryMessages.length > 0 && !isPreviewOnlyMessageSet(conversationId, inMemoryMessages);
    setSelectedMessages(inMemoryMessages);
    setLoadingMessagesFor(canUseCachedMessages ? "" : conversationId);
    setSelectedId(conversationId);
    setActiveTab("chats");
  }, [isPreviewOnlyMessageSet, mergeWithConversationPreview]);

  const openConversationFromNotification = useCallback((conversationId: string) => {
    if (!conversationId) return;
    setActiveTab("chats");
    const exists = conversationsRef.current.some((conversation) => conversation.id === conversationId);
    if (exists) {
      selectConversation(conversationId);
      return;
    }
    setSelectedId(conversationId);
    setLoadingMessagesFor(conversationId);
    scheduleBootstrapRefresh();
    scheduleMessageRefresh(conversationId);
  }, [scheduleBootstrapRefresh, scheduleMessageRefresh, selectConversation]);

  useEffect(() => {
    if (!profileId || Platform.OS === "web") return undefined;
    let cancelled = false;

    const syncPushToken = async () => {
      try {
        const token = await registerForPushNotifications();
        if (cancelled) return;
        if (token === undefined) return;
        const normalized = token ?? null;
        if (pushTokenRef.current === normalized) return;
        await messengerApi.registerPushToken(normalized);
        pushTokenRef.current = normalized;
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Unable to register push notifications.");
        }
      }
    };

    void syncPushToken();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => {
    if (Platform.OS === "web") return undefined;

    const handleResponse = (response: Notifications.NotificationResponse) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      const conversationId = extractConversationIdFromNotificationData(data);
      openConversationFromNotification(conversationId);
    };

    const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data as Record<string, unknown> | undefined;
      const conversationId = extractConversationIdFromNotificationData(data);
      const activeConversationId = selectedIdRef.current;
      const shouldSuppress =
        appLifecycleStateRef.current === "active" &&
        activeTabRef.current === "chats" &&
        Boolean(activeConversationId) &&
        conversationId === activeConversationId;

      if (!shouldSuppress) return;
      void Notifications.dismissNotificationAsync(notification.request.identifier).catch(() => undefined);
    });

    const responseSubscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) handleResponse(response);
    });

    return () => {
      receivedSubscription.remove();
      responseSubscription.remove();
    };
  }, [openConversationFromNotification]);

  const existingConversationByContactId = useMemo(() => {
    const conversationMap = new Map<string, BackendConversation>();
    conversations.forEach((conversation) => {
      if (conversation.kind !== "direct" && conversation.kind !== "taskmanager") return;
      const peer = conversation.participants.find((participant) => participant.id !== profileId);
      if (peer) conversationMap.set(peer.id, conversation);
    });
    return conversationMap;
  }, [conversations, profileId]);
  const contactsWithDefaultAgent = useMemo(() => {
    const byId = new Map(contacts.map((contact) => [contact.id, contact]));
    conversations.forEach((conversation) => {
      if (conversation.kind !== "direct") return;
      const peer = conversation.participants.find((participant) => participant.id !== profileId);
      if (!peer) return;
      if (peer.about?.trim().toLowerCase() !== "task manager agent") return;
      if (!byId.has(peer.id)) {
        byId.set(peer.id, {
          about: peer.about,
          avatarUrl: peer.avatarUrl,
          displayName: peer.displayName,
          id: peer.id,
          isOnline: peer.isOnline,
          lastSeenAt: peer.lastSeenAt,
          phone: peer.phone,
        });
      }
    });
    return [...byId.values()];
  }, [contacts, conversations, profileId]);
  const savedContactIds = useMemo(() => new Set(contactsWithDefaultAgent.map((contact) => contact.id)), [contactsWithDefaultAgent]);

  const selectedDirectPeer = useMemo(() => {
    if (!selected || selected.kind !== "direct") return null;
    return selected.participants.find((participant) => participant.id !== profileId) ?? null;
  }, [profileId, selected]);
  const selectedPeerIsSaved = Boolean(selectedDirectPeer && savedContactIds.has(selectedDirectPeer.id));
  const selectedUnsavedPeer = selectedDirectPeer && !selectedPeerIsSaved && selectedDirectPeer.phone
    ? { defaultName: peerLabel(selectedDirectPeer), phone: selectedDirectPeer.phone }
    : null;

  useEffect(() => {
    if (!selected?.taskThread) return undefined;
    if (taskOrgMembersByConversationId[selected.id]) return undefined;
    let cancelled = false;
    messengerApi.listTaskmanagerOrgMembers(selected.id)
      .then((result) => {
        if (cancelled) return;
        setTaskOrgMembersByConversationId((current) => ({
          ...current,
          [selected.id]: result.members,
        }));
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Unable to load organization members.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.taskThread, taskOrgMembersByConversationId]);

  const forwardTargets = useMemo<ForwardTarget[]>(() => {
    const conversationTargets = conversations
      .filter((conversation) => conversation.id !== selectedId)
      .map((conversation) => ({
        avatarUrl: conversation.avatarUrl,
        id: conversation.id,
        isBot: isTaskManagerAgentConversation(conversation),
        type: "conversation" as const,
        title: conversation.title,
        subtitle:
          conversation.kind === "group"
            ? `${conversation.participants.length} members`
            : conversation.lastMessage
              ? messagePreviewText(conversation.lastMessage)
              : "Direct chat",
      }));

    const extraContactTargets = contacts
      .filter((contact) => !existingConversationByContactId.has(contact.id))
      .map((contact) => ({
        avatarUrl: contact.avatarUrl,
        id: contact.id,
        isBot: contact.about?.trim().toLowerCase() === "task manager agent",
        type: "contact" as const,
        title: contact.displayName,
        subtitle: contact.phone || "Create direct chat",
      }));

    return [...conversationTargets, ...extraContactTargets];
  }, [contacts, conversations, existingConversationByContactId, selectedId]);

  const chatListContacts = useMemo<ChatListContact[]>(
    () =>
      contactsWithDefaultAgent.map((contact) => ({
        ...contact,
        existingConversationId: existingConversationByContactId.get(contact.id)?.id,
      })),
    [contactsWithDefaultAgent, existingConversationByContactId],
  );
  const taskMemberCandidates = useMemo<BackendProfile[]>(() => {
    if (!selected?.taskThread) return [];
    return (taskOrgMembersByConversationId[selected.id] ?? selected.participants)
      .filter((profile) => profile.id !== profileId)
      .filter((profile) => profile.about?.trim().toLowerCase() !== "task manager agent")
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [profileId, selected, taskOrgMembersByConversationId]);
  const subtaskAssigneeCandidates = useMemo<BackendProfile[]>(() => {
    const byId = new Map<string, BackendProfile>();
    const addCandidate = (candidate: BackendProfile | null | undefined) => {
      if (!candidate) return;
      if (candidate.about?.trim().toLowerCase() === "task manager agent") return;
      byId.set(candidate.id, {
        about: candidate.about,
        avatarUrl: candidate.avatarUrl,
        displayName: candidate.displayName,
        id: candidate.id,
        isOnline: candidate.isOnline,
        lastSeenAt: candidate.lastSeenAt,
        phone: candidate.phone,
      });
    };
    addCandidate(profile);
    if (selected?.taskThread) {
      (taskOrgMembersByConversationId[selected.id] ?? selected.participants).forEach(addCandidate);
    }
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [profile, selected, taskOrgMembersByConversationId]);
  const selectedSubtaskConversations = useMemo(() => {
    const parentTaskId = selected?.taskThread?.taskmanagerTaskId;
    if (!parentTaskId) return [];
    return conversations
      .filter((conversation) => conversation.taskThread?.parentTaskId === parentTaskId)
      .sort((a, b) => (a.taskThread?.taskNumber ?? "").localeCompare(b.taskThread?.taskNumber ?? "", undefined, { numeric: true }));
  }, [conversations, selected]);
  const showAgentFab = !selected;

  function resolveAgentTargetFromSnapshot(
    snapshotConversations: BackendConversation[],
    snapshotContacts: BackendProfile[],
    viewerId: string,
  ) {
    const directAgentConversation =
      snapshotConversations.find((conversation) => isTaskManagerAgentConversation(conversation)) ?? null;
    if (directAgentConversation) {
      return { conversationId: directAgentConversation.id, contactId: "" };
    }

    const agentContact =
      snapshotContacts.find((contact) => contact.about?.trim().toLowerCase() === "task manager agent") ?? null;
    if (!agentContact) {
      return { conversationId: "", contactId: "" };
    }

    const existingDirect = snapshotConversations.find((conversation) => {
      if (conversation.kind !== "direct") return false;
      const peer = conversation.participants.find((participant) => participant.id !== viewerId);
      return peer?.id === agentContact.id;
    });
    return { conversationId: existingDirect?.id ?? "", contactId: agentContact.id };
  }

  async function openContactConversation(otherUserId: string) {
    await run(async () => {
      const existingConversationId = existingConversationByContactId.get(otherUserId)?.id;
      if (existingConversationId) {
        selectConversation(existingConversationId);
        return;
      }
      const result = await messengerApi.createDirectConversation(otherUserId);
      await loadBootstrap();
      selectConversation(result.conversation.id);
    });
  }

  async function openAgentChatFromFab() {
    if (openingAgentFromFabRef.current) return;
    openingAgentFromFabRef.current = true;
    setActiveTab("chats");
    setError("");
    try {
      const viewerId = profile?.id ?? "";
      let target = resolveAgentTargetFromSnapshot(
        conversationsRef.current,
        contactsRef.current,
        viewerId,
      );

      if (target.conversationId) {
        selectConversation(target.conversationId);
        return;
      }

      if (target.contactId) {
        if (target.conversationId) {
          selectConversation(target.conversationId);
          return;
        }
        const result = await messengerApi.createDirectConversation(target.contactId);
        await loadBootstrap();
        selectConversation(result.conversation.id);
        return;
      }

      await loadBootstrap();
      target = resolveAgentTargetFromSnapshot(
        conversationsRef.current,
        contactsRef.current,
        viewerId,
      );

      if (target.conversationId) {
        selectConversation(target.conversationId);
        return;
      }

      if (target.contactId) {
        const result = await messengerApi.createDirectConversation(target.contactId);
        await loadBootstrap();
        selectConversation(result.conversation.id);
        return;
      }

      setError("Task Manager agent is not available for this account yet.");
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unable to open agent chat right now.";
      setError(message === "Route not found." ? "Unable to open agent chat right now. Please retry." : message);
    } finally {
      openingAgentFromFabRef.current = false;
    }
  }

  async function pickImageAttachment() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
      selectionLimit: 1,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setComposerAttachment({
      localId: `attach-${Date.now()}`,
      kind: "image",
      uri: asset.uri,
      name: asset.fileName || `photo-${Date.now()}.jpg`,
      mimeType: asset.mimeType || "image/jpeg",
      sizeBytes: asset.fileSize ?? null,
    });
    setAttachmentMenuOpen(false);
  }

  async function takePhotoAttachment() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError("Camera permission is needed to take a photo.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      mediaTypes: ["images"],
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setComposerAttachment({
      localId: `camera-${Date.now()}`,
      kind: "image",
      uri: asset.uri,
      name: asset.fileName || `camera-${Date.now()}.jpg`,
      mimeType: asset.mimeType || "image/jpeg",
      sizeBytes: asset.fileSize ?? null,
    });
    setAttachmentMenuOpen(false);
  }

  async function pickFileAttachment(kind: "audio" | "document") {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: kind === "audio" ? "audio/*" : DOCUMENT_TYPES,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setComposerAttachment({
      localId: `attach-${Date.now()}`,
      kind,
      uri: asset.uri,
      name: asset.name || `${kind}-${Date.now()}`,
      mimeType: asset.mimeType || (kind === "audio" ? "audio/mpeg" : "application/octet-stream"),
      sizeBytes: asset.size ?? null,
    });
    setAttachmentMenuOpen(false);
  }

  async function forwardMessage(message: ChatMessage, targets: ForwardTarget[]) {
    await run(async () => {
      const destinationConversationIds: string[] = [];
      for (const target of targets) {
        if (target.type === "conversation") {
          destinationConversationIds.push(target.id);
          continue;
        }
        const result = await messengerApi.createDirectConversation(target.id);
        destinationConversationIds.push(result.conversation.id);
      }
      await messengerApi.forwardMessage({
        messageId: message.id,
        destinationConversationIds: [...new Set(destinationConversationIds)],
      });
      setForwardPickerOpen(false);
      setForwardingMessage(null);
      scheduleBootstrapRefresh();
      if (selectedId) scheduleMessageRefresh(selectedId);
    });
  }

  async function sendMessage(
    kind: BackendMessage["kind"] = "text",
    body = draft.trim(),
    attachment = composerAttachment,
    modelBodyOverride?: string,
  ) {
    const text = body.trim();
    const baseModelText = (modelBodyOverride ?? body).trim();
    if (!selected || !profile) return;
    const replyTarget = replyingToMessage?.conversationId === selected.id ? replyingToMessage : null;
    const replyTo = replyTarget ? buildReplyPreviewFromMessage(replyTarget) : null;
    const modelText = replyTo && isTaskManagerAgentConversation(selected)
      ? taskManagerReplyText(replyTo, baseModelText || text)
      : baseModelText;
    if (!text && !modelText && !attachment) return;
    const expectsAgentReply = shouldExpectTaskManagerAgentReply(selected, modelText || text);
    const taskManagerMentioned = isTaskConversation(selected) && hasOrbitaMention(modelText || text);
    if (Platform.OS === "web") {
      console.info("[orbita-web-send] message payload", {
        conversationId: selected.id,
        replyToMessageId: replyTo?.messageId ?? null,
        replyToBody: replyTo?.body?.slice(0, 180) ?? null,
        body: text.slice(0, 180),
        modelText: modelText.slice(0, 180),
        isTaskThread: Boolean(selected.taskThread),
        taskManagerMentioned,
        expectsAgentReply,
      });
    }
    stopTyping(selected.id);
    let resolvedKind = kind;
    if (attachment) {
      resolvedKind = attachment.kind;
    }

    const tempId = createLocalMessageId();
    const optimisticMessage: ChatMessage = {
      id: tempId,
      clientMessageId: tempId,
      conversationId: selected.id,
      senderId: profile.id,
      kind: resolvedKind,
      body: text,
      attachments: attachment
        ? [
            {
              id: attachment.localId,
              kind: attachment.kind,
              mimeType: attachment.mimeType,
              filename: attachment.name,
              sizeBytes: attachment.sizeBytes ?? 0,
              durationMs: attachment.durationMs ?? null,
              waveformSamples: attachment.waveformSamples ?? null,
              url: attachment.uri,
            },
          ]
        : [],
      forwardedFrom: null,
      replyTo,
      replyToMessageId: replyTo?.messageId ?? null,
      createdAt: new Date().toISOString(),
      status: "sent",
      localState: "sending",
    };

    setDraft("");
    setComposerAttachment(null);
    setReplyingToMessage(null);
    setError("");
    setSelectedMessages((current) => {
      const next = [...current, optimisticMessage];
      messagesByConversationRef.current = {
        ...messagesByConversationRef.current,
        [selected.id]: next,
      };
      return next;
    });
    void upsertCachedMessage(profile.id, optimisticMessage).catch(() => undefined);
    updateConversationPreview(optimisticMessage);
    if (expectsAgentReply) {
      setAgentThinkingFor((current) => ({ ...current, [selected.id]: optimisticMessage.createdAt }));
    }

    let attachmentId: string | undefined;
    let webAttachmentFile: File | undefined;
    try {
      if (attachment) {
        if (Platform.OS === "web") {
          const blob = await (await fetch(attachment.uri)).blob();
          webAttachmentFile = new File([blob], attachment.name, { type: attachment.mimeType });
        }
        const uploadResult = await messengerApi.uploadMedia({
          kind: attachment.kind,
          durationMs: attachment.durationMs,
          waveformSamples: attachment.waveformSamples,
          file:
            Platform.OS === "web"
              ? webAttachmentFile!
              : {
                  uri: attachment.uri,
                  name: attachment.name,
                  type: attachment.mimeType,
                },
        });
        attachmentId = uploadResult.attachment.id;
      }

      const result = await messengerApi.sendMessage({
        conversationId: selected.id,
        kind: resolvedKind,
        body: text,
        attachmentId,
        clientMessageId: tempId,
        replyToMessageId: replyTo?.messageId ?? null,
        replyTo,
        taskManagerMentioned,
        ...((modelText && modelText !== text) || taskManagerMentioned ? { taskManagerText: modelText || text } : {}),
      });
      const mergedMessage = mergeAttachmentWaveforms(result.message, optimisticMessage);
      setSelectedMessages((current) => {
        const withoutTemp = current.filter(
          (message) => message.id !== tempId && message.id !== mergedMessage.id,
        );
        const next = [...withoutTemp, mergedMessage];
        messagesByConversationRef.current = {
          ...messagesByConversationRef.current,
          [selected.id]: next,
        };
        return next;
      });
      void replaceCachedMessage(profile.id, selected.id, tempId, mergedMessage).catch(() => undefined);
      updateConversationPreview(mergedMessage);
      void hapticMessageSent();
      if (expectsAgentReply) {
        if (result.taskManagerForward?.forwarded === false) {
          setAgentThinkingFor((current) => {
            const next = { ...current };
            delete next[selected.id];
            return next;
          });
          setError(userFacingTaskManagerError(result.taskManagerForward.reason));
        } else {
          setAgentThinkingFor((current) => ({ ...current, [selected.id]: mergedMessage.createdAt }));
        }
      }
      scheduleBootstrapRefresh();
      scheduleMessageRefresh(selected.id);
    } catch (nextError) {
      const shouldQueue = isNetworkSendError(nextError);
      if (shouldQueue) {
        let queuedAttachment: QueuedOutgoingMessage["attachment"] = null;
        if (attachment) {
          const file = typeof File !== "undefined" && webAttachmentFile
            ? webAttachmentFile
            : new File([await (await fetch(attachment.uri)).blob()], attachment.name, { type: attachment.mimeType });
          queuedAttachment = {
            durationMs: attachment.durationMs ?? null,
            file,
            kind: attachment.kind,
            localId: attachment.localId,
            mimeType: attachment.mimeType,
            name: attachment.name,
            sizeBytes: attachment.sizeBytes ?? file.size,
            waveformSamples: attachment.waveformSamples ?? null,
          };
        }
        await enqueueOutgoingMessage({
          attemptCount: 0,
          attachment: queuedAttachment,
          attachmentId,
          body: text,
          conversationId: selected.id,
          createdAt: optimisticMessage.createdAt,
          kind: resolvedKind,
          lastError: nextError instanceof Error ? nextError.message : undefined,
          localId: tempId,
          replyTo,
          replyToMessageId: replyTo?.messageId ?? null,
          senderId: profile.id,
          status: "queued",
          taskManagerText: (modelText && modelText !== text) || taskManagerMentioned ? modelText || text : undefined,
          userId: profile.id,
        });
        const queuedMessage = { ...optimisticMessage, localState: "queued" as const };
        void upsertCachedMessage(profile.id, queuedMessage).catch(() => undefined);
        setSelectedMessages((current) => {
          const next = current.map((message) =>
            message.id === tempId ? queuedMessage : message,
          );
          messagesByConversationRef.current = {
            ...messagesByConversationRef.current,
            [selected.id]: next,
          };
          return next;
        });
        setError("Message queued. It will send when Orbita is back online.");
        return;
      }
      if (attachment) setComposerAttachment(attachment);
      if (replyTarget) setReplyingToMessage(replyTarget);
      void markCachedMessageFailed(profile.id, optimisticMessage).catch(() => undefined);
      setSelectedMessages((current) => {
        const next = current.map((message) =>
          message.id === tempId ? { ...message, localState: "failed" as const } : message,
        );
        messagesByConversationRef.current = {
          ...messagesByConversationRef.current,
          [selected.id]: next,
        };
        return next;
      });
      setAgentThinkingFor((current) => {
        const next = { ...current };
        delete next[selected.id];
        return next;
      });
      if (expectsAgentReply) {
        const raw = nextError instanceof Error ? nextError.message : "Unable to send message.";
        setError(userFacingTaskManagerError(raw));
      } else {
        setError(nextError instanceof Error ? nextError.message : "Unable to send message.");
      }
    }
  }

  function changeTab(tab: Tab) {
    if (!visibleTabIds.has(tab)) {
      setActiveTab("chats");
      return;
    }
    setActiveTab(tab);
    if (tab !== "chats") selectConversation("");
  }

  const updateTaskThreadStatusFromChatList = useCallback(
    async (taskId: string, status: TaskManagerAdminTask["status"]) => {
      if (!adminSession) {
        setError("Open admin mode before changing task status from the chat list.");
        return;
      }
      const taskConversation = conversations.find(
        (conversation) => conversation.taskThread?.taskmanagerTaskId === taskId,
      );
      await taskManagerAdminApi.updateTaskStatus(adminSession, taskId, status);
      if (taskConversation && isCompletedTaskThreadStatus(status)) {
        await messengerApi.notifyTaskThreadStatusChanged({
          conversationId: taskConversation.id,
          status,
        }).catch((error) => {
          console.error("Unable to notify source agent conversation", error);
        });
      }
      animateNextListLayout();
      setConversations((current) =>
        current.map((conversation) =>
          conversation.taskThread?.taskmanagerTaskId === taskId
            ? {
                ...conversation,
                taskThread: {
                  ...conversation.taskThread,
                  status,
                },
              }
            : conversation,
        ),
      );
      await refreshAdminData(adminSession, { silent: true });
      void retryBootstrap();
    },
    [adminSession, conversations, refreshAdminData, retryBootstrap],
  );

  if (loading) {
    return <AppShellSkeleton />;
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loadingErrorScreen}>
          <View style={styles.emptyIcon}>
            <Ionicons color={colors.primaryDark} name="cloud-offline-outline" size={26} />
          </View>
          <Text style={styles.emptyTitle}>Unable to load Orbita</Text>
          <Text style={styles.emptyCopy}>
            {error || "Check that the Orbita backend is running and reachable from this device."}
          </Text>
          <View style={styles.modalActions}>
            <Pressable onPress={signOut} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressablePressed]}>
              <Text style={styles.secondaryText}>Sign out</Text>
            </Pressable>
            <Pressable onPress={retryBootstrap} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressablePressed]}>
              <Text style={styles.primaryText}>Retry</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const showPanel = isWide || activeTab !== "chats" || !selected;
  const showBottomTabs = !isWide && !(activeTab === "chats" && selected);
  const showAppHeader = isWide || !(activeTab === "chats" && selected);
  const bottomInset = Math.max(insets.bottom, Platform.OS === "android" ? 8 : 0);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={[styles.safe, isDarkTheme && styles.safeDark]}>
      <View style={[styles.appFrame, isDarkTheme && styles.appFrameDark]}>
        {isWide ? <Sidebar activeTab={activeTab} onChange={changeTab} onNewChat={() => setNewChatOpen(true)} tabs={visibleTabs} /> : null}
        <View style={[styles.workspace, isDarkTheme && styles.workspaceDark]}>
          {showAppHeader ? <AppHeader isWide={isWide} /> : null}
          {error ? <Text style={styles.errorBar}>{error}</Text> : null}
          <View
            style={[
              styles.content,
              isDarkTheme && styles.contentDark,
              !isWide && [styles.contentMobile, { paddingBottom: showBottomTabs ? 58 + bottomInset : 0 }],
              !isWide && isDarkTheme && styles.contentMobileDark,
              !isWide && activeTab === "chats" && selected && styles.contentMobileChat,
            ]}
          >
            {showPanel ? (
              <Panel
                activeTab={activeTab}
                adminChats={adminChats}
                adminDepartments={adminDepartments}
                adminEmployeeName={adminEmployeeName}
                adminEmployeeRole={adminEmployeeRole}
                adminLoading={adminLoading}
                adminNotice={adminNotice}
                adminReports={adminReports}
                adminSettings={adminSettings}
                adminSelectedUserId={adminSelectedUserId}
                adminSession={adminSession}
                adminSummary={adminSummary}
                adminTasks={adminTasks}
                adminUsers={adminUsers}
                contacts={chatListContacts}
                conversations={conversations}
                isWide={isWide}
                onCreateGroup={() => setGroupOpen(true)}
                onCreateAdminEmployee={async () => {
                  if (!adminSession || !adminEmployeeName.trim()) return;
                  await taskManagerAdminApi.createUser(adminSession, {
                    name: adminEmployeeName.trim(),
                    role: adminEmployeeRole,
                  });
                  setAdminEmployeeName("");
                  setAdminEmployeeRole("member");
                  await refreshAdminData(adminSession);
                }}
                onNewChat={() => setNewChatOpen(true)}
                onNewStatus={() => setStatusOpen(true)}
                onOpenProfile={() => setProfileOpen(true)}
                onOpenContact={openContactConversation}
                onRefreshAdmin={() => refreshAdminData()}
                onSelectAdminUser={async (userId) => {
                  setAdminSelectedUserId(userId);
                  if (!adminSession) return;
                  const chats = await taskManagerAdminApi.userChats(adminSession, userId);
                  setAdminChats(chats);
                }}
                onSignOut={signOut}
                onSetAdminEmployeeName={setAdminEmployeeName}
                onSetAdminEmployeeRole={setAdminEmployeeRole}
                onSyncDeviceContacts={syncDeviceContacts}
                onUpdateTaskThreadStatus={updateTaskThreadStatusFromChatList}
                onUpdateAdminTaskStatus={async (taskId, status) => {
                  if (!adminSession) return;
                  await taskManagerAdminApi.updateTaskStatus(adminSession, taskId, status);
                  await refreshAdminData(adminSession, { silent: true });
                }}
                onUploadProfilePhoto={uploadProfileAvatarFromSettings}
                isSyncingDeviceContacts={syncingContacts}
                isUploadingProfilePhoto={uploadingProfilePhoto}
                onSelect={selectConversation}
                profile={profile}
                selectedId={selected?.id}
                settingsNotice={settingsNotice}
                statuses={statuses}
              />
            ) : null}
            {activeTab === "chats" && selected ? (
              <ChatPane
                attachment={composerAttachment}
                agentThinking={Boolean(selected && agentThinkingFor[selected.id])}
                bottomInset={bottomInset}
                conversation={selected}
                currentUserId={profile.id}
                draft={draft}
                isWide={isWide}
                loadingOlder={loadingOlderFor === selected.id}
                messages={selectedMessages.filter((message) => message.conversationId === selected.id)}
                messagesLoading={loadingMessagesFor === selected.id}
                onAddMembers={() => setMembersOpen(true)}
                onCreateSubtask={() => setSubtaskParentConversation(selected)}
                onMessageActions={setMessageActionTarget}
                onOpenMemberDirect={openContactConversation}
                onOpenSubtask={(conversationId) => selectConversation(conversationId)}
                onReplyToMessage={setReplyingToMessage}
                onLoadOlder={() => loadOlderMessages(selected.id)}
                onOpenAttachmentMenu={() => setAttachmentMenuOpen(true)}
                onTakePhoto={() => void takePhotoAttachment()}
                onBack={() => selectConversation("")}
                onRemoveAttachment={() => setComposerAttachment(null)}
                onRemoveReply={() => setReplyingToMessage(null)}
                onSend={(nextKind, nextBody, nextAttachment, modelBodyOverride) =>
                  sendMessage(nextKind, nextBody, nextAttachment, modelBodyOverride)}
                onSaveContact={() => {
                  if (selectedUnsavedPeer) setSaveContactPeer(selectedUnsavedPeer);
                }}
                setDraft={handleDraftChange}
                replyingToMessage={replyingToMessage?.conversationId === selected.id ? replyingToMessage : null}
                subtaskConversations={selectedSubtaskConversations}
                typingText={typingStatusText(selectedTypingParticipants)}
                unsavedPeer={selectedUnsavedPeer}
              />
            ) : isWide && activeTab === "chats" ? (
              <DesktopEmpty />
            ) : null}
          </View>
        </View>
      </View>
      {showBottomTabs ? (
        <BottomTabs activeTab={activeTab} bottomInset={bottomInset} onChange={changeTab} tabs={visibleTabs} unreadTotal={unreadTotal} />
      ) : null}
      {showAgentFab ? (
        <Pressable
          accessibilityLabel="Open agent chat"
          onPress={() => {
            void openAgentChatFromFab();
          }}
          style={({ pressed }) => [
            styles.agentFab,
            { backgroundColor: themeColors.primaryDark, borderColor: themeColors.primary },
            isDarkTheme && styles.agentFabDark,
            isDarkTheme && { backgroundColor: themeColors.accent, borderColor: themeColors.accent },
            { bottom: showBottomTabs ? 66 + bottomInset : 20 + bottomInset },
            pressed && styles.pressablePressed,
          ]}
        >
          <Ionicons color={isDarkTheme ? themeColors.primaryDark : "#FFFFFF"} name="sparkles" size={18} />
          <Text style={[styles.agentFabText, isDarkTheme && styles.agentFabTextDark]}>Agent</Text>
        </Pressable>
      ) : null}
      {busy ? <View style={styles.busyOverlay}><ActivityIndicator color="#FFFFFF" /></View> : null}
      <NewChatModal
        contacts={contacts}
        onClose={() => setNewChatOpen(false)}
        onContactAdded={async () => loadBootstrap()}
        onOpenConversation={async (otherUserId) => {
          setNewChatOpen(false);
          await openContactConversation(otherUserId);
        }}
        visible={newChatOpen}
      />
      <SaveContactModal
        onClose={() => setSaveContactPeer(null)}
        onSave={async (nickname) => {
          if (!saveContactPeer) return;
          await run(async () => {
            await messengerApi.addContactByPhone(saveContactPeer.phone, nickname);
            setSaveContactPeer(null);
            await loadBootstrap();
          });
        }}
        peer={saveContactPeer}
        visible={Boolean(saveContactPeer)}
      />
      <GroupModal
        contacts={contacts}
        onClose={() => setGroupOpen(false)}
        onCreate={async (title, memberIds) => {
          await run(async () => {
            const result = await messengerApi.createGroup(title, memberIds);
            setGroupOpen(false);
            await loadBootstrap();
            selectConversation(result.conversation.id);
          });
        }}
        visible={groupOpen}
      />
      <AddMembersModal
        contacts={selected?.taskThread ? taskMemberCandidates : contacts}
        conversation={selected}
        onClose={() => setMembersOpen(false)}
        onSave={async (memberIds) => {
          if (!selected) return;
          await run(async () => {
            if (selected.taskThread) {
              await messengerApi.addTaskThreadMembers(selected.id, memberIds);
            } else {
              await messengerApi.addGroupMembers(selected.id, memberIds);
            }
            setMembersOpen(false);
            await loadBootstrap();
          });
        }}
        visible={membersOpen}
      />
      <CreateTaskThreadSubtaskModal
        contacts={subtaskAssigneeCandidates}
        onClose={() => setSubtaskParentConversation(null)}
        onCreate={async (input) => {
          if (!subtaskParentConversation) return;
          setBusy(true);
          setError("");
          try {
            await messengerApi.createTaskThreadSubtask({
              conversationId: subtaskParentConversation.id,
              ...input,
            });
            setSubtaskParentConversation(null);
            await loadBootstrap();
          } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "Unable to create subtask.");
            throw nextError;
          } finally {
            setBusy(false);
          }
        }}
        parent={subtaskParentConversation}
        visible={Boolean(subtaskParentConversation)}
      />
      <StatusModal
        onClose={() => setStatusOpen(false)}
        onCreate={async (text) => {
          await run(async () => {
            await messengerApi.createStatus({ text, visibility: "contacts" });
            setStatusOpen(false);
            await loadBootstrap();
          });
        }}
        visible={statusOpen}
      />
      <ProfileModal
        onClose={() => setProfileOpen(false)}
        onSave={async (displayName, about) => {
          await run(async () => {
            const result = await messengerApi.updateProfile({ displayName, about });
            setProfile(result.profile);
            setProfileOpen(false);
            await loadBootstrap();
          });
        }}
        profile={profile}
        visible={profileOpen}
      />
      <AttachmentMenuModal
        onClose={() => setAttachmentMenuOpen(false)}
        onPickAudio={() => void pickFileAttachment("audio")}
        onPickDocument={() => void pickFileAttachment("document")}
        onPickImage={() => void pickImageAttachment()}
        visible={attachmentMenuOpen}
      />
      <MessageActionsModal
        anchor={messageActionTarget?.anchor}
        message={messageActionTarget?.message ?? null}
        onClose={() => setMessageActionTarget(null)}
        onReply={(message) => {
          setMessageActionTarget(null);
          setReplyingToMessage(message);
        }}
        visible={Boolean(messageActionTarget)}
      />
      <ForwardPickerModal
        message={forwardingMessage}
        onClose={() => {
          setForwardPickerOpen(false);
          setForwardingMessage(null);
        }}
        onSubmit={(targets) => (forwardingMessage ? forwardMessage(forwardingMessage, targets) : Promise.resolve())}
        targets={forwardTargets}
        visible={forwardPickerOpen}
      />
    </SafeAreaView>
  );
}

function AppHeader({
  isWide,
}: {
  isWide: boolean;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View style={[styles.header, isDarkTheme && styles.headerDark, !isWide && styles.headerMobile]}>
      <OrbitaBrand compact={!isWide} inverse={isDarkTheme} />
    </View>
  );
}

function Sidebar({
  activeTab,
  onChange,
  onNewChat,
  tabs: visibleTabs,
}: {
  activeTab: Tab;
  onChange: (tab: Tab) => void;
  onNewChat: () => void;
  tabs: Array<{ id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }>;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View
      style={[
        styles.sidebar,
        { backgroundColor: isDarkTheme ? "#111B21" : themeColors.primaryDark },
        isDarkTheme && styles.sidebarDark,
      ]}
    >
      <View style={styles.brandMark}>
        <OrbitaLogo size={36} />
      </View>
      <View style={styles.navStack}>
        {visibleTabs.map((tab) => (
          <Pressable
            accessibilityLabel={tab.label}
            key={tab.id}
            onPress={() => onChange(tab.id)}
            style={({ pressed }) => [
              styles.navItem,
              activeTab === tab.id && [
                styles.navItemActive,
                {
                  backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft,
                  borderColor: isDarkTheme ? themeColors.accent : themeColors.primarySoft,
                },
              ],
              pressed && styles.pressablePressed,
            ]}
          >
            <Ionicons color={activeTab === tab.id ? themeColors.primaryDark : "rgba(255,255,255,0.76)"} name={tab.icon} size={22} />
            <Text style={[styles.navLabel, activeTab === tab.id && styles.navLabelActive, activeTab === tab.id && { color: themeColors.primaryDark }]}>{tab.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityLabel="New chat"
        onPress={onNewChat}
        style={({ pressed }) => [styles.composeButton, { backgroundColor: themeColors.primary }, pressed && styles.pressablePressed]}
      >
        <Ionicons color="#FFFFFF" name="add" size={26} />
      </Pressable>
    </View>
  );
}

function BottomTabs({
  activeTab,
  bottomInset,
  onChange,
  tabs: visibleTabs,
  unreadTotal,
}: {
  activeTab: Tab;
  bottomInset: number;
  onChange: (tab: Tab) => void;
  tabs: Array<{ id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }>;
  unreadTotal: number;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View style={[styles.bottomTabs, isDarkTheme && styles.bottomTabsDark, { paddingBottom: bottomInset + 8 }]}>
      {visibleTabs.map((tab) => (
        <Pressable
          accessibilityLabel={tab.label}
          key={tab.id}
          onPress={() => onChange(tab.id)}
          style={({ pressed }) => [styles.bottomTab, pressed && styles.bottomTabPressed]}
        >
          <View>
            <Ionicons
              color={activeTab === tab.id ? (isDarkTheme ? themeColors.accent : themeColors.primaryDark) : isDarkTheme ? "rgba(255,255,255,0.58)" : colors.muted}
              name={tab.icon}
              size={21}
            />
            {tab.id === "chats" && unreadTotal > 0 ? <UnreadBadge count={unreadTotal} compact /> : null}
          </View>
          <Text
            style={[
              styles.bottomTabLabel,
              isDarkTheme && styles.bottomTabLabelDark,
              activeTab === tab.id && styles.bottomTabLabelActive,
              isDarkTheme && activeTab === tab.id && styles.bottomTabLabelActiveDark,
              activeTab === tab.id && { color: isDarkTheme ? themeColors.accent : themeColors.primaryDark },
            ]}
          >
            {tab.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function UnreadBadge({ compact, count }: { compact?: boolean; count: number }) {
  const { themeColors } = useAppTheme();
  const label = count > 99 ? "99+" : String(count);
  return (
    <View style={[styles.unreadBadge, { backgroundColor: themeColors.primaryDark }, compact && styles.unreadBadgeCompact]}>
      <Text style={styles.unreadBadgeText}>{label}</Text>
    </View>
  );
}

function Panel({
  activeTab,
  adminChats,
  adminDepartments,
  adminEmployeeName,
  adminEmployeeRole,
  adminLoading,
  adminNotice,
  adminReports,
  adminSettings,
  adminSelectedUserId,
  adminSession,
  adminSummary,
  adminTasks,
  adminUsers,
  contacts,
  conversations,
  isWide,
  onCreateAdminEmployee,
  onCreateGroup,
  onOpenContact,
  onNewChat,
  onNewStatus,
  onOpenProfile,
  onRefreshAdmin,
  onSelect,
  onSelectAdminUser,
  onSetAdminEmployeeName,
  onSetAdminEmployeeRole,
  onSignOut,
  onSyncDeviceContacts,
  onUpdateAdminTaskStatus,
  onUpdateTaskThreadStatus,
  onUploadProfilePhoto,
  isSyncingDeviceContacts,
  isUploadingProfilePhoto,
  profile,
  selectedId,
  settingsNotice,
  statuses,
}: {
  activeTab: Tab;
  adminChats: TaskManagerChatMessage[];
  adminDepartments: TaskManagerDepartment[];
  adminEmployeeName: string;
  adminEmployeeRole: "admin" | "member";
  adminLoading: boolean;
  adminNotice: string;
  adminReports: Awaited<ReturnType<typeof taskManagerAdminApi.taskReports>> | null;
  adminSettings: Record<string, unknown> | null;
  adminSelectedUserId: string;
  adminSession: TaskManagerAdminSession | null;
  adminSummary: TaskManagerAdminSummary | null;
  adminTasks: TaskManagerAdminTask[];
  adminUsers: TaskManagerAdminUser[];
  contacts: ChatListContact[];
  conversations: BackendConversation[];
  isWide: boolean;
  onCreateAdminEmployee: () => Promise<void>;
  onCreateGroup: () => void;
  onOpenContact: (contactId: string) => void;
  onNewChat: () => void;
  onNewStatus: () => void;
  onOpenProfile: () => void;
  onRefreshAdmin: () => void;
  onSelect: (id: string) => void;
  onSelectAdminUser: (userId: string) => Promise<void>;
  onSetAdminEmployeeName: (value: string) => void;
  onSetAdminEmployeeRole: (value: "admin" | "member") => void;
  onSignOut: () => void;
  onSyncDeviceContacts: () => void;
  onUpdateAdminTaskStatus: (taskId: string, status: TaskManagerAdminTask["status"]) => Promise<void>;
  onUpdateTaskThreadStatus: (taskId: string, status: TaskManagerAdminTask["status"]) => Promise<void>;
  onUploadProfilePhoto: () => void;
  isSyncingDeviceContacts: boolean;
  isUploadingProfilePhoto: boolean;
  profile: BackendProfile;
  selectedId?: string;
  settingsNotice: string;
  statuses: BackendStatus[];
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  if (activeTab === "status") {
    return <StatusPanel isWide={isWide} onNewStatus={onNewStatus} profile={profile} statuses={statuses} />;
  }
  if (activeTab === "contacts") {
    return (
      <ContactsPanel
        contacts={contacts}
        isWide={isWide}
        onCreateGroup={onCreateGroup}
        onNewChat={onNewChat}
        onOpenContact={onOpenContact}
      />
    );
  }
  if (activeTab === "calls") {
    return <CallsPanel isWide={isWide} />;
  }
  if (activeTab === "admin") {
    return (
      <AdminPanelV2
        chats={adminChats}
        departments={adminDepartments}
        employeeName={adminEmployeeName}
        employeeRole={adminEmployeeRole}
        isWide={isWide}
        loading={adminLoading}
        notice={adminNotice}
        onCreateEmployee={onCreateAdminEmployee}
        onRefresh={onRefreshAdmin}
        onSelectUser={onSelectAdminUser}
        onSetEmployeeName={onSetAdminEmployeeName}
        onSetEmployeeRole={onSetAdminEmployeeRole}
        onUpdateTaskStatus={onUpdateAdminTaskStatus}
        reports={adminReports}
        settings={adminSettings}
        selectedUserId={adminSelectedUserId}
        session={adminSession}
        summary={adminSummary}
        tasks={adminTasks}
        users={adminUsers}
      />
    );
  }
  if (activeTab === "settings") {
    return (
      <SettingsPanel
        isWide={isWide}
        notice={settingsNotice}
        onNewChat={onNewChat}
        onOpenProfile={onOpenProfile}
        onSignOut={onSignOut}
        onSyncDeviceContacts={onSyncDeviceContacts}
        onUploadProfilePhoto={onUploadProfilePhoto}
        isSyncingDeviceContacts={isSyncingDeviceContacts}
        isUploadingProfilePhoto={isUploadingProfilePhoto}
        profile={profile}
      />
    );
  }

  return (
    <ChatsPanel
      contacts={contacts}
      conversations={conversations}
      isWide={isWide}
      onNewChat={onNewChat}
      onOpenContact={onOpenContact}
      onSelect={onSelect}
      onUpdateTaskStatus={onUpdateTaskThreadStatus}
      selectedId={selectedId}
    />
  );
}

function AdminPanelV2({
  chats,
  departments,
  employeeName,
  employeeRole,
  isWide,
  loading,
  notice,
  onCreateEmployee,
  onRefresh,
  onSelectUser,
  onSetEmployeeName,
  onSetEmployeeRole,
  onUpdateTaskStatus,
  reports,
  settings,
  selectedUserId,
  session,
  summary,
  tasks,
  users,
}: {
  chats: TaskManagerChatMessage[];
  departments: TaskManagerDepartment[];
  employeeName: string;
  employeeRole: "admin" | "member";
  isWide: boolean;
  loading: boolean;
  notice: string;
  onCreateEmployee: () => Promise<void>;
  onRefresh: () => void;
  onSelectUser: (userId: string) => Promise<void>;
  onSetEmployeeName: (value: string) => void;
  onSetEmployeeRole: (value: "admin" | "member") => void;
  onUpdateTaskStatus: (taskId: string, status: TaskManagerAdminTask["status"]) => Promise<void>;
  reports: Awaited<ReturnType<typeof taskManagerAdminApi.taskReports>> | null;
  settings: Record<string, unknown> | null;
  selectedUserId: string;
  session: TaskManagerAdminSession | null;
  summary: TaskManagerAdminSummary | null;
  tasks: TaskManagerAdminTask[];
  users: TaskManagerAdminUser[];
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const [section, setSection] = useState<AdminSectionId>("overview");
  const [expandedDepartmentIds, setExpandedDepartmentIds] = useState<Record<string, boolean>>({});
  const [departmentDetailsById, setDepartmentDetailsById] = useState<Record<string, TaskManagerDepartmentDetails>>({});
  const [departmentLoadingById, setDepartmentLoadingById] = useState<Record<string, boolean>>({});
  const [taskAssigneeFilter, setTaskAssigneeFilter] = useState("all");
  const [taskAssigneeSearch, setTaskAssigneeSearch] = useState("");
  const [taskFilterOpen, setTaskFilterOpen] = useState(false);
  const [updatingTaskIds, setUpdatingTaskIds] = useState<Record<string, boolean>>({});
  const [taskNotice, setTaskNotice] = useState("");
  void employeeName;
  void employeeRole;
  void chats;
  void onCreateEmployee;
  void onSetEmployeeName;
  void onSetEmployeeRole;
  if (!session) {
    return (
      <View style={[styles.listPanel, styles.adminPanel, isWide && styles.adminPanelWide, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
        <EmptyState icon="lock-closed-outline" title="Admin mode unavailable" copy="Only linked Task Manager admin users can open this section." />
      </View>
    );
  }

  const currentAdminSession = session;
  const selectedUser = users.find((user) => user._id === selectedUserId) ?? users[0] ?? null;
  const normalizedTaskAssigneeSearch = taskAssigneeSearch.trim().toLowerCase();
  const filteredAssigneeOptions = users.filter((user) => {
    if (!normalizedTaskAssigneeSearch) return true;
    return user.name.toLowerCase().includes(normalizedTaskAssigneeSearch);
  });
  const visibleTasks = taskAssigneeFilter === "all"
    ? tasks
    : tasks.filter((task) => task.assignee_id === taskAssigneeFilter);
  const selectedTaskAssignee = users.find((user) => user._id === taskAssigneeFilter) ?? null;
  const openTasks = summary?.tasks.open ?? tasks.filter((task) => task.status === "open").length;
  const inProgressTasks = summary?.tasks.in_progress ?? tasks.filter((task) => task.status === "in_progress").length;
  const overdueTasks = summary?.tasks.overdue ?? 0;
  const doneRate = summary?.completion_rate ?? reports?.summary.completion_rate ?? 0;
  const activeTasks = openTasks + inProgressTasks;
  const adminCount = users.filter((user) => user.role === "admin").length;
  const orbitaCount = users.filter((user) => user.agent_channel === "orbita").length;
  const recentTasks = summary?.recent_activity?.length ? summary.recent_activity : tasks.slice(0, 5);
  const sections: Array<{ id: AdminSectionId; label: string; icon: keyof typeof Ionicons.glyphMap; count?: number | string }> = [
    { id: "overview", label: "Overview", icon: "grid-outline" },
    { id: "employees", label: "Employees", icon: "people-outline", count: users.length },
    { id: "tasks", label: "Tasks", icon: "checkbox-outline", count: activeTasks },
    { id: "reports", label: "Reports", icon: "bar-chart-outline", count: `${doneRate}%` },
    { id: "departments", label: "Departments", icon: "business-outline", count: departments.length },
    { id: "settings", label: "Settings", icon: "options-outline" },
  ];

  async function toggleDepartment(departmentId: string) {
    const willExpand = !expandedDepartmentIds[departmentId];
    setExpandedDepartmentIds((current) => ({ ...current, [departmentId]: willExpand }));
    if (!willExpand || departmentDetailsById[departmentId] || departmentLoadingById[departmentId]) return;
    setDepartmentLoadingById((current) => ({ ...current, [departmentId]: true }));
    try {
      const details = await taskManagerAdminApi.department(currentAdminSession, departmentId);
      setDepartmentDetailsById((current) => ({ ...current, [departmentId]: details }));
    } catch (error) {
      setTaskNotice(error instanceof Error ? error.message : "Unable to load department members.");
    } finally {
      setDepartmentLoadingById((current) => ({ ...current, [departmentId]: false }));
    }
  }

  async function updateTaskStatus(task: TaskManagerAdminTask) {
    if (updatingTaskIds[task._id]) return;
    const nextStatus: TaskManagerAdminTask["status"] = task.status === "done" ? "open" : "done";
    setTaskNotice("");
    setUpdatingTaskIds((current) => ({ ...current, [task._id]: true }));
    try {
      await onUpdateTaskStatus(task._id, nextStatus);
    } catch (error) {
      setTaskNotice(error instanceof Error ? error.message : "Unable to update task status.");
    } finally {
      setUpdatingTaskIds((current) => ({ ...current, [task._id]: false }));
    }
  }

  return (
    <View style={[styles.listPanel, styles.adminPanel, isWide && styles.adminPanelWide, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <View style={[styles.adminHeader, isDarkTheme && styles.adminHeaderDark]}>
        <View>
          <Text style={[styles.adminEyebrow, isDarkTheme && styles.adminMutedText]}>Task Manager</Text>
          <Text style={[styles.adminTitle, isDarkTheme && styles.chatTitleDark]}>{session.orgName}</Text>
        </View>
        <Pressable
          accessibilityLabel="Refresh admin data"
          onPress={onRefresh}
          style={({ pressed }) => [
            styles.searchAddButton,
            { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft, borderColor: isDarkTheme ? themeColors.primaryDark : themeColors.primarySoft },
            isDarkTheme && styles.searchAddButtonDark,
            pressed && styles.pressablePressed,
          ]}
        >
          {loading ? <ActivityIndicator color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} /> : <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="refresh-outline" size={20} />}
        </Pressable>
      </View>
      {notice ? <Text style={styles.errorBar}>{notice}</Text> : null}
      <ScrollView contentContainerStyle={[styles.adminContent, isWide && styles.adminContentWide, isDarkTheme && styles.listContentDark]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.adminSectionTabs}>
          {sections.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => setSection(item.id)}
              style={({ pressed }) => [
                styles.adminSectionTab,
                isDarkTheme && styles.adminSectionTabDark,
                section === item.id && [styles.adminSectionTabActive, { backgroundColor: themeColors.primaryDark, borderColor: themeColors.primaryDark }],
                pressed && styles.pressablePressed,
              ]}
            >
              <Ionicons color={section === item.id ? "#FFFFFF" : isDarkTheme ? themeColors.accent : themeColors.primaryDark} name={item.icon} size={16} />
              <Text style={[styles.adminSectionTabText, { color: isDarkTheme ? themeColors.accent : themeColors.primaryDark }, isDarkTheme && styles.adminMutedText, section === item.id && styles.adminSectionTabTextActive]}>{item.label}</Text>
              {item.count !== undefined ? <Text style={[styles.adminSectionTabCount, section === item.id && styles.adminSectionTabTextActive]}>{item.count}</Text> : null}
            </Pressable>
          ))}
        </ScrollView>

        {section === "overview" ? (
          <>
            <View style={styles.adminMetricGrid}>
              <AdminMetric label="Employees" value={summary?.employees ?? users.length} />
              <AdminMetric label="Active" value={activeTasks} />
              <AdminMetric label="Overdue" value={overdueTasks} tone="danger" />
              <AdminMetric label="Done" value={`${doneRate}%`} tone="success" />
            </View>
            <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
              <AdminSectionHeader title="Operations" meta="Quick scan" />
              <View style={styles.adminOverviewGrid}>
                <AdminCompactStat label="Admins" value={adminCount} />
                <AdminCompactStat label="Orbita" value={orbitaCount} />
                <AdminCompactStat label="Departments" value={departments.length} />
                <AdminCompactStat label="Open" value={openTasks} />
              </View>
            </View>
            <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
              <AdminSectionHeader title="Recent Tasks" meta={`${recentTasks.length} latest`} />
              {recentTasks.slice(0, 5).map((task) => (
                <AdminTaskRow
                  key={task._id}
                  compact
                  isDarkTheme={isDarkTheme}
                  isUpdating={Boolean(updatingTaskIds[task._id])}
                  onUpdateTaskStatus={updateTaskStatus}
                  task={task}
                  userName={users.find((user) => user._id === task.assignee_id)?.name}
                />
              ))}
              {!recentTasks.length ? <AdminEmptyLine text="No recent tasks." /> : null}
            </View>
          </>
        ) : null}

        {section === "employees" ? (
          <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
            <AdminSectionHeader title="Employees" meta={`${users.length} people`} />
            {users.map((user) => (
              <Pressable
                key={user._id}
                onPress={() => void onSelectUser(user._id)}
                style={({ pressed }) => [
                  styles.adminListRow,
                  isDarkTheme && styles.adminListRowDark,
                  selectedUser?._id === user._id && [styles.adminListRowActive, { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft, borderColor: isDarkTheme ? themeColors.primaryDark : themeColors.primarySoft }],
                  selectedUser?._id === user._id && isDarkTheme && styles.adminListRowActiveDark,
                  pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                ]}
              >
                <View>
                  <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{user.name}</Text>
                  <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{user.role} - {user.agent_channel ?? "whatsapp"}</Text>
                </View>
                <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="chatbubble-ellipses-outline" size={18} />
              </Pressable>
            ))}
          </View>
        ) : null}

        {section === "tasks" ? (
          <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
            <AdminSectionHeader title="Tasks" meta={`${visibleTasks.length} shown, ${openTasks} open`} />
            {taskNotice ? <Text style={styles.errorBar}>{taskNotice}</Text> : null}
            <View style={[styles.adminFilterCard, isDarkTheme && styles.adminFilterCardDark]}>
              <Pressable
                accessibilityLabel="Filter tasks by employee"
                onPress={() => setTaskFilterOpen((current) => !current)}
                style={({ pressed }) => [styles.adminFilterTrigger, pressed && styles.pressablePressed]}
              >
                <View>
                  <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>Employee filter</Text>
                  <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>
                    {selectedTaskAssignee?.name ?? "All employees"}
                  </Text>
                </View>
                <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name={taskFilterOpen ? "chevron-up" : "chevron-down"} size={18} />
              </Pressable>
              {taskFilterOpen ? (
                <View style={styles.adminFilterMenu}>
                  <View style={[styles.searchBox, isDarkTheme && styles.searchBoxDark]}>
                    <Ionicons color={isDarkTheme ? "rgba(255,255,255,0.58)" : colors.muted} name="search-outline" size={17} />
                    <TextInput
                      onChangeText={setTaskAssigneeSearch}
                      placeholder="Search employees"
                      placeholderTextColor={isDarkTheme ? "rgba(255,255,255,0.45)" : colors.faint}
                      style={[styles.searchInput, isDarkTheme && styles.searchInputDark]}
                      value={taskAssigneeSearch}
                    />
                  </View>
                  <Pressable
                    onPress={() => {
                      setTaskAssigneeFilter("all");
                      setTaskFilterOpen(false);
                    }}
                    style={({ pressed }) => [
                      styles.adminFilterOption,
                      isDarkTheme && styles.adminFilterOptionDark,
                      taskAssigneeFilter === "all" && [styles.adminFilterOptionActive, { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft, borderColor: isDarkTheme ? themeColors.primaryDark : themeColors.primarySoft }],
                      taskAssigneeFilter === "all" && isDarkTheme && styles.adminFilterOptionActiveDark,
                      pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                    ]}
                  >
                    <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>All employees</Text>
                    <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{tasks.length} tasks</Text>
                  </Pressable>
                  {filteredAssigneeOptions.map((user) => {
                    const taskCount = tasks.filter((task) => task.assignee_id === user._id).length;
                    return (
                      <Pressable
                        key={user._id}
                        onPress={() => {
                          setTaskAssigneeFilter(user._id);
                          setTaskFilterOpen(false);
                        }}
                        style={({ pressed }) => [
                          styles.adminFilterOption,
                          isDarkTheme && styles.adminFilterOptionDark,
                          taskAssigneeFilter === user._id && [styles.adminFilterOptionActive, { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft, borderColor: isDarkTheme ? themeColors.primaryDark : themeColors.primarySoft }],
                          taskAssigneeFilter === user._id && isDarkTheme && styles.adminFilterOptionActiveDark,
                          pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                        ]}
                      >
                        <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{user.name}</Text>
                        <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{taskCount} tasks</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
            {visibleTasks.slice(0, 24).map((task) => (
              <AdminTaskRow
                key={task._id}
                isDarkTheme={isDarkTheme}
                isUpdating={Boolean(updatingTaskIds[task._id])}
                onUpdateTaskStatus={updateTaskStatus}
                task={task}
                userName={users.find((user) => user._id === task.assignee_id)?.name}
              />
            ))}
            {!visibleTasks.length ? <AdminEmptyLine text="No tasks match this filter." /> : null}
          </View>
        ) : null}

        {section === "reports" ? (
          <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
            <AdminSectionHeader title="Reports" meta="Task performance" />
            <View style={styles.adminOverviewGrid}>
              <AdminCompactStat label="Total" value={reports?.summary.total ?? tasks.length} />
              <AdminCompactStat label="Done" value={reports?.summary.done ?? summary?.tasks.done ?? 0} />
              <AdminCompactStat label="Discarded" value={reports?.summary.discarded ?? summary?.tasks.discarded ?? 0} />
              <AdminCompactStat label="Rate" value={`${doneRate}%`} />
            </View>
            {(reports?.by_assignee ?? []).slice(0, 8).map((row) => {
              const user = users.find((item) => item._id === row.user_id);
              return (
                <View key={row.user_id} style={[styles.adminListRow, isDarkTheme && styles.adminListRowDark]}>
                  <View>
                    <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{user?.name ?? row.user_id}</Text>
                    <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{row.done} done of {row.total}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        {section === "departments" ? (
          <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
            <AdminSectionHeader title="Departments" meta={`${departments.length} groups`} />
            <View style={styles.adminDepartmentList}>
              {departments.map((department) => {
                const isExpanded = Boolean(expandedDepartmentIds[department._id]);
                const details = departmentDetailsById[department._id];
                const isDepartmentLoading = Boolean(departmentLoadingById[department._id]);
                return (
                  <View key={department._id} style={[styles.adminDepartmentCard, isDarkTheme && styles.adminListRowDark]}>
                    <Pressable
                      onPress={() => void toggleDepartment(department._id)}
                      style={({ pressed }) => [styles.adminDepartmentTrigger, pressed && styles.pressablePressed]}
                    >
                      <View>
                        <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{department.name}</Text>
                        <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{department.member_count ?? 0} members</Text>
                      </View>
                      <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name={isExpanded ? "chevron-up" : "chevron-down"} size={18} />
                    </Pressable>
                    {isExpanded ? (
                      <View style={styles.adminDepartmentMembersInline}>
                        {isDepartmentLoading ? <ActivityIndicator color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} /> : null}
                        {details?.members.map((member) => (
                          <Pressable
                            key={member.user_id}
                            onPress={() => void onSelectUser(member.user_id)}
                            style={({ pressed }) => [
                              styles.adminChatRow,
                              isDarkTheme && styles.adminChatRowDark,
                              pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                            ]}
                          >
                            <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{member.name}</Text>
                            <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>
                              {[member.role, ...(member.roles ?? [])].filter(Boolean).join(" - ") || "member"}
                            </Text>
                          </Pressable>
                        ))}
                        {!isDepartmentLoading && details && !details.members.length ? <AdminEmptyLine text="No employees are assigned to this department." /> : null}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
            {!departments.length ? <AdminEmptyLine text="No departments yet." /> : null}
          </View>
        ) : null}

        {section === "settings" ? (
          <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
            <AdminSectionHeader title="Settings" meta="Organization controls" />
            {[
              ["Agent", settings?.agent_name],
              ["Mode", settings?.mode],
              ["AI", settings?.ai_enabled === false ? "off" : "on"],
              ["Primary color", settings?.primary_color],
            ].map(([label, value]) => (
              <View key={String(label)} style={[styles.adminListRow, isDarkTheme && styles.adminListRowDark]}>
                <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{String(label)}</Text>
                <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{String(value ?? "-")}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function AdminPanel({
  chats,
  departments,
  employeeName,
  employeeRole,
  isWide,
  loading,
  notice,
  onCreateEmployee,
  onRefresh,
  onSelectUser,
  onSetEmployeeName,
  onSetEmployeeRole,
  onUpdateTaskStatus,
  reports,
  selectedUserId,
  session,
  summary,
  tasks,
  users,
}: {
  chats: TaskManagerChatMessage[];
  departments: TaskManagerDepartment[];
  employeeName: string;
  employeeRole: "admin" | "member";
  isWide: boolean;
  loading: boolean;
  notice: string;
  onCreateEmployee: () => Promise<void>;
  onRefresh: () => void;
  onSelectUser: (userId: string) => Promise<void>;
  onSetEmployeeName: (value: string) => void;
  onSetEmployeeRole: (value: "admin" | "member") => void;
  onUpdateTaskStatus: (taskId: string, status: TaskManagerAdminTask["status"]) => Promise<void>;
  reports: Awaited<ReturnType<typeof taskManagerAdminApi.taskReports>> | null;
  selectedUserId: string;
  session: TaskManagerAdminSession | null;
  summary: TaskManagerAdminSummary | null;
  tasks: TaskManagerAdminTask[];
  users: TaskManagerAdminUser[];
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  if (!session) {
    return (
      <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
        <EmptyState icon="lock-closed-outline" title="Admin mode unavailable" copy="Only linked Task Manager admin users can open this section." />
      </View>
    );
  }

  const selectedUser = users.find((user) => user._id === selectedUserId) ?? users[0] ?? null;

  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <View style={[styles.adminHeader, isDarkTheme && styles.adminHeaderDark]}>
        <View>
          <Text style={[styles.adminEyebrow, isDarkTheme && styles.adminMutedText]}>Task Manager</Text>
          <Text style={[styles.adminTitle, isDarkTheme && styles.chatTitleDark]}>{session.orgName}</Text>
        </View>
        <Pressable
          accessibilityLabel="Refresh admin data"
          onPress={onRefresh}
          style={({ pressed }) => [
            styles.searchAddButton,
            { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft, borderColor: isDarkTheme ? themeColors.primaryDark : themeColors.primarySoft },
            isDarkTheme && styles.searchAddButtonDark,
            pressed && styles.pressablePressed,
          ]}
        >
          {loading ? <ActivityIndicator color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} /> : <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="refresh-outline" size={20} />}
        </Pressable>
      </View>
      {notice ? <Text style={styles.errorBar}>{notice}</Text> : null}
      <ScrollView contentContainerStyle={[styles.adminContent, isDarkTheme && styles.listContentDark]}>
        <View style={styles.adminMetricGrid}>
          <AdminMetric label="Employees" value={summary?.employees ?? users.length} />
          <AdminMetric label="Open" value={summary?.tasks.open ?? 0} />
          <AdminMetric label="Overdue" value={summary?.tasks.overdue ?? 0} tone="danger" />
          <AdminMetric label="Done" value={`${summary?.completion_rate ?? reports?.summary.completion_rate ?? 0}%`} tone="success" />
        </View>

        <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
          <Text style={[styles.adminSectionTitle, isDarkTheme && styles.chatTitleDark]}>Employees</Text>
          <View style={styles.adminFormRow}>
            <TextInput
              onChangeText={onSetEmployeeName}
              placeholder="Employee name"
              placeholderTextColor={isDarkTheme ? "rgba(255,255,255,0.45)" : colors.faint}
              style={[styles.adminInput, isDarkTheme && styles.searchInputDark]}
              value={employeeName}
            />
            <View style={styles.roleToggle}>
              {TASK_MANAGER_EMPLOYEE_ROLES.map((role) => (
                <Pressable
                  accessibilityLabel={`Set role ${role}`}
                  key={role}
                  onPress={() => onSetEmployeeRole(role)}
                  style={({ pressed }) => [
                    styles.roleToggleButton,
                    employeeRole === role && [styles.roleToggleButtonActive, { backgroundColor: themeColors.primaryDark }],
                    pressed && styles.pressablePressed,
                  ]}
                >
                  <Text style={[styles.roleToggleText, employeeRole === role && styles.roleToggleTextActive]}>{role}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable
            accessibilityLabel="Add employee"
            onPress={() => void onCreateEmployee()}
            style={({ pressed }) => [styles.adminPrimaryButton, { backgroundColor: themeColors.primaryDark }, pressed && styles.pressablePressed]}
          >
            <Ionicons color="#FFFFFF" name="person-add-outline" size={17} />
            <Text style={styles.adminPrimaryButtonText}>Add employee</Text>
          </Pressable>
          {users.map((user) => (
            <Pressable
              key={user._id}
              onPress={() => void onSelectUser(user._id)}
              style={({ pressed }) => [
                styles.adminListRow,
                selectedUser?._id === user._id && [styles.adminListRowActive, { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft, borderColor: isDarkTheme ? themeColors.primaryDark : themeColors.primarySoft }],
                pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
              ]}
            >
              <View>
                <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{user.name}</Text>
                <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{user.role} · {user.agent_channel ?? "whatsapp"}</Text>
              </View>
              <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="chatbubble-ellipses-outline" size={18} />
            </Pressable>
          ))}
        </View>

        <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
          <Text style={[styles.adminSectionTitle, isDarkTheme && styles.chatTitleDark]}>Tasks</Text>
          {tasks.slice(0, 12).map((task) => (
            <View key={task._id} style={styles.adminTaskRow}>
              <View style={styles.adminTaskText}>
                <Text numberOfLines={1} style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{task.title}</Text>
                <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{task.status}</Text>
              </View>
              <Pressable
                onPress={() => void onUpdateTaskStatus(task._id, task.status === "done" ? "open" : "done")}
                style={({ pressed }) => [styles.adminTaskButton, { backgroundColor: task.status === "done" ? themeColors.accent : themeColors.primaryDark }, pressed && styles.pressablePressed]}
              >
                <Ionicons color={task.status === "done" ? themeColors.primaryDark : "#FFFFFF"} name={task.status === "done" ? "refresh-outline" : "checkmark"} size={16} />
              </Pressable>
            </View>
          ))}
          {!tasks.length ? <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>No tasks yet.</Text> : null}
        </View>

        <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
          <Text style={[styles.adminSectionTitle, isDarkTheme && styles.chatTitleDark]}>Employee Chats</Text>
          <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{selectedUser ? selectedUser.name : "Select an employee"}</Text>
          {chats.slice(0, 8).map((chat) => (
            <View key={chat._id} style={styles.adminChatRow}>
              <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{chat.direction === "in" ? "Employee" : "Agent"}</Text>
              <Text numberOfLines={2} style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{chat.text ?? `(${chat.kind})`}</Text>
            </View>
          ))}
        </View>

        <View style={[styles.adminSection, isDarkTheme && styles.adminSectionDark]}>
          <Text style={[styles.adminSectionTitle, isDarkTheme && styles.chatTitleDark]}>Departments</Text>
          {departments.map((department) => (
            <View key={department._id} style={styles.adminListRow}>
              <Text style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{department.name}</Text>
              <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{department.member_count ?? 0} members</Text>
            </View>
          ))}
          {!departments.length ? <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>No departments yet.</Text> : null}
        </View>
      </ScrollView>
    </View>
  );
}

function AdminMetric({ label, value, tone }: { label: string; value: number | string; tone?: "danger" | "success" }) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const color = tone === "danger" ? "#EF4444" : tone === "success" ? themeColors.primaryDark : isDarkTheme ? themeColors.accent : themeColors.primaryDark;
  return (
    <View style={[styles.adminMetricCard, isDarkTheme && styles.adminSectionDark]}>
      <Text style={[styles.adminMetricLabel, isDarkTheme && styles.adminMutedText]}>{label}</Text>
      <Text style={[styles.adminMetricValue, { color }]}>{value}</Text>
    </View>
  );
}

function AdminSectionHeader({ meta, title }: { meta?: string; title: string }) {
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={styles.adminSectionHeader}>
      <Text style={[styles.adminSectionTitle, isDarkTheme && styles.chatTitleDark]}>{title}</Text>
      {meta ? <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{meta}</Text> : null}
    </View>
  );
}

function AdminCompactStat({ label, value }: { label: string; value: number | string }) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View style={[styles.adminCompactStat, isDarkTheme && styles.adminSectionDark]}>
      <Text style={[styles.adminMetricValue, { color: isDarkTheme ? themeColors.accent : themeColors.primaryDark }]}>{value}</Text>
      <Text style={[styles.adminMetricLabel, isDarkTheme && styles.adminMutedText]}>{label}</Text>
    </View>
  );
}

function AdminTaskRow({
  compact,
  isDarkTheme,
  isUpdating,
  onUpdateTaskStatus,
  task,
  userName,
}: {
  compact?: boolean;
  isDarkTheme: boolean;
  isUpdating?: boolean;
  onUpdateTaskStatus: (task: TaskManagerAdminTask) => Promise<void>;
  task: TaskManagerAdminTask;
  userName?: string;
}) {
  const { themeColors } = useAppTheme();
  const isDone = task.status === "done";
  const statusTone = isDone
    ? styles.adminStatusDone
    : task.status === "open"
      ? styles.adminStatusOpen
      : task.status === "discarded"
        ? styles.adminStatusDiscarded
        : styles.adminStatusProgress;
  return (
    <View style={[styles.adminTaskRow, compact && styles.adminTaskRowCompact]}>
      <View style={styles.adminTaskText}>
        <Text numberOfLines={1} style={[styles.adminRowTitle, isDarkTheme && styles.chatTitleDark]}>{task.title}</Text>
        <View style={styles.adminTaskMetaLine}>
          <View style={[styles.adminStatusPill, statusTone]}>
            <View style={[styles.adminStatusDot, isDone && styles.adminStatusDotDone]}>
              {isDone ? <Ionicons color="#FFFFFF" name="checkmark" size={9} /> : null}
            </View>
            <Text style={[styles.adminStatusText, isDone && styles.adminStatusTextDone]}>{task.status.replace("_", " ")}</Text>
          </View>
          {userName ? <Text numberOfLines={1} style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{userName}</Text> : null}
        </View>
      </View>
      <Pressable
        disabled={isUpdating}
        onPress={() => void onUpdateTaskStatus(task)}
        style={[styles.adminTaskButton, { backgroundColor: isDone ? themeColors.accent : themeColors.primaryDark }, isUpdating && styles.adminTaskButtonDisabled]}
      >
        {isUpdating ? (
          <ActivityIndicator color={isDone ? themeColors.primaryDark : "#FFFFFF"} />
        ) : (
          <Ionicons color={isDone ? themeColors.primaryDark : "#FFFFFF"} name={isDone ? "refresh-outline" : "checkmark"} size={16} />
        )}
      </Pressable>
    </View>
  );
}

function AdminEmptyLine({ text }: { text: string }) {
  const { isDarkTheme } = useAppTheme();
  return <Text style={[styles.adminRowMeta, isDarkTheme && styles.adminMutedText]}>{text}</Text>;
}

function ChatsPanel({
  contacts,
  conversations,
  isWide,
  onNewChat,
  onOpenContact,
  onSelect,
  onUpdateTaskStatus,
  selectedId,
}: {
  contacts: ChatListContact[];
  conversations: BackendConversation[];
  isWide: boolean;
  onNewChat: () => void;
  onOpenContact: (contactId: string) => void;
  onSelect: (id: string) => void;
  onUpdateTaskStatus: (taskId: string, status: TaskManagerAdminTask["status"]) => Promise<void>;
  selectedId?: string;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CHAT_PAGE_SIZE);
  const [expandedAgentIds, setExpandedAgentIds] = useState<Record<string, boolean>>({});
  const [expandedCompletedAgentIds, setExpandedCompletedAgentIds] = useState<Record<string, boolean>>({});
  const [expandedTaskIds, setExpandedTaskIds] = useState<Record<string, boolean>>({});
  const [taskActionConversation, setTaskActionConversation] = useState<BackendConversation | null>(null);
  const [taskActionBusy, setTaskActionBusy] = useState<TaskManagerAdminTask["status"] | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    setVisibleCount(CHAT_PAGE_SIZE);
  }, [normalizedQuery, conversations.length, contacts.length]);

  const rows = useMemo(() => {
    const allTaskThreadConversations = conversations.filter((conversation) => conversation.taskThread);
    const taskThreadConversations = conversations.filter(
      (conversation) => conversation.taskThread && isActiveTaskThreadStatus(conversation.taskThread.status),
    );
    const completedTaskThreadConversations = conversations.filter(
      (conversation) => conversation.taskThread && isCompletedTaskThreadStatus(conversation.taskThread.status),
    );
    const taskThreadIds = new Set(allTaskThreadConversations.map((conversation) => conversation.id));
    const agentConversations = conversations.filter(
      (conversation) => isTaskManagerAgentConversation(conversation) && !conversation.taskThread,
    );
    const buildChildIdsByParentTaskId = (threadConversations: BackendConversation[]) => {
      const childIdsByParentTaskId = new Map<string, string[]>();
      for (const conversation of threadConversations) {
        const taskThread = conversation.taskThread;
        const parentTaskId = taskThread?.parentTaskId;
        if (!parentTaskId) continue;
        const children = childIdsByParentTaskId.get(parentTaskId) ?? [];
        children.push(taskThread.taskmanagerTaskId);
        childIdsByParentTaskId.set(parentTaskId, children);
      }
      return childIdsByParentTaskId;
    };
    const activeChildIdsByParentTaskId = buildChildIdsByParentTaskId(taskThreadConversations);
    const completedChildIdsByParentTaskId = buildChildIdsByParentTaskId(completedTaskThreadConversations);

    const sortTaskThreads = (threadConversations: BackendConversation[]) => [...threadConversations].sort((left, right) =>
      (left.taskThread?.taskNumber ?? "").localeCompare(right.taskThread?.taskNumber ?? "", undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
    const sortedTaskThreads = sortTaskThreads(taskThreadConversations);
    const sortedCompletedTaskThreads = sortTaskThreads(completedTaskThreadConversations);
    const allTaskThreadsByTaskId = new Map(
      allTaskThreadConversations.map((item) => [item.taskThread?.taskmanagerTaskId, item]),
    );

    const taskThreadDepth = (conversation: BackendConversation) => {
      const parentTaskId = conversation.taskThread?.parentTaskId;
      if (!parentTaskId) return 0;
      let depth = 0;
      let currentParentId: string | null | undefined = parentTaskId;
      const seen = new Set<string>();
      while (currentParentId && !seen.has(currentParentId)) {
        seen.add(currentParentId);
        depth += 1;
        currentParentId = allTaskThreadsByTaskId.get(currentParentId)?.taskThread?.parentTaskId;
      }
      return Math.min(depth, 4);
    };

    const taskThreadVisible = (conversation: BackendConversation, threadConversations: BackendConversation[]) => {
      const parentTaskId = conversation.taskThread?.parentTaskId;
      if (!parentTaskId) return true;
      const byTaskId = new Map(threadConversations.map((item) => [item.taskThread?.taskmanagerTaskId, item]));
      let currentParentId: string | null | undefined = parentTaskId;
      const seen = new Set<string>();
      while (currentParentId && !seen.has(currentParentId)) {
        seen.add(currentParentId);
        if (expandedTaskIds[currentParentId] === false) return false;
        currentParentId = byTaskId.get(currentParentId)?.taskThread?.parentTaskId;
      }
      return true;
    };

    const taskThreadBelongsToAgent = (taskConversation: BackendConversation, agentConversation: BackendConversation) => {
      const taskThread = taskConversation.taskThread;
      if (!taskThread) return false;
      if (taskThread.sourceAgentConversationId && taskThread.sourceAgentConversationId === agentConversation.id) return true;
      if (
        agentConversation.taskManagerAgent?.taskmanagerOrgId &&
        agentConversation.taskManagerAgent.taskmanagerOrgId === taskThread.taskmanagerOrgId
      ) {
        return true;
      }
      return false;
    };

    const conversationRows = conversations
      .filter((conversation) => !taskThreadIds.has(conversation.id))
      .filter((conversation) => {
        if (!normalizedQuery) return true;
        return searchableText([
          conversation.title,
          messagePreviewText(conversation.lastMessage),
          ...conversation.participants.map((participant) => participant.displayName),
          ...conversation.participants.map((participant) => participant.phone),
        ]).includes(normalizedQuery);
      })
      .flatMap((conversation) => {
        const parentRow = {
          conversation,
          hasTaskThreads: false,
          id: `conversation-${conversation.id}`,
          taskThreadsExpanded: expandedAgentIds[conversation.id] ?? false,
          type: "conversation" as const,
        };
        const rowsForConversation: Array<
          | { conversation: BackendConversation; hasTaskThreads?: boolean; id: string; taskThreadsExpanded?: boolean; type: "conversation" }
          | { agentId: string; count: number; expanded: boolean; id: string; type: "completedTaskSection" }
          | { conversation: BackendConversation; depth: number; hasChildren: boolean; id: string; type: "taskThread" }
        > = [parentRow];
        const taskThreadsForAgent = isTaskManagerAgentConversation(conversation)
          ? sortedTaskThreads.filter((taskConversation) => taskThreadBelongsToAgent(taskConversation, conversation))
          : [];
        const completedTaskThreadsForAgent = isTaskManagerAgentConversation(conversation)
          ? sortedCompletedTaskThreads.filter((taskConversation) => taskThreadBelongsToAgent(taskConversation, conversation))
          : [];
        if (taskThreadsForAgent.length || completedTaskThreadsForAgent.length) {
          parentRow.hasTaskThreads = true;
        }
        if ((taskThreadsForAgent.length || completedTaskThreadsForAgent.length) && (expandedAgentIds[conversation.id] ?? false)) {
          rowsForConversation.push(
            ...taskThreadsForAgent
              .filter((taskConversation) => taskThreadVisible(taskConversation, taskThreadConversations))
              .map((taskConversation) => ({
                conversation: taskConversation,
                depth: taskThreadDepth(taskConversation),
                hasChildren: activeChildIdsByParentTaskId.has(taskConversation.taskThread?.taskmanagerTaskId ?? ""),
                id: `task-thread-${taskConversation.id}`,
                type: "taskThread" as const,
              })),
          );
          if (completedTaskThreadsForAgent.length) {
            const completedExpanded = expandedCompletedAgentIds[conversation.id] ?? false;
            rowsForConversation.push({
              agentId: conversation.id,
              count: completedTaskThreadsForAgent.length,
              expanded: completedExpanded,
              id: `completed-task-section-${conversation.id}`,
              type: "completedTaskSection" as const,
            });
            if (completedExpanded) {
              rowsForConversation.push(
                ...completedTaskThreadsForAgent
                  .filter((taskConversation) => taskThreadVisible(taskConversation, completedTaskThreadConversations))
                  .map((taskConversation) => ({
                    conversation: taskConversation,
                    depth: taskThreadDepth(taskConversation),
                    hasChildren: completedChildIdsByParentTaskId.has(taskConversation.taskThread?.taskmanagerTaskId ?? ""),
                    id: `completed-task-thread-${taskConversation.id}`,
                    type: "taskThread" as const,
                  })),
              );
            }
          }
        }
        return rowsForConversation;
      });

    const orphanTaskRows = sortedTaskThreads
      .filter((taskConversation) =>
        !agentConversations.some((agentConversation) => taskThreadBelongsToAgent(taskConversation, agentConversation)),
      )
      .filter((taskConversation) => taskThreadVisible(taskConversation, taskThreadConversations))
      .map((taskConversation) => ({
        conversation: taskConversation,
        depth: taskThreadDepth(taskConversation),
        hasChildren: activeChildIdsByParentTaskId.has(taskConversation.taskThread?.taskmanagerTaskId ?? ""),
        id: `task-thread-${taskConversation.id}`,
        type: "taskThread" as const,
      }));

    const contactRows = contacts
      .filter((contact) => !contact.existingConversationId)
      .filter((contact) => {
        if (!normalizedQuery) return true;
        return searchableText([contact.displayName, contact.phone, contact.about]).includes(normalizedQuery);
      })
      .map((contact) => ({ contact, id: `contact-${contact.id}`, type: "contact" as const }));

    return [...conversationRows, ...orphanTaskRows, ...contactRows];
  }, [contacts, conversations, expandedAgentIds, expandedCompletedAgentIds, expandedTaskIds, normalizedQuery]);

  const visibleRows = rows.slice(0, visibleCount);
  const canLoadMore = visibleCount < rows.length;

  function handleScroll(event: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const nearEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - 180;
    if (nearEnd && canLoadMore) {
      setVisibleCount((current) => Math.min(current + CHAT_PAGE_SIZE, rows.length));
    }
  }

  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <View style={[styles.chatSearchHeader, isDarkTheme && styles.chatSearchHeaderDark]}>
        <View style={[styles.searchBox, isDarkTheme && styles.searchBoxDark]}>
          <Ionicons color={isDarkTheme ? "rgba(255,255,255,0.58)" : colors.muted} name="search-outline" size={18} />
          <TextInput
            onChangeText={setQuery}
            placeholder="Search contacts or chats"
            placeholderTextColor={isDarkTheme ? "rgba(255,255,255,0.45)" : colors.faint}
            style={[styles.searchInput, isDarkTheme && styles.searchInputDark]}
            value={query}
          />
          {query ? (
            <Pressable
              accessibilityLabel="Clear search"
              onPress={() => setQuery("")}
              style={({ pressed }) => [styles.inlineIconHit, pressed && styles.pressablePressed]}
            >
              <Ionicons color={isDarkTheme ? "rgba(255,255,255,0.58)" : colors.muted} name="close-circle" size={18} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          accessibilityLabel="Add contact"
          onPress={onNewChat}
          style={({ pressed }) => [
            styles.searchAddButton,
            { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft },
            isDarkTheme && styles.searchAddButtonDark,
            pressed && styles.pressablePressed,
          ]}
        >
          <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="person-add-outline" size={20} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={[styles.listContent, isDarkTheme && styles.listContentDark]}
        onScroll={handleScroll}
        scrollEventThrottle={120}
      >
        {visibleRows.length ? (
          <>
            {visibleRows.map((row) => {
              if (row.type === "conversation") {
                const conversation = row.conversation;
                return (
                  <Pressable
                    key={row.id}
                    onPress={() => onSelect(conversation.id)}
                    style={({ pressed }) => [
                      styles.chatRow,
                      isDarkTheme && styles.chatRowDark,
                      selectedId === conversation.id && [styles.chatRowActive, { backgroundColor: themeColors.accentSoft, borderColor: themeColors.primarySoft }],
                      isDarkTheme && selectedId === conversation.id && styles.chatRowActiveDark,
                      isDarkTheme && selectedId === conversation.id && { backgroundColor: themeColors.darkAccentSoft, borderColor: themeColors.primaryDark },
                      pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                    ]}
                  >
                    {row.hasTaskThreads ? (
                      <Pressable
                        accessibilityLabel={row.taskThreadsExpanded ? "Collapse task threads" : "Expand task threads"}
                        onPress={(event) => {
                          event.stopPropagation?.();
                          animateNextListLayout();
                          setExpandedAgentIds((current) => ({
                            ...current,
                            [conversation.id]: !(current[conversation.id] ?? false),
                          }));
                        }}
                        style={({ pressed }) => [styles.taskThreadChevron, pressed && styles.pressablePressed]}
                      >
                        <Ionicons
                          color={isDarkTheme ? themeColors.accent : themeColors.primaryDark}
                          name={row.taskThreadsExpanded ? "chevron-down" : "chevron-forward"}
                          size={18}
                        />
                      </Pressable>
                    ) : null}
                    <Avatar
                      avatarUrl={conversation.avatarUrl}
                      isBot={isTaskManagerAgentConversation(conversation)}
                      name={conversation.title}
                    />
                    <View style={styles.chatListRowBody}>
                      <View style={styles.chatListTextColumn}>
                        <Text numberOfLines={1} style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>{conversation.title}</Text>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.chatPreview,
                            isDarkTheme && styles.chatPreviewDark,
                            conversation.unreadCount > 0 && styles.chatPreviewUnread,
                            isDarkTheme && conversation.unreadCount > 0 && styles.chatPreviewUnreadDark,
                          ]}
                        >
                          {messagePreviewText(conversation.lastMessage) || conversationFallbackPreview(conversation)}
                        </Text>
                      </View>
                      <View style={styles.chatListMetaColumn}>
                        <Text numberOfLines={1} style={[styles.chatTime, isDarkTheme && styles.chatTimeDark]}>
                          {conversation.lastMessage ? formatTime(conversation.lastMessage.createdAt) : ""}
                        </Text>
                        {conversation.unreadCount > 0 ? <UnreadBadge count={conversation.unreadCount} /> : null}
                      </View>
                    </View>
                  </Pressable>
                );
              }

              if (row.type === "completedTaskSection") {
                return (
                  <Pressable
                    key={row.id}
                    onPress={() => {
                      animateNextListLayout();
                      setExpandedCompletedAgentIds((current) => ({
                        ...current,
                        [row.agentId]: !(current[row.agentId] ?? false),
                      }));
                    }}
                    style={({ pressed }) => [
                      styles.completedTaskSectionRow,
                      isDarkTheme && styles.completedTaskSectionRowDark,
                      pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                    ]}
                  >
                    <View
                      style={[
                        styles.completedTaskSectionIcon,
                        { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft },
                      ]}
                    >
                      <Ionicons
                        color={isDarkTheme ? themeColors.accent : themeColors.primaryDark}
                        name={row.expanded ? "chevron-down" : "chevron-forward"}
                        size={16}
                      />
                    </View>
                    <View
                      style={[
                        styles.completedTaskSectionLine,
                        { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.primarySoft },
                        isDarkTheme && styles.completedTaskSectionLineDark,
                      ]}
                    />
                    <Text style={[styles.completedTaskSectionTitle, isDarkTheme && styles.completedTaskSectionTitleDark]}>
                      Archived tasks
                    </Text>
                    <Text
                      style={[
                        styles.completedTaskSectionCount,
                        { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft, color: isDarkTheme ? themeColors.accent : themeColors.primaryDark },
                        isDarkTheme && styles.completedTaskSectionCountDark,
                      ]}
                    >
                      {row.count}
                    </Text>
                  </Pressable>
                );
              }

              if (row.type === "taskThread") {
                const conversation = row.conversation;
                const taskThread = conversation.taskThread;
                const taskId = taskThread?.taskmanagerTaskId ?? conversation.id;
                const taskExpanded = expandedTaskIds[taskId] ?? true;
                const taskActionsOpen = taskActionConversation?.id === conversation.id;
                const statusLabel = taskThreadStatusLabel(taskThread?.status);
                const isCompletedTaskThread = isCompletedTaskThreadStatus(taskThread?.status);
                const openTaskActions = () =>
                  setTaskActionConversation((current) => current?.id === conversation.id ? null : conversation);
                return (
                  <View key={row.id} style={[styles.taskThreadRowFrame, taskActionsOpen && styles.taskThreadRowFrameOpen]}>
                    <Pressable
                      {...(Platform.OS === "web"
                        ? {
                            onContextMenu: (event: { preventDefault?: () => void }) => {
                              event.preventDefault?.();
                              openTaskActions();
                            },
                          }
                        : {})}
                      onLongPress={openTaskActions}
                      onPress={() => onSelect(conversation.id)}
                      style={({ pressed }) => [
                        styles.chatRow,
                        styles.taskThreadRow,
                        isCompletedTaskThread && styles.taskThreadRowArchived,
                        isDarkTheme && styles.chatRowDark,
                        isDarkTheme && isCompletedTaskThread && styles.taskThreadRowArchivedDark,
                        selectedId === conversation.id && [styles.chatRowActive, { backgroundColor: themeColors.accentSoft, borderColor: themeColors.primarySoft }],
                        isDarkTheme && selectedId === conversation.id && styles.chatRowActiveDark,
                        isDarkTheme && selectedId === conversation.id && { backgroundColor: themeColors.darkAccentSoft, borderColor: themeColors.primaryDark },
                        pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                        { paddingLeft: 12 + row.depth * 18 },
                      ]}
                    >
                    <View
                      style={[
                        styles.taskThreadRail,
                        { backgroundColor: isDarkTheme ? themeColors.accent : themeColors.primary },
                        isDarkTheme && styles.taskThreadRailDark,
                        isCompletedTaskThread && styles.taskThreadRailArchived,
                      ]}
                    />
                    {row.hasChildren ? (
                      <Pressable
                        accessibilityLabel={taskExpanded ? "Collapse subtasks" : "Expand subtasks"}
                        onPress={(event) => {
                          event.stopPropagation?.();
                          animateNextListLayout();
                          setExpandedTaskIds((current) => ({
                            ...current,
                            [taskId]: !(current[taskId] ?? true),
                          }));
                        }}
                        style={({ pressed }) => [styles.taskThreadChevron, pressed && styles.pressablePressed]}
                      >
                        <Ionicons
                        color={isDarkTheme ? themeColors.accent : themeColors.primaryDark}
                          name={taskExpanded ? "chevron-down" : "chevron-forward"}
                          size={16}
                        />
                      </Pressable>
                    ) : (
                      <View style={styles.taskThreadChevronSpacer} />
                    )}
                    <View
                      style={[
                        styles.taskNumberPill,
                        !isDarkTheme && { backgroundColor: themeColors.primarySoft, borderColor: themeColors.accentSoft },
                        isDarkTheme && styles.taskNumberPillDark,
                        isDarkTheme && { backgroundColor: themeColors.darkAccentSoft, borderColor: themeColors.primaryDark },
                        isCompletedTaskThread && styles.taskNumberPillArchived,
                      ]}
                    >
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.taskNumberText,
                          isDarkTheme && styles.taskNumberTextDark,
                          isCompletedTaskThread && styles.taskNumberTextArchived,
                          { color: isDarkTheme ? themeColors.accent : themeColors.primaryDark },
                        ]}
                      >
                        {taskThread?.taskNumber ?? "TASK"}
                      </Text>
                    </View>
                    <View style={styles.chatListRowBody}>
                      <View style={styles.chatListTextColumn}>
                        <View style={styles.taskThreadTitleRow}>
                          <View
                            style={[
                              styles.taskStatusDot,
                              taskThread?.status === "in_progress" && styles.taskStatusDotProgress,
                              isCompletedTaskThread && styles.taskStatusDotDone,
                              (taskThread?.status === "discarded" || taskThread?.status === "closed") && styles.taskStatusDotClosed,
                            ]}
                          />
                          {isCompletedTaskThread ? (
                            <Ionicons
                              color={taskThread?.status === "discarded" || taskThread?.status === "closed" ? colors.faint : isDarkTheme ? themeColors.accent : themeColors.primaryDark}
                              name={taskThread?.status === "discarded" || taskThread?.status === "closed" ? "archive-outline" : "checkmark-done-outline"}
                              size={14}
                            />
                          ) : null}
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.chatTitle,
                              styles.taskThreadTitle,
                              isDarkTheme && styles.chatTitleDark,
                              isCompletedTaskThread && styles.taskThreadTitleArchived,
                            ]}
                          >
                            {taskThread?.title ?? conversation.title}
                          </Text>
                        </View>
                        <Text numberOfLines={1} style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>
                          {statusLabel ? `${statusLabel} - ` : ""}
                          {messagePreviewText(conversation.lastMessage) || `${conversation.participants.length} members`}
                        </Text>
                      </View>
                      <View style={styles.chatListMetaColumn}>
                        <Text numberOfLines={1} style={[styles.chatTime, isDarkTheme && styles.chatTimeDark]}>
                          {conversation.lastMessage ? formatTime(conversation.lastMessage.createdAt) : ""}
                        </Text>
                        <View style={styles.taskThreadMetaActions}>
                          {conversation.unreadCount > 0 ? <UnreadBadge count={conversation.unreadCount} /> : null}
                          <Pressable
                            accessibilityLabel="Task actions"
                            onPress={(event) => {
                              event.stopPropagation?.();
                              openTaskActions();
                            }}
                            style={({ pressed }) => [
                              styles.taskActionDots,
                              isCompletedTaskThread && styles.taskActionDotsArchived,
                              taskActionsOpen && styles.taskActionDotsActive,
                              taskActionsOpen && { backgroundColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.accentSoft },
                              pressed && styles.pressablePressed,
                            ]}
                          >
                            <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="ellipsis-horizontal" size={17} />
                          </Pressable>
                        </View>
                      </View>
                    </View>
                    </Pressable>
                    {taskActionsOpen ? (
                      <TaskThreadInlineActions
                        busyStatus={taskActionBusy}
                        currentStatus={taskThread?.status}
                        isDarkTheme={isDarkTheme}
                        onUpdateStatus={async (status) => {
                          setTaskActionBusy(status);
                          try {
                            await onUpdateTaskStatus(taskId, status);
                            setTaskActionConversation(null);
                          } finally {
                            setTaskActionBusy(null);
                          }
                        }}
                      />
                    ) : null}
                  </View>
                );
              }

              const contact = row.contact;
              return (
                <Pressable
                  key={row.id}
                  onPress={() => onOpenContact(contact.id)}
                  style={({ pressed }) => [
                    styles.chatRow,
                    isDarkTheme && styles.chatRowDark,
                    pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                  ]}
                >
                  <Avatar
                    avatarUrl={contact.avatarUrl}
                    isBot={contact.about?.trim().toLowerCase() === "task manager agent"}
                    name={contact.displayName}
                  />
                  <View style={styles.chatListRowBody}>
                    <View style={styles.chatListTextColumn}>
                      <Text numberOfLines={1} style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>{contact.displayName}</Text>
                      <Text numberOfLines={1} style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>Tap to start a 1:1 chat</Text>
                    </View>
                    <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="chatbubble-outline" size={21} />
                  </View>
                </Pressable>
              );
            })}
            {canLoadMore ? (
              <Text style={[styles.listFooterText, isDarkTheme && styles.listFooterTextDark]}>Scroll for more chats</Text>
            ) : null}
          </>
        ) : (
          <EmptyState
            icon={normalizedQuery ? "search-outline" : "chatbubbles-outline"}
            title={normalizedQuery ? "No matches" : "No chats yet"}
            copy={normalizedQuery ? "Try another contact name or phone number." : "Add a contact or sync contacts from Settings."}
          />
        )}
      </ScrollView>
    </View>
  );
}

function TaskThreadInlineActions({
  busyStatus,
  currentStatus,
  isDarkTheme,
  onUpdateStatus,
}: {
  busyStatus: TaskManagerAdminTask["status"] | null;
  currentStatus?: string | null;
  isDarkTheme: boolean;
  onUpdateStatus: (status: TaskManagerAdminTask["status"]) => Promise<void>;
}) {
  const { themeColors } = useAppTheme();
  const isCompleted = isCompletedTaskThreadStatus(currentStatus);
  return (
    <View
      style={[
        styles.taskInlineActions,
        { borderColor: isDarkTheme ? themeColors.darkAccentSoft : themeColors.primarySoft },
        isDarkTheme && styles.taskInlineActionsDark,
      ]}
    >
      {isCompleted ? (
        <TaskActionButton
          busy={busyStatus === "open"}
          icon="refresh-outline"
          label="Reopen task"
          onPress={() => void onUpdateStatus("open")}
          tone="success"
        />
      ) : (
        <>
          <TaskActionButton
            busy={busyStatus === "done"}
            icon="checkmark-done-outline"
            label="Mark done"
            onPress={() => void onUpdateStatus("done")}
            tone="success"
          />
          <TaskActionButton
            busy={busyStatus === "discarded"}
            icon="close-circle-outline"
            label="Close task"
            onPress={() => void onUpdateStatus("discarded")}
            tone="danger"
          />
        </>
      )}
    </View>
  );
}

function TaskActionButton({
  busy,
  icon,
  label,
  onPress,
  tone,
}: {
  busy: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone: "danger" | "success";
}) {
  const { themeColors } = useAppTheme();
  const color = tone === "danger" ? "#DC2626" : themeColors.primaryDark;
  return (
    <Pressable
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.taskActionButton,
        tone === "danger" && styles.taskActionButtonDanger,
        pressed && styles.pressablePressed,
      ]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Ionicons color={color} name={icon} size={19} />}
      <Text style={[styles.taskActionButtonText, { color }, tone === "danger" && styles.taskActionButtonDangerText]}>{label}</Text>
    </Pressable>
  );
}

function PanelTitle({
  title,
  actionIcon,
  actionLabel,
  onAction,
}: {
  title: string;
  actionIcon: keyof typeof Ionicons.glyphMap;
  actionLabel: string;
  onAction: () => void;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View
      style={[
        styles.panelTitle,
        { backgroundColor: isDarkTheme ? "#202C33" : themeColors.primaryDark },
        isDarkTheme && styles.panelTitleDark,
        isDarkTheme && { borderBottomColor: themeColors.darkAccentSoft },
      ]}
    >
      <Text style={styles.panelHeading}>{title}</Text>
      <IconButton icon={actionIcon} label={actionLabel} onPress={onAction} />
    </View>
  );
}

function ChatPane({
  attachment,
  agentThinking,
  bottomInset,
  conversation,
  currentUserId,
  messages,
  messagesLoading,
  onMessageActions,
  onReplyToMessage,
  onCreateSubtask,
  onOpenMemberDirect,
  onOpenSubtask,
  onOpenAttachmentMenu,
  onTakePhoto,
  draft,
  setDraft,
  onRemoveAttachment,
  onRemoveReply,
  onSaveContact,
  onSend,
  onBack,
  onAddMembers,
  isWide,
  loadingOlder,
  onLoadOlder,
  replyingToMessage,
  subtaskConversations,
  typingText,
  unsavedPeer,
}: {
  attachment: ComposerAttachment | null;
  agentThinking: boolean;
  bottomInset: number;
  conversation: BackendConversation;
  currentUserId: string;
  messages: ChatMessage[];
  messagesLoading: boolean;
  onMessageActions: (target: NonNullable<MessageActionTarget>) => void;
  onReplyToMessage: (message: ChatMessage) => void;
  onCreateSubtask: () => void;
  onOpenMemberDirect: (profileId: string) => void | Promise<void>;
  onOpenSubtask: (conversationId: string) => void;
  onOpenAttachmentMenu: () => void;
  onTakePhoto: () => void;
  draft: string;
  setDraft: (value: string) => void;
  onRemoveAttachment: () => void;
  onRemoveReply: () => void;
  onSaveContact: () => void;
  onSend: (
    kind?: BackendMessage["kind"],
    body?: string,
    attachment?: ComposerAttachment | null,
    modelBodyOverride?: string,
  ) => Promise<void> | void;
  onBack: () => void;
  onAddMembers: () => void | Promise<void>;
  isWide: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  replyingToMessage: ChatMessage | null;
  subtaskConversations: BackendConversation[];
  typingText: string;
  unsavedPeer: UnsavedPeer | null;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView | null>(null);
  const keyboardInset = useKeyboardClearance(!isWide);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 60);
  const [voiceRecorderVisible, setVoiceRecorderVisible] = useState(false);
  const [voiceRecorderPaused, setVoiceRecorderPaused] = useState(false);
  const [voiceRecorderBusy, setVoiceRecorderBusy] = useState(false);
  const [voiceNativeDurationMs, setVoiceNativeDurationMs] = useState(0);
  const [voiceWaveSamples, setVoiceWaveSamples] = useState<number[]>(() => Array(VOICE_WAVEFORM_BARS).fill(0.14));
  const stopWebWaveAnalyserRef = useRef<(() => void) | null>(null);
  const voiceRecordingBackendRef = useRef<VoiceRecordingBackend | null>(null);
  const nativeWaveformPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nativeStartWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [quickPromptOpen, setQuickPromptOpen] = useState(false);
  const [subtaskPanelOpen, setSubtaskPanelOpen] = useState(false);
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const canTriggerOlderRef = useRef(false);
  const contentHeightRef = useRef(0);
  const isNearLatestRef = useRef(true);
  const lastOlderTriggerAtRef = useRef(0);
  const followAgentExchangeUntilRef = useRef(0);
  const preserveOffsetOnNextSizeChangeRef = useRef(false);
  const previousLastMessageIdRef = useRef("");
  const previousMessageCountRef = useRef(0);
  const scrollOffsetYRef = useRef(0);
  const waitingForOlderLoadRef = useRef(false);
  const isAgentConversation = isTaskManagerAgentConversation(conversation);
  const showSenderIdentity = shouldShowSenderIdentity(conversation);
  const taskThread = conversation.taskThread;
  const isTaskThreadConversation = Boolean(taskThread);
  const mentionQuery = isTaskThreadConversation ? orbitaMentionQuery(draft) : null;
  const showOrbitaMentionSuggestion = mentionQuery !== null;
  const showComposerMentionHighlight = isTaskThreadConversation && hasOrbitaMention(draft);
  const composerKeyboardGap = keyboardInset ? KEYBOARD_COMPOSER_GAP : Math.max(bottomInset, KEYBOARD_COMPOSER_GAP);
  const isArchivedTaskThread = isCompletedTaskThreadStatus(taskThread?.status);
  const archivedTaskTitle = isArchivedTaskThread ? taskThreadArchiveTitle(taskThread?.status) : "";
  const archivedTaskLabel = isArchivedTaskThread ? taskThreadStatusLabel(taskThread?.status) : "";
  const resolvedSubtasks = subtaskConversations.filter((conversation) => isCompletedTaskThreadStatus(conversation.taskThread?.status)).length;
  const visibleMembers = useMemo(
    () => conversation.participants.filter((participant) => participant.about?.trim().toLowerCase() !== "task manager agent"),
    [conversation.participants],
  );

  const scrollToLatest = useCallback((animated = true) => {
    const scroll = () => {
      scrollRef.current?.scrollToEnd({ animated });
    };
    requestAnimationFrame(() => {
      scroll();
      requestAnimationFrame(scroll);
      if (Platform.OS === "web") {
        window.setTimeout(scroll, 80);
      }
    });
  }, []);

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    const previousHeight = contentHeightRef.current;
    if (preserveOffsetOnNextSizeChangeRef.current && previousHeight) {
      const heightDelta = height - previousHeight;
      if (heightDelta !== 0) {
        requestAnimationFrame(() => {
          const nextOffset = Math.max(0, scrollOffsetYRef.current + heightDelta);
          scrollRef.current?.scrollTo({ y: nextOffset, animated: false });
          scrollOffsetYRef.current = nextOffset;
        });
      }
      if (!loadingOlder) {
        preserveOffsetOnNextSizeChangeRef.current = false;
      }
    } else if (previousHeight && height > previousHeight && !loadingOlder && isNearLatestRef.current) {
      scrollToLatest(false);
    }
    contentHeightRef.current = height;
  }, [loadingOlder, scrollToLatest]);

  const handleMessageScroll = useCallback((event: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const offsetY = contentOffset.y;
    scrollOffsetYRef.current = offsetY;
    isNearLatestRef.current = offsetY + layoutMeasurement.height >= contentSize.height - 90;
    if (offsetY > 80) {
      canTriggerOlderRef.current = true;
      return;
    }
    if (!canTriggerOlderRef.current || loadingOlder || messagesLoading) return;
    const now = Date.now();
    if (now - lastOlderTriggerAtRef.current < 900) return;
    lastOlderTriggerAtRef.current = now;
    waitingForOlderLoadRef.current = true;
    onLoadOlder();
  }, [loadingOlder, messagesLoading, onLoadOlder]);

  const lastMessageId = messages[messages.length - 1]?.id ?? "";

  useEffect(() => {
    contentHeightRef.current = 0;
    previousLastMessageIdRef.current = "";
    scrollToLatest(false);
  }, [conversation.id, scrollToLatest]);

  useEffect(() => {
    const previousLastMessageId = previousLastMessageIdRef.current;
    previousLastMessageIdRef.current = lastMessageId;
    if (!lastMessageId || previousLastMessageId === lastMessageId || loadingOlder) return;
    const lastMessage = messages[messages.length - 1];
    const now = Date.now();
    if (isAgentConversation && lastMessage?.senderId === currentUserId) {
      followAgentExchangeUntilRef.current = now + AGENT_FOLLOW_LATEST_MS;
    }
    const isActiveAgentExchange =
      isAgentConversation &&
      lastMessage?.senderId !== currentUserId &&
      followAgentExchangeUntilRef.current > now;
    const shouldFollowLatest =
      lastMessage?.senderId === currentUserId ||
      isNearLatestRef.current ||
      isActiveAgentExchange;
    if (shouldFollowLatest) scrollToLatest();
  }, [currentUserId, isAgentConversation, lastMessageId, loadingOlder, messages, scrollToLatest]);

  useEffect(() => {
    if (agentThinking && !loadingOlder && !messagesLoading) {
      scrollToLatest();
    }
  }, [agentThinking, loadingOlder, messagesLoading, scrollToLatest]);

  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    const nextCount = messages.length;
    previousMessageCountRef.current = nextCount;
    if (!nextCount || loadingOlder || messagesLoading) return;

    // When chat opens from preview-only memory/cache, a full history batch may
    // arrive shortly after. Keep the viewport anchored to latest once.
    const hydratedFromPreview = previousCount <= 1 && nextCount > previousCount + 1;
    if (hydratedFromPreview) {
      scrollToLatest(false);
    }
  }, [loadingOlder, messages.length, messagesLoading, scrollToLatest]);

  useEffect(() => {
    if (loadingOlder && waitingForOlderLoadRef.current) {
      preserveOffsetOnNextSizeChangeRef.current = true;
    }
    if (!loadingOlder) {
      waitingForOlderLoadRef.current = false;
      requestAnimationFrame(() => {
        if (!waitingForOlderLoadRef.current) preserveOffsetOnNextSizeChangeRef.current = false;
      });
    }
  }, [loadingOlder]);

  useEffect(() => {
    canTriggerOlderRef.current = false;
    lastOlderTriggerAtRef.current = 0;
    preserveOffsetOnNextSizeChangeRef.current = false;
    isNearLatestRef.current = true;
    waitingForOlderLoadRef.current = false;
    previousMessageCountRef.current = 0;
    followAgentExchangeUntilRef.current = 0;
    setQuickPromptOpen(false);
    setSubtaskPanelOpen(false);
  }, [conversation.id]);

  useEffect(() => {
    if (keyboardInset) scrollToLatest(false);
  }, [keyboardInset, scrollToLatest]);

  useEffect(() => {
    return () => {
      stopWebWaveAnalyserRef.current?.();
      stopNativeWaveformPolling();
      stopNativeStartWatchdog();
    };
  }, []);

  useEffect(() => {
    if (
      Platform.OS === "web" ||
      voiceRecordingBackendRef.current !== "expo" ||
      !voiceRecorderVisible ||
      voiceRecorderPaused ||
      !recorderState.isRecording
    ) {
      return;
    }
    const level = meteringToWaveLevel(recorderState.metering);
    setVoiceWaveSamples((samples) => [...samples.slice(1), level]);
  }, [recorderState.durationMillis, recorderState.isRecording, recorderState.metering, voiceRecorderPaused, voiceRecorderVisible]);

  function stopNativeWaveformPolling() {
    if (nativeWaveformPollRef.current) {
      clearInterval(nativeWaveformPollRef.current);
      nativeWaveformPollRef.current = null;
    }
  }

  function stopNativeStartWatchdog() {
    if (nativeStartWatchdogRef.current) {
      clearTimeout(nativeStartWatchdogRef.current);
      nativeStartWatchdogRef.current = null;
    }
  }

  function startNativeWaveformPolling() {
    if (nativeWaveformPollRef.current || Platform.OS === "web") return;
    nativeWaveformPollRef.current = setInterval(() => {
      void orbitaAudioWaveform.getStatusAsync().then((status) => {
        setVoiceNativeDurationMs(status.durationMs);
        if (status.waveformSamples.length) {
          setVoiceWaveSamples(status.waveformSamples.slice(-VOICE_WAVEFORM_BARS));
        }
      }).catch(() => undefined);
    }, 60);
  }

  function stopWebWaveAnalyser() {
    stopWebWaveAnalyserRef.current?.();
    stopWebWaveAnalyserRef.current = null;
  }

  async function startWebWaveAnalyser() {
    if (Platform.OS !== "web" || stopWebWaveAnalyserRef.current) return;
    const mediaDevices = globalThis.navigator?.mediaDevices;
    const AudioContextConstructor =
      globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!mediaDevices?.getUserMedia || !AudioContextConstructor) return;

    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContextConstructor();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      let frame = 0;

      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      const data = new Uint8Array(analyser.fftSize);
      source.connect(analyser);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index += 1) {
          const centered = (data[index] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        const level = clamp(0.08 + rms * 6.8, 0.08, 1);
        setVoiceWaveSamples((samples) => [...samples.slice(1), level]);
        frame = requestAnimationFrame(tick);
      };

      tick();
      stopWebWaveAnalyserRef.current = () => {
        cancelAnimationFrame(frame);
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void audioContext.close().catch(() => undefined);
      };
    } catch {
      stopWebWaveAnalyserRef.current = null;
    }
  }

  async function startExpoRecorderBackend() {
    await recorder.prepareToRecordAsync();
    recorder.record();
    voiceRecordingBackendRef.current = "expo";
    if (Platform.OS === "web") {
      void startWebWaveAnalyser();
    }
  }

  function startNativeStartWatchdog() {
    stopNativeStartWatchdog();
    nativeStartWatchdogRef.current = setTimeout(() => {
      if (voiceRecordingBackendRef.current !== "native") return;
      void orbitaAudioWaveform.getStatusAsync().then(async (status) => {
        if (voiceRecordingBackendRef.current !== "native") return;
        if (status.durationMs > 120 || status.waveformSamples.length > 0) return;

        stopNativeWaveformPolling();
        await orbitaAudioWaveform.discardRecordingAsync().catch(() => undefined);
        voiceRecordingBackendRef.current = null;
        setVoiceNativeDurationMs(0);
        setVoiceWaveSamples(Array(VOICE_WAVEFORM_BARS).fill(0.14));
        try {
          await startExpoRecorderBackend();
          setVoiceRecorderVisible(true);
          setVoiceRecorderPaused(false);
        } catch {
          setVoiceRecorderVisible(false);
          setVoiceRecorderPaused(false);
          await setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
            interruptionMode: "duckOthers",
          }).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, 900);
  }

  async function startVoiceRecording() {
    if (voiceRecorderVisible && voiceRecorderPaused) {
      if (voiceRecordingBackendRef.current === "expo") {
        recorder.record();
        if (Platform.OS === "web") void startWebWaveAnalyser();
      } else if (voiceRecordingBackendRef.current === "native") {
        await orbitaAudioWaveform.resumeRecordingAsync();
        startNativeWaveformPolling();
        startNativeStartWatchdog();
      }
      setVoiceRecorderPaused(false);
      return;
    }
    if (voiceRecorderVisible) return;
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return;
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
    });
    setVoiceWaveSamples(Array(VOICE_WAVEFORM_BARS).fill(0.14));
    setVoiceNativeDurationMs(0);
    voiceRecordingBackendRef.current = null;
    try {
      const nativeAvailable = Platform.OS !== "web" && await orbitaAudioWaveform.isAvailableAsync();
      if (nativeAvailable) {
        await orbitaAudioWaveform.startRecordingAsync();
        voiceRecordingBackendRef.current = "native";
        setVoiceRecorderVisible(true);
        setVoiceRecorderPaused(false);
        startNativeWaveformPolling();
        startNativeStartWatchdog();
        return;
      }
    } catch {
      await orbitaAudioWaveform.discardRecordingAsync().catch(() => undefined);
    }

    try {
      await startExpoRecorderBackend();
      setVoiceRecorderVisible(true);
      setVoiceRecorderPaused(false);
    } catch {
      voiceRecordingBackendRef.current = null;
      setVoiceRecorderVisible(false);
      setVoiceRecorderPaused(false);
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
      }).catch(() => undefined);
    }
  }

  async function pauseVoiceRecording() {
    if (!voiceRecorderVisible || voiceRecorderPaused) return;
    stopNativeStartWatchdog();
    if (voiceRecordingBackendRef.current === "expo") {
      recorder.pause();
      stopWebWaveAnalyser();
    } else if (voiceRecordingBackendRef.current === "native") {
      await orbitaAudioWaveform.pauseRecordingAsync();
      stopNativeWaveformPolling();
    }
    setVoiceRecorderPaused(true);
  }

  async function finishVoiceRecording() {
    if (!voiceRecorderVisible || voiceRecorderBusy) return null;
    setVoiceRecorderBusy(true);
    let result:
      | { durationMs: number | null; mimeType: string; uri: string; waveformSamples: number[] }
      | null = null;
    const backend = voiceRecordingBackendRef.current;
    if (backend === "expo") {
      const durationMs = recorderState.durationMillis || null;
      const waveformSamples = normalizeWaveSamples(voiceWaveSamples, VOICE_WAVEFORM_BARS);
      try {
        stopWebWaveAnalyser();
        await recorder.stop();
      } catch {
        setVoiceRecorderBusy(false);
        return null;
      }
      const uri = recorder.uri ?? recorderState.url;
      const mimeType = expoVoiceMimeType(uri);
      result = uri
        ? {
            durationMs,
            mimeType,
            uri,
            waveformSamples,
          }
        : null;
    } else if (backend === "native") {
      try {
        stopNativeStartWatchdog();
        stopNativeWaveformPolling();
        const nativeResult = await orbitaAudioWaveform.stopRecordingAsync();
        result = {
          durationMs: nativeResult.durationMs,
          mimeType: nativeResult.mimeType,
          uri: nativeResult.uri,
          waveformSamples: normalizeWaveSamples(nativeResult.waveformSamples, VOICE_WAVEFORM_BARS),
        };
      } catch {
        setVoiceRecorderBusy(false);
        return null;
      }
    } else {
      setVoiceRecorderBusy(false);
      return null;
    }
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
    }).catch(() => undefined);
    setVoiceRecorderVisible(false);
    setVoiceRecorderPaused(false);
    setVoiceRecorderBusy(false);
    setVoiceNativeDurationMs(0);
    voiceRecordingBackendRef.current = null;
    if (!result?.uri) return null;
    const extension = result.mimeType === "audio/wav" ? ".wav" : expoVoiceExtension(result.mimeType);
    return {
      localId: `voice-${Date.now()}`,
      kind: "voice",
      uri: result.uri,
      name: `voice-note-${Date.now()}${extension}`,
      mimeType: result.mimeType,
      durationMs: result.durationMs,
      waveformSamples: result.waveformSamples,
    } satisfies ComposerAttachment;
  }

  async function discardVoiceAttachment() {
    stopWebWaveAnalyser();
    stopNativeWaveformPolling();
    stopNativeStartWatchdog();
    if (voiceRecorderVisible && voiceRecordingBackendRef.current === "expo") {
      await recorder.stop().catch(() => undefined);
    }
    if (voiceRecorderVisible && voiceRecordingBackendRef.current === "native") {
      await orbitaAudioWaveform.discardRecordingAsync().catch(() => undefined);
    }
    if (voiceRecorderVisible) {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
      }).catch(() => undefined);
    }
    setVoiceRecorderVisible(false);
    setVoiceRecorderPaused(false);
    setVoiceRecorderBusy(false);
    setVoiceNativeDurationMs(0);
    voiceRecordingBackendRef.current = null;
    setVoiceWaveSamples(Array(VOICE_WAVEFORM_BARS).fill(0.14));
  }

  async function sendVoiceAttachment() {
    const pendingVoice = await finishVoiceRecording();
    if (!pendingVoice) return;
    await onSend("voice", draft, pendingVoice);
  }

  async function sendQuickPrompt(item: (typeof AGENT_QUICK_PROMPTS)[number]) {
    setQuickPromptOpen(false);
    await onSend("text", item.label, null, item.prompt);
  }

  const composerCanSend = Boolean(draft.trim() || attachment);
  const voiceElapsedMs = voiceRecordingBackendRef.current === "expo" ? recorderState.durationMillis : voiceNativeDurationMs;
  const voiceElapsedLabel = formatDurationMs(voiceElapsedMs);

  const edgeSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gestureState) => {
          if (isWide || Platform.OS === "web") return false;

          const startsAtLeftEdge = gestureState.x0 <= EDGE_SWIPE_WIDTH;
          const startsAtRightEdge = gestureState.x0 >= width - EDGE_SWIPE_WIDTH;
          const inwardFromLeft = startsAtLeftEdge && gestureState.dx > 14;
          const inwardFromRight = startsAtRightEdge && gestureState.dx < -14;
          const mostlyHorizontal = Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.2;

          return (inwardFromLeft || inwardFromRight) && mostlyHorizontal;
        },
        onPanResponderRelease: (_event, gestureState) => {
          const enoughDistance = Math.abs(gestureState.dx) >= EDGE_SWIPE_TRIGGER;
          const controlledVerticalDrift = Math.abs(gestureState.dy) <= EDGE_SWIPE_VERTICAL_LIMIT;
          if (enoughDistance && controlledVerticalDrift) onBack();
        },
        onShouldBlockNativeResponder: () => false,
      }),
    [isWide, onBack, width],
  );

  return (
    <View
      {...(!isWide ? edgeSwipeResponder.panHandlers : {})}
      style={[
        styles.chatPane,
        isDarkTheme && styles.chatPaneDark,
        !isWide && styles.chatPaneMobile,
        !isWide && { paddingBottom: composerKeyboardGap },
      ]}
    >
      {quickPromptOpen ? (
        <Pressable onPress={() => setQuickPromptOpen(false)} style={styles.quickPromptBackdrop} />
      ) : null}
      <View
        style={[
          styles.chatHeader,
          { backgroundColor: isDarkTheme ? "#202C33" : themeColors.primaryDark },
          isDarkTheme && styles.chatHeaderDark,
          isDarkTheme && { borderBottomColor: themeColors.darkAccentSoft },
        ]}
      >
        <View style={[styles.row, styles.chatHeaderMain]}>
          {!isWide ? <IconButton icon="arrow-back" label="Back to chats" onPress={onBack} /> : null}
          <Avatar avatarUrl={conversation.avatarUrl} isBot={isAgentConversation} name={conversation.title} />
          <View style={styles.chatRowBody}>
            <Text numberOfLines={1} style={styles.chatHeaderTitle}>{conversation.title}</Text>
            <Pressable
              disabled={Boolean(agentThinking || typingText) || conversation.kind === "direct"}
              onPress={() => setMembersPanelOpen(true)}
              style={({ pressed }) => [styles.chatHeaderSubButton, pressed && styles.pressablePressed]}
            >
              <Text style={[styles.chatHeaderSub, Boolean(typingText) && styles.chatHeaderSubTyping]}>
                {agentThinking
                  ? `${conversation.title.split(" ")[0] || "Agent"} is thinking...`
                  : typingText
                    ? typingText
                    : conversationSubtitle(conversation)}
              </Text>
            </Pressable>
          </View>
        </View>
        <View style={[styles.headerActions, styles.chatHeaderActions]}>
          {isTaskThreadConversation ? (
            <Pressable
              accessibilityLabel="Open subtasks"
              onPress={() => setSubtaskPanelOpen((value) => !value)}
              style={({ pressed }) => [styles.subtasksHeaderPill, pressed && styles.pressablePressed]}
            >
              <Ionicons color="#0B7F68" name="git-branch-outline" size={16} />
              <Text style={styles.subtasksHeaderPillText}>
                {resolvedSubtasks}/{subtaskConversations.length} subtasks
              </Text>
            </Pressable>
          ) : null}
          {conversation.kind === "group" || conversation.taskThread ? (
            <IconButton icon="person-add-outline" label="Add members" onPress={onAddMembers} />
          ) : null}
          {unsavedPeer ? <IconButton icon="person-add-outline" label="Save contact" onPress={onSaveContact} /> : null}
          <IconButton icon="call-outline" label="Voice call" />
        </View>
      </View>
      {isArchivedTaskThread ? (
        <View style={[styles.archivedTaskBanner, isDarkTheme && styles.archivedTaskBannerDark]}>
          <View style={[styles.archivedTaskBannerIcon, isDarkTheme && styles.archivedTaskBannerIconDark]}>
            <Ionicons
              color={taskThread?.status === "discarded" || taskThread?.status === "closed" ? colors.faint : "#10B981"}
              name={taskThread?.status === "discarded" || taskThread?.status === "closed" ? "archive-outline" : "checkmark-done-outline"}
              size={18}
            />
          </View>
          <View style={styles.archivedTaskBannerText}>
            <View style={styles.archivedTaskBannerTitleRow}>
              <Text style={[styles.archivedTaskBannerTitle, isDarkTheme && styles.archivedTaskBannerTitleDark]}>
                {archivedTaskTitle}
              </Text>
              <Text style={[styles.archivedTaskBannerPill, isDarkTheme && styles.archivedTaskBannerPillDark]}>
                {archivedTaskLabel}
              </Text>
            </View>
            <Text numberOfLines={1} style={[styles.archivedTaskBannerCopy, isDarkTheme && styles.archivedTaskBannerCopyDark]}>
              {taskThread?.taskNumber ?? "Task"} - {taskThread?.title ?? conversation.title}
            </Text>
          </View>
        </View>
      ) : null}
      {subtaskPanelOpen && isTaskThreadConversation ? (
        <TaskThreadSubtasksPanel
          onCreateSubtask={onCreateSubtask}
          onOpenSubtask={onOpenSubtask}
          subtasks={subtaskConversations}
        />
      ) : null}
      <MembersListModal
        currentUserId={currentUserId}
        members={visibleMembers}
        onClose={() => setMembersPanelOpen(false)}
        onOpenMember={async (memberId) => {
          setMembersPanelOpen(false);
          await onOpenMemberDirect(memberId);
        }}
        title={isTaskThreadConversation ? "Task members" : "Group members"}
        visible={membersPanelOpen}
      />
      <ScrollView
        contentContainerStyle={[
          styles.messageList,
          !isDarkTheme && { backgroundColor: themeColors.accentSoft },
          isDarkTheme && styles.messageListDark,
        ]}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={handleContentSizeChange}
        onLayout={() => scrollToLatest(false)}
        onScroll={handleMessageScroll}
        onScrollBeginDrag={() => {
          followAgentExchangeUntilRef.current = 0;
        }}
        scrollEventThrottle={80}
        ref={scrollRef}
      >
        {messagesLoading ? (
          <MessageListSkeleton />
        ) : messages.length ? (
          <>
            {loadingOlder ? (
              <View style={[styles.olderMessagesLoader, isDarkTheme && styles.olderMessagesLoaderDark]}>
                <ActivityIndicator color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} size="small" />
              </View>
            ) : null}
            {messages.map((message, index) => {
              const mine = message.senderId === currentUserId;
              const sender = conversation.participants.find((participant) => participant.id === message.senderId);
              const senderIsAgent = sender?.about?.trim().toLowerCase() === "task manager agent";
              const isAudioKind = message.kind === "voice" || message.kind === "audio";
              const previous = messages[index - 1];
              const showDate = !previous || messageDateKey(previous.createdAt) !== messageDateKey(message.createdAt);
              const repliedMessage = message.replyToMessageId
                ? messages.find((candidate) => candidate.id === message.replyToMessageId)
                : null;
              const replyTo = repliedMessage ? buildReplyPreviewFromMessage(repliedMessage) : message.replyTo ?? null;
              return (
                <View key={message.id} style={styles.messageWithDate}>
                  {showDate ? (
                    <View style={[styles.datePill, isDarkTheme && styles.datePillDark]}>
                      <Text style={[styles.datePillText, isDarkTheme && styles.datePillTextDark]}>{messageDateLabel(message.createdAt)}</Text>
                    </View>
                  ) : null}
                  <View style={[styles.messageIdentityRow, mine ? styles.messageIdentityMine : styles.messageIdentityTheirs]}>
                    {!mine && showSenderIdentity ? (
                      <Avatar
                        avatarUrl={sender?.avatarUrl}
                        isBot={senderIsAgent}
                        name={sender?.displayName ?? "Member"}
                        size={30}
                      />
                    ) : null}
                    <View
                      style={[
                        styles.messageWrap,
                        isAudioKind && styles.messageWrapAudio,
                        !mine && showSenderIdentity && styles.messageWrapWithAvatar,
                        mine ? styles.messageMine : styles.messageTheirs,
                      ]}
                    >
                      {!mine && showSenderIdentity ? (
                        <Text style={[styles.senderName, isDarkTheme && styles.senderNameDark]}>
                          {sender?.displayName ?? "Member"}
                        </Text>
                      ) : null}
                      <SwipeableMessageBubble
                        message={message}
                        mine={mine}
                        onActions={onMessageActions}
                        onReply={() => onReplyToMessage(message)}
                        themeColors={themeColors}
                      >
                        {message.forwardedFrom ? (
                          <View style={styles.forwardedRow}>
                            <Ionicons color={mine ? (isDarkTheme ? "rgba(233,237,239,0.78)" : themeColors.primaryDark) : themeColors.primaryDark} name="arrow-redo-outline" size={13} />
                            <Text style={[styles.forwardedText, mine && (isDarkTheme ? styles.forwardedTextMineDark : styles.forwardedTextMine)]}>
                              Forwarded from {message.forwardedFrom.senderName}
                            </Text>
                          </View>
                        ) : null}
                        {replyTo ? (
                          <MessageReplyQuote
                            mine={mine}
                            reply={replyTo}
                            senderName={participantDisplayName(conversation, replyTo.senderId, currentUserId)}
                            themeColors={themeColors}
                          />
                        ) : null}
                        {message.attachments[0] ? <MessageAttachmentCard attachment={message.attachments[0]} mine={mine} /> : null}
                        {message.body ? <MessageBody mine={mine} text={message.body} /> : null}
                        <View style={styles.messageMeta}>
                          <Text style={[styles.metaText, mine && (isDarkTheme ? styles.metaTextMineDark : styles.metaTextMine)]}>{formatTime(message.createdAt)}</Text>
                          {mine && message.localState === "sending" ? (
                            <Ionicons color={isDarkTheme ? "rgba(233,237,239,0.72)" : colors.faint} name="time-outline" size={13} />
                          ) : null}
                          {mine && message.localState === "queued" ? (
                            <Ionicons color={isDarkTheme ? "rgba(233,237,239,0.72)" : colors.faint} name="cloud-offline-outline" size={13} />
                          ) : null}
                          {mine && message.localState === "failed" ? (
                            <Ionicons color={colors.danger} name="alert-circle" size={15} />
                          ) : null}
                          {mine && !message.localState ? (
                            <Ionicons color={isDarkTheme ? "#53BDEB" : themeColors.primaryDark} name="checkmark-done" size={15} />
                          ) : null}
                        </View>
                      </SwipeableMessageBubble>
                    </View>
                  </View>
                </View>
              );
            })}
          </>
        ) : (
          isAgentConversation ? (
            <View style={[styles.agentWelcomeCard, isDarkTheme && styles.agentWelcomeCardDark]}>
              <Text style={[styles.agentWelcomeTitle, isDarkTheme && styles.agentWelcomeTitleDark]}>
                Welcome to your Task Manager Agent chat
              </Text>
              <Text style={[styles.agentWelcomeBody, isDarkTheme && styles.agentWelcomeBodyDark]}>
                Ask me to assign tasks, send follow-ups, and share team status snapshots.
              </Text>
            </View>
          ) : (
            <EmptyState icon="lock-closed-outline" title="No messages" copy="Send the first message in this conversation." compact />
          )
        )}
        {agentThinking ? (
          <View style={[styles.messageWrap, styles.messageTheirs]}>
            <View style={[styles.bubble, styles.theirBubble, isDarkTheme && styles.theirBubbleDark, styles.thinkingBubble]}>
              <ActivityIndicator color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} size="small" />
              <Text style={[styles.thinkingText, isDarkTheme && styles.thinkingTextDark]}>Thinking...</Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.composer, voiceRecorderVisible && styles.composerRecording, isDarkTheme && styles.composerDark]}>
        {!voiceRecorderVisible && isAgentConversation ? (
          <View style={styles.quickPromptDock}>
            {quickPromptOpen ? (
              <View style={[styles.quickPromptMenu, isDarkTheme && styles.quickPromptMenuDark]}>
                <Text style={[styles.quickPromptMenuTitle, isDarkTheme && styles.quickPromptMenuTitleDark]}>
                  Quick prompts
                </Text>
                {AGENT_QUICK_PROMPTS.map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      void sendQuickPrompt(item);
                    }}
                    style={({ pressed }) => [
                      styles.quickPromptItem,
                      isDarkTheme && styles.quickPromptItemDark,
                      pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                    ]}
                  >
                    <Text style={[styles.quickPromptItemText, isDarkTheme && styles.quickPromptItemTextDark]}>
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Pressable
              accessibilityLabel="Open quick prompts"
              onPress={() => setQuickPromptOpen((prev) => !prev)}
              style={({ pressed }) => [
                styles.quickPromptButton,
                isDarkTheme && styles.quickPromptButtonDark,
                pressed && styles.pressablePressed,
              ]}
            >
              <Ionicons color={isDarkTheme ? "#FFFFFF" : themeColors.primaryDark} name="help-circle-outline" size={18} />
            </Pressable>
          </View>
        ) : null}
        {voiceRecorderVisible ? (
          <View style={[styles.inlineVoiceRecorder, isDarkTheme && styles.inlineVoiceRecorderDark]}>
            <Pressable
              accessibilityLabel="Delete voice recording"
              disabled={voiceRecorderBusy}
              onPress={() => {
                void discardVoiceAttachment();
              }}
              style={({ pressed }) => [
                styles.voiceInlineButton,
                styles.voiceDeleteButton,
                isDarkTheme && styles.voiceDeleteButtonDark,
                pressed && styles.pressablePressed,
              ]}
            >
              <Ionicons color={colors.danger} name="trash-outline" size={20} />
            </Pressable>
            <View style={styles.voiceRecorderContent}>
              <View style={styles.voiceRecorderMeta}>
                <View style={[styles.voiceRecordingDot, voiceRecorderPaused && styles.voiceRecordingDotPaused]} />
                <Text style={[styles.voiceRecorderTime, isDarkTheme && styles.voiceRecorderTimeDark]}>
                  {voiceElapsedLabel}
                </Text>
              </View>
              <View style={styles.voiceRecorderWaveRow}>
                {voiceWaveSamples.map((sample, index) => (
                  <View
                    key={`voice-wave-${index}`}
                    style={[
                      styles.voiceRecorderWaveBar,
                      {
                        height: 5 + Math.round(sample * 28),
                        opacity: voiceRecorderPaused ? 0.44 : 0.68 + sample * 0.32,
                      },
                    ]}
                  />
                ))}
              </View>
            </View>
            <Pressable
              accessibilityLabel={voiceRecorderPaused ? "Resume voice recording" : "Pause voice recording"}
              disabled={voiceRecorderBusy}
              onPress={voiceRecorderPaused ? startVoiceRecording : pauseVoiceRecording}
              style={({ pressed }) => [
                styles.voiceInlineButton,
                isDarkTheme && styles.voiceInlineButtonDark,
                pressed && styles.pressablePressed,
              ]}
            >
              <Ionicons color={isDarkTheme ? "#E9EDEF" : themeColors.primaryDark} name={voiceRecorderPaused ? "mic" : "pause"} size={20} />
            </Pressable>
            <Pressable
              accessibilityLabel="Send voice recording"
              disabled={voiceRecorderBusy}
              onPress={() => {
                void sendVoiceAttachment();
              }}
              style={({ pressed }) => [
                styles.voiceSendButton,
                pressed && styles.pressablePressed,
                voiceRecorderBusy && styles.buttonDisabled,
              ]}
            >
              {voiceRecorderBusy ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <Ionicons color="#FFFFFF" name="send" size={19} />
              )}
            </Pressable>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityLabel="Add attachment"
              onPress={onOpenAttachmentMenu}
              style={({ pressed }) => [
                styles.composerAccessoryButton,
                isDarkTheme && styles.composerAccessoryButtonDark,
                pressed && styles.pressablePressed,
              ]}
            >
              <Ionicons color={isDarkTheme ? "#FFFFFF" : colors.ink} name="add" size={22} />
            </Pressable>
            <View style={styles.composerBody}>
              {replyingToMessage ? (
                <ComposerReplyPreview
                  conversation={conversation}
                  currentUserId={currentUserId}
                  message={replyingToMessage}
                  onRemove={onRemoveReply}
                />
              ) : null}
              {attachment ? (
                <ComposerAttachmentPreview attachment={attachment} onRemove={onRemoveAttachment} />
              ) : null}
              {showOrbitaMentionSuggestion ? (
                <Pressable
                  accessibilityLabel="Mention Orbita"
                  onPress={() => setDraft(insertOrbitaMention(draft))}
                  style={({ pressed }) => [
                    styles.mentionSuggestion,
                    isDarkTheme && styles.mentionSuggestionDark,
                    pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                  ]}
                >
                  <View style={[styles.mentionSuggestionAvatar, isDarkTheme && styles.mentionSuggestionAvatarDark]}>
                    <Ionicons color={isDarkTheme ? "#111B21" : "#FFFFFF"} name="sparkles-outline" size={16} />
                  </View>
                  <View style={styles.mentionSuggestionBody}>
                    <Text style={[styles.mentionSuggestionName, isDarkTheme && styles.mentionSuggestionNameDark]}>
                      Orbita
                    </Text>
                    <Text style={[styles.mentionSuggestionHandle, isDarkTheme && styles.mentionSuggestionHandleDark]}>
                      @orbita
                    </Text>
                  </View>
                  <Ionicons color={isDarkTheme ? "rgba(233,237,239,0.62)" : colors.faint} name="return-down-forward-outline" size={17} />
                </Pressable>
              ) : null}
              <View style={[styles.composerInputShell, isDarkTheme && styles.composerInputShellDark, attachment && styles.composerInputWithAttachment]}>
                {showComposerMentionHighlight ? (
                  <View pointerEvents="none" style={styles.composerInputOverlay}>
                    <Text style={[styles.composerInputOverlayText, isDarkTheme && styles.composerInputOverlayTextDark]}>
                      {renderComposerMentionText(draft, isDarkTheme)}
                    </Text>
                  </View>
                ) : null}
                <TextInput
                  blurOnSubmit={false}
                  cursorColor={isDarkTheme ? "#FFFFFF" : themeColors.primaryDark}
                  scrollEnabled={false}
                  selectionColor={isDarkTheme ? themeColors.accent : themeColors.primaryDark}
                  multiline
                  onChangeText={setDraft}
                  onKeyPress={(event) => {
                    if (Platform.OS !== "web") return;
                    const webEvent = event as unknown as {
                      nativeEvent: { key?: string; shiftKey?: boolean };
                      preventDefault?: () => void;
                    };
                    if (webEvent.nativeEvent.key !== "Enter" || webEvent.nativeEvent.shiftKey) return;
                    webEvent.preventDefault?.();
                    onSend();
                  }}
                  onSubmitEditing={() => {
                    if (Platform.OS !== "web") onSend();
                  }}
                  placeholder="Message"
                  placeholderTextColor={isDarkTheme ? "rgba(255,255,255,0.45)" : colors.faint}
                  style={[
                    styles.composerInput,
                    styles.composerInputField,
                    isDarkTheme && styles.composerInputDark,
                    attachment && styles.composerInputWithAttachment,
                    showComposerMentionHighlight && styles.composerInputTransparentText,
                  ]}
                  value={draft}
                />
              </View>
            </View>
            {composerCanSend ? (
              <Pressable
                accessibilityLabel="Send message"
                disabled={!composerCanSend}
                onPress={() => onSend()}
                style={({ pressed }) => [styles.sendButton, { backgroundColor: themeColors.primaryDark }, pressed && styles.pressablePressed, !composerCanSend && styles.buttonDisabled]}
              >
                <Ionicons color="#FFFFFF" name="send" size={20} />
              </Pressable>
            ) : (
              <View style={styles.composerQuickActions}>
                <Pressable
                  accessibilityLabel="Take photo"
                  onPress={onTakePhoto}
                  style={({ pressed }) => [
                    styles.sendButton,
                    styles.cameraQuickButton,
                    { backgroundColor: themeColors.primarySoft, borderColor: themeColors.accentSoft },
                    isDarkTheme && styles.cameraQuickButtonDark,
                    pressed && styles.pressablePressed,
                  ]}
                >
                  <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="camera-outline" size={20} />
                </Pressable>
                <Pressable
                  accessibilityLabel="Record voice note"
                  onPress={startVoiceRecording}
                  style={({ pressed }) => [styles.sendButton, pressed && styles.pressablePressed]}
                >
                  <Ionicons color="#FFFFFF" name="mic" size={19} />
                </Pressable>
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}

function ComposerReplyPreview({
  conversation,
  currentUserId,
  message,
  onRemove,
}: {
  conversation: BackendConversation;
  currentUserId: string;
  message: ChatMessage;
  onRemove: () => void;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const senderName = participantDisplayName(conversation, message.senderId, currentUserId);
  return (
    <View style={[styles.composerReply, isDarkTheme && styles.composerReplyDark]}>
      <View style={[styles.composerReplyBar, { backgroundColor: themeColors.primaryDark }]} />
      <View style={styles.chatRowBody}>
        <Text numberOfLines={1} style={[styles.composerReplyName, isDarkTheme && styles.composerReplyNameDark, { color: isDarkTheme ? themeColors.accent : themeColors.primaryDark }]}>
          {senderName}
        </Text>
        <Text numberOfLines={2} style={[styles.composerReplyText, isDarkTheme && styles.composerReplyTextDark]}>
          {messagePreviewText(message) || "Message"}
        </Text>
      </View>
      <Pressable onPress={onRemove} style={({ pressed }) => [styles.composerAttachmentClose, pressed && styles.pressablePressed]}>
        <Ionicons color={isDarkTheme ? "#FFFFFF" : colors.ink} name="close" size={16} />
      </Pressable>
    </View>
  );
}

function TaskThreadSubtasksPanel({
  onCreateSubtask,
  onOpenSubtask,
  subtasks,
}: {
  onCreateSubtask: () => void;
  onOpenSubtask: (conversationId: string) => void;
  subtasks: BackendConversation[];
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const resolvedCount = subtasks.filter((conversation) => isCompletedTaskThreadStatus(conversation.taskThread?.status)).length;
  return (
    <View style={[styles.subtasksPanel, isDarkTheme && styles.subtasksPanelDark]}>
      <View style={styles.subtasksPanelHeader}>
        <View>
          <Text style={[styles.subtasksPanelTitle, isDarkTheme && styles.subtasksPanelTitleDark]}>Subtasks</Text>
          <Text style={[styles.subtasksPanelMeta, isDarkTheme && styles.subtasksPanelMetaDark]}>
            {resolvedCount}/{subtasks.length} resolved
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Create subtask"
          onPress={onCreateSubtask}
          style={({ pressed }) => [styles.subtasksCreateButton, { backgroundColor: themeColors.primaryDark }, pressed && styles.pressablePressed]}
        >
          <Ionicons color="#FFFFFF" name="add" size={16} />
          <Text style={styles.subtasksCreateButtonText}>Subtask</Text>
        </Pressable>
      </View>
      {subtasks.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subtasksScroller}>
          {subtasks.map((conversation) => {
            const thread = conversation.taskThread;
            const completed = isCompletedTaskThreadStatus(thread?.status);
            return (
              <Pressable
                key={conversation.id}
                onPress={() => onOpenSubtask(conversation.id)}
                style={({ pressed }) => [
                  styles.subtaskCard,
                  isDarkTheme && styles.subtaskCardDark,
                  completed && styles.subtaskCardResolved,
                  pressed && styles.pressablePressed,
                ]}
              >
                <Text numberOfLines={1} style={[styles.subtaskCardNumber, isDarkTheme && styles.subtaskCardNumberDark]}>
                  {thread?.taskNumber ?? "TASK"}
                </Text>
                <Text numberOfLines={2} style={[styles.subtaskCardTitle, isDarkTheme && styles.subtaskCardTitleDark]}>
                  {thread?.title ?? conversation.title}
                </Text>
                <View style={styles.subtaskCardFooter}>
                  <View style={[styles.taskStatusDot, thread?.status === "in_progress" && styles.taskStatusDotProgress, completed && styles.taskStatusDotDone]} />
                  <Text style={[styles.subtaskCardStatus, isDarkTheme && styles.subtaskCardStatusDark]}>
                    {taskThreadStatusLabel(thread?.status)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : (
        <Text style={[styles.subtasksEmptyText, isDarkTheme && styles.subtasksEmptyTextDark]}>
          No subtasks yet. Create one when this task needs smaller tracked work.
        </Text>
      )}
    </View>
  );
}

function ComposerAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View style={[styles.composerAttachment, isDarkTheme && styles.composerAttachmentDark]}>
      {attachment.kind === "image" ? (
        <Image source={{ uri: attachment.uri }} style={styles.composerAttachmentImage} />
      ) : (
        <View style={[styles.composerAttachmentIcon, isDarkTheme && styles.composerAttachmentIconDark]}>
          <Ionicons
            color={isDarkTheme ? themeColors.accent : themeColors.primaryDark}
            name={attachment.kind === "document" ? "document-text-outline" : "mic-outline"}
            size={18}
          />
        </View>
      )}
      <View style={styles.chatRowBody}>
        <Text numberOfLines={1} style={[styles.composerAttachmentTitle, isDarkTheme && styles.composerAttachmentTitleDark]}>{attachment.name}</Text>
        <Text style={[styles.composerAttachmentMeta, isDarkTheme && styles.composerAttachmentMetaDark]}>
          {attachment.kind === "document"
            ? formatBytes(attachment.sizeBytes)
            : attachment.durationMs
              ? formatDurationMs(attachment.durationMs)
              : attachment.kind === "image"
                ? "Photo"
                : "Audio"}
        </Text>
      </View>
      <Pressable onPress={onRemove} style={({ pressed }) => [styles.composerAttachmentClose, pressed && styles.pressablePressed]}>
        <Ionicons color={isDarkTheme ? "#FFFFFF" : colors.ink} name="close" size={16} />
      </Pressable>
    </View>
  );
}

function MessageAttachmentCard({
  attachment,
  mine,
}: {
  attachment: BackendAttachment;
  mine: boolean;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();

  if (attachment.kind === "image") {
    return (
      <Pressable onPress={() => openMessageUrl(attachment.url)} style={({ pressed }) => [styles.imageAttachment, pressed && styles.pressablePressed]}>
        <Image source={{ uri: attachment.url }} style={styles.imageAttachmentMedia} />
        <Text numberOfLines={1} style={[styles.attachmentCaption, mine && (isDarkTheme ? styles.attachmentCaptionMineDark : styles.attachmentCaptionMine)]}>
          {attachment.filename}
        </Text>
      </Pressable>
    );
  }

  if (attachment.kind === "voice" || attachment.kind === "audio") {
    return <AudioAttachmentCard attachment={attachment} mine={mine} />;
  }

  return (
    <Pressable
      onPress={() => openMessageUrl(attachment.url)}
      style={({ pressed }) => [
        styles.documentAttachment,
        mine && (isDarkTheme ? styles.documentAttachmentMineDark : styles.documentAttachmentMine),
        pressed && styles.pressablePressed,
      ]}
    >
      <View style={[styles.documentAttachmentIcon, mine && (isDarkTheme ? styles.documentAttachmentIconMineDark : styles.documentAttachmentIconMine)]}>
        <Ionicons color={mine ? (isDarkTheme ? "#E9EDEF" : themeColors.primaryDark) : themeColors.primaryDark} name="document-text-outline" size={20} />
      </View>
      <View style={styles.chatRowBody}>
        <Text numberOfLines={1} style={[styles.documentAttachmentTitle, mine && (isDarkTheme ? styles.documentAttachmentTitleMineDark : styles.documentAttachmentTitleMine)]}>
          {attachment.filename}
        </Text>
        <Text style={[styles.documentAttachmentMeta, mine && (isDarkTheme ? styles.documentAttachmentMetaMineDark : styles.documentAttachmentMetaMine)]}>
          {formatBytes(attachment.sizeBytes)}
        </Text>
      </View>
      <Ionicons color={mine ? (isDarkTheme ? "rgba(233,237,239,0.8)" : themeColors.primaryDark) : themeColors.primaryDark} name="open-outline" size={18} />
    </Pressable>
  );
}

function AudioAttachmentCard({
  attachment,
  mine,
}: {
  attachment: BackendAttachment;
  mine: boolean;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  const player = useAudioPlayer(attachment.url);
  const status = useAudioPlayerStatus(player);
  const bars = useMemo(() => normalizeWaveSamples(attachment.waveformSamples, 22), [attachment.waveformSamples]);
  const hasWaveform = bars.length > 0;
  const durationLabel = status.duration
    ? formatDurationMs(status.duration * 1000)
    : formatDurationMs(attachment.durationMs);

  return (
    <View style={[styles.audioAttachment, mine && (isDarkTheme ? styles.audioAttachmentMineDark : styles.audioAttachmentMine)]}>
      <Pressable
        onPress={() => {
          if (status.playing) {
            player.pause();
            return;
          }
          if ((status.currentTime || 0) >= (status.duration || 0)) {
            void player.seekTo(0);
          }
          player.play();
        }}
        style={({ pressed }) => [
          styles.audioPlayButton,
          mine && (isDarkTheme ? styles.audioPlayButtonMineDark : styles.audioPlayButtonMine),
          pressed && styles.pressablePressed,
        ]}
      >
        <Ionicons color={mine ? (isDarkTheme ? "#E9EDEF" : themeColors.primaryDark) : "#FFFFFF"} name={status.playing ? "pause" : "play"} size={17} />
      </Pressable>
      <View style={styles.chatRowBody}>
        <View style={styles.audioWaveRow}>
          {hasWaveform ? bars.map((bar, index) => {
            const playedRatio = status.duration ? (status.currentTime || 0) / Math.max(status.duration, 0.01) : 0;
            const isPlayed = index / bars.length <= playedRatio;
            return (
              <View
                key={`${attachment.id}-${index}`}
                style={[
                  styles.audioWaveBar,
                  {
                    height: waveLevelToBarHeight(bar, 8, 30),
                    backgroundColor: mine
                      ? isPlayed
                        ? isDarkTheme
                          ? "#E9EDEF"
                          : themeColors.primaryDark
                        : isDarkTheme
                          ? "rgba(233,237,239,0.45)"
                          : "rgba(17,27,33,0.35)"
                      : isPlayed
                        ? themeColors.primaryDark
                        : "#D1D7DB",
                  },
                ]}
              />
            );
          }) : (
            <View style={[styles.audioWaveMissing, mine && styles.audioWaveMissingMine, isDarkTheme && styles.audioWaveMissingDark]} />
          )}
        </View>
        <Text style={[styles.audioDuration, mine && (isDarkTheme ? styles.audioDurationMineDark : styles.audioDurationMine)]}>{durationLabel}</Text>
      </View>
    </View>
  );
}

function StatusPanel({
  isWide,
  onNewStatus,
  profile,
  statuses,
}: {
  isWide: boolean;
  onNewStatus: () => void;
  profile: BackendProfile;
  statuses: BackendStatus[];
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Status" actionIcon="add-circle-outline" actionLabel="New status" onAction={onNewStatus} />
      <ScrollView contentContainerStyle={[styles.listContent, isDarkTheme && styles.listContentDark]}>
        <Pressable
          onPress={onNewStatus}
          style={({ pressed }) => [
            styles.statusComposer,
            isDarkTheme && styles.statusComposerDark,
            pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
          ]}
        >
          <Avatar avatarUrl={profile.avatarUrl} name={profile.displayName} size={54} />
          <View style={styles.chatRowBody}>
            <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>My status</Text>
            <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>Create a text status backed by Supabase.</Text>
          </View>
          <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="add-circle" size={24} />
        </Pressable>
        {statuses.length ? (
          statuses.map((status) => (
            <View key={status.id} style={[styles.statusCard, isDarkTheme && styles.statusCardDark]}>
              <View style={styles.row}>
                <Avatar avatarUrl={status.author.avatarUrl} name={status.author.displayName} />
                <View style={styles.chatRowBody}>
                  <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>{status.author.displayName}</Text>
                  <Text style={styles.chatPreview}>{formatTime(status.createdAt)} · {status.viewCount} views</Text>
                </View>
              </View>
              <Text style={[styles.statusText, isDarkTheme && styles.statusTextDark]}>{status.text}</Text>
            </View>
          ))
        ) : (
          <EmptyState icon="aperture-outline" title="No status updates" copy="Statuses saved in Supabase will appear here." />
        )}
      </ScrollView>
    </View>
  );
}

function ContactsPanel({
  contacts,
  isWide,
  onCreateGroup,
  onNewChat,
  onOpenContact,
}: {
  contacts: BackendProfile[];
  isWide: boolean;
  onCreateGroup: () => void;
  onNewChat: () => void;
  onOpenContact: (contactId: string) => void;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Contacts" actionIcon="person-add-outline" actionLabel="Add contact" onAction={onNewChat} />
      <Pressable
        accessibilityRole="button"
        onPress={onCreateGroup}
        style={({ pressed }) => [
          styles.quickAction,
          isDarkTheme && styles.quickActionDark,
          pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
        ]}
      >
        <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="people-outline" size={22} />
        <Text style={[styles.quickActionText, isDarkTheme && styles.quickActionTextDark, { color: isDarkTheme ? themeColors.accent : themeColors.primaryDark }]}>New group</Text>
      </Pressable>
      <ScrollView contentContainerStyle={[styles.listContent, isDarkTheme && styles.listContentDark]}>
        {contacts.length ? contacts.map((contact) => (
          <Pressable
            accessibilityLabel={`Message ${contact.displayName}`}
            accessibilityRole="button"
            key={contact.id}
            onPress={() => onOpenContact(contact.id)}
            style={({ pressed }) => [
              styles.contactRow,
              isDarkTheme && styles.contactRowDark,
              pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
            ]}
          >
            <Avatar
              avatarUrl={contact.avatarUrl}
              isBot={contact.about?.trim().toLowerCase() === "task manager agent"}
              name={contact.displayName}
            />
            <View style={styles.chatRowBody}>
              <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>{contact.displayName}</Text>
              <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>{contact.phone ?? contact.about}</Text>
            </View>
            <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="chatbubble-outline" size={21} />
          </Pressable>
        )) : <EmptyState icon="person-add-outline" title="No contacts" copy="Add contacts by phone number to start 1:1 chats or groups." />}
      </ScrollView>
    </View>
  );
}

function CallsPanel({ isWide }: { isWide: boolean }) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Calls" actionIcon="call-outline" actionLabel="New call" onAction={() => undefined} />
      <EmptyState icon="call-outline" title="Calls are not enabled" copy="The database has call tables, but WebRTC signaling is intentionally separate from messaging." />
    </View>
  );
}

function SettingsPanel({
  isWide,
  notice,
  onNewChat,
  onOpenProfile,
  onSignOut,
  onSyncDeviceContacts,
  onUploadProfilePhoto,
  isSyncingDeviceContacts,
  isUploadingProfilePhoto,
  profile,
}: {
  isWide: boolean;
  notice: string;
  onNewChat: () => void;
  onOpenProfile: () => void;
  onSignOut: () => void;
  onSyncDeviceContacts: () => void;
  onUploadProfilePhoto: () => void;
  isSyncingDeviceContacts: boolean;
  isUploadingProfilePhoto: boolean;
  profile: BackendProfile;
}) {
  const { accentTheme, accentThemes, isDarkTheme, setAccentTheme, themeColors, themeMode, toggleTheme } = useAppTheme();
  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Settings" actionIcon="create-outline" actionLabel="Edit profile" onAction={onOpenProfile} />
      <ScrollView contentContainerStyle={[styles.settingsContent, isDarkTheme && styles.listContentDark]}>
      <View style={[styles.profileCard, isDarkTheme && styles.profileCardDark]}>
        <Pressable
          disabled={isUploadingProfilePhoto}
          hitSlop={10}
          onPress={onUploadProfilePhoto}
          style={({ pressed }) => [
            styles.profileAvatarButton,
            pressed && styles.pressablePressed,
            isUploadingProfilePhoto && styles.disabledPressable,
          ]}
        >
          <Avatar avatarUrl={profile.avatarUrl} name={profile.displayName} size={64} />
          <View style={[styles.profileAvatarBadge, { backgroundColor: isDarkTheme ? themeColors.accent : themeColors.primaryDark }, isDarkTheme && styles.profileAvatarBadgeDark]}>
            {isUploadingProfilePhoto ? (
              <ActivityIndicator color={isDarkTheme ? colors.primaryDark : "#FFFFFF"} size="small" />
            ) : (
              <Ionicons color={isDarkTheme ? colors.primaryDark : "#FFFFFF"} name="camera" size={11} />
            )}
          </View>
        </Pressable>
        <View style={styles.chatRowBody}>
          <Text style={[styles.profileName, isDarkTheme && styles.profileNameDark]}>{profile.displayName}</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>{profile.phone ?? "No phone on profile"}</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>{profile.about}</Text>
          <Text style={[styles.profileAvatarHint, isDarkTheme && styles.profileAvatarHintDark]}>
            {isUploadingProfilePhoto ? "Uploading profile photo..." : "Tap profile photo to upload or replace"}
          </Text>
        </View>
      </View>
      <Pressable
        onPress={toggleTheme}
        style={({ pressed }) => [
          styles.settingRow,
          isDarkTheme && styles.settingRowDark,
          pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
        ]}
      >
        <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name={isDarkTheme ? "moon" : "sunny-outline"} size={22} />
        <View style={styles.chatRowBody}>
          <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>Theme</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>
            {themeMode === "dark" ? "Dark AI signal theme" : "Light Orbita theme"}
          </Text>
        </View>
        <View style={[styles.themeSwitch, isDarkTheme && { backgroundColor: themeColors.darkAccentSoft }]}>
          <View style={[styles.themeSwitchKnob, isDarkTheme && styles.themeSwitchKnobOn, isDarkTheme && { backgroundColor: themeColors.accent }]} />
        </View>
      </Pressable>
      <View style={[styles.settingRowStack, isDarkTheme && styles.settingRowDark]}>
        <View style={styles.rowBetween}>
          <View style={styles.chatRowBody}>
            <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>Color theme</Text>
            <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>
              {themeColors.label} is active
            </Text>
          </View>
          <View style={[styles.themeSelectedDot, { backgroundColor: themeColors.primaryDark }]} />
        </View>
        <View style={styles.accentThemeGrid}>
          {accentThemes.map((item) => {
            const selected = item.id === accentTheme;
            return (
              <Pressable
                accessibilityLabel={`Use ${item.label} theme`}
                accessibilityRole="button"
                key={item.id}
                onPress={() => setAccentTheme(item.id)}
                style={({ pressed }) => [
                  styles.accentThemeOption,
                  { borderColor: selected ? item.primaryDark : isDarkTheme ? "rgba(255,255,255,0.12)" : colors.line },
                  selected && { backgroundColor: isDarkTheme ? item.darkAccentSoft : item.accentSoft },
                  pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
                ]}
              >
                <View style={styles.accentSwatchStack}>
                  <View style={[styles.accentSwatch, { backgroundColor: item.primaryDark }]} />
                  <View style={[styles.accentSwatch, styles.accentSwatchMid, { backgroundColor: item.primary }]} />
                  <View style={[styles.accentSwatch, styles.accentSwatchLight, { backgroundColor: item.bubbleMine }]} />
                </View>
                <Text numberOfLines={1} style={[styles.accentThemeLabel, isDarkTheme && styles.accentThemeLabelDark]}>
                  {item.label.replace("Orbita ", "")}
                </Text>
                {selected ? (
                  <Ionicons color={isDarkTheme ? item.accent : item.primaryDark} name="checkmark-circle" size={17} />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
      <Pressable
        onPress={onOpenProfile}
        style={({ pressed }) => [
          styles.settingRow,
          isDarkTheme && styles.settingRowDark,
          pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
        ]}
      >
        <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="person-circle-outline" size={22} />
        <View style={styles.chatRowBody}>
          <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>Profile</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>Edit your display name and status line</Text>
        </View>
      </Pressable>
      <Pressable
        onPress={onNewChat}
        style={({ pressed }) => [
          styles.settingRow,
          isDarkTheme && styles.settingRowDark,
          pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
        ]}
      >
        <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name="person-add-outline" size={22} />
        <View style={styles.chatRowBody}>
          <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>Add contact</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>Start a chat by phone number</Text>
        </View>
      </Pressable>
      {notice ? <Text style={[styles.settingsNotice, { color: themeColors.primaryDark, backgroundColor: themeColors.accentSoft }, isDarkTheme && { color: themeColors.accent, backgroundColor: themeColors.darkAccentSoft }]}>{notice}</Text> : null}
      {[
        ["key-outline", "Account", "Phone OTP session stored by Supabase Auth"],
        ["lock-closed-outline", "Privacy", "Profile and contact visibility enforced by RLS"],
        ["cloud-upload-outline", "Storage", "Media buckets are configured in Supabase"],
        ["information-circle-outline", "App version", appVersionLabel()],
      ].map(([icon, title, copy]) => (
        <View key={title} style={[styles.settingRow, isDarkTheme && styles.settingRowDark]}>
          <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name={icon as keyof typeof Ionicons.glyphMap} size={22} />
          <View style={styles.chatRowBody}>
            <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>{title}</Text>
            <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>{copy}</Text>
          </View>
        </View>
      ))}
      <Pressable
        onPress={onSignOut}
        style={({ pressed }) => [
          styles.settingRow,
          styles.settingDangerRow,
          isDarkTheme && styles.settingRowDark,
          pressed && (isDarkTheme ? styles.rowPressedDark : styles.rowPressed),
        ]}
      >
        <Ionicons color={colors.danger} name="log-out-outline" size={22} />
        <View style={styles.chatRowBody}>
          <Text style={[styles.chatTitle, styles.settingDangerText]}>Log out</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>Remove this device session</Text>
        </View>
      </Pressable>
      </ScrollView>
    </View>
  );
}

function DesktopEmpty() {
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[styles.desktopEmpty, isDarkTheme && styles.desktopEmptyDark]}>
      <EmptyState icon="planet-outline" title="Orbita for web" copy="Select a conversation or create a new chat." />
    </View>
  );
}

function EmptyState({
  icon,
  title,
  copy,
  compact,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  copy: string;
  compact?: boolean;
}) {
  const { isDarkTheme, themeColors } = useAppTheme();
  return (
    <View style={[styles.emptyState, compact && styles.emptyCompact]}>
      <View style={[styles.emptyIcon, isDarkTheme && styles.emptyIconDark]}>
        <Ionicons color={isDarkTheme ? themeColors.accent : themeColors.primaryDark} name={icon} size={28} />
      </View>
      <Text style={[styles.emptyTitle, isDarkTheme && styles.emptyTitleDark]}>{title}</Text>
      <Text style={[styles.emptyCopy, isDarkTheme && styles.emptyCopyDark]}>{copy}</Text>
    </View>
  );
}

function NewChatModal({
  contacts,
  onClose,
  onContactAdded,
  onOpenConversation,
  visible,
}: {
  contacts: BackendProfile[];
  onClose: () => void;
  onContactAdded: () => Promise<void>;
  onOpenConversation: (otherUserId: string) => Promise<void>;
  visible: boolean;
}) {
  const { themeColors } = useAppTheme();
  const [phone, setPhone] = useState("");
  const [nickname, setNickname] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);

  async function addContact() {
    if (adding) return;
    setAdding(true);
    try {
      await messengerApi.addContactByPhone(phone, nickname.trim() || undefined);
      setPhone("");
      setNickname("");
      setNotice("Contact added.");
      await onContactAdded();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to add contact.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
          <Text style={styles.modalTitle}>New chat</Text>
          <View style={styles.newContactForm}>
            <TextInput
              keyboardType="phone-pad"
              onChangeText={setPhone}
              placeholder="+91 contact phone"
              placeholderTextColor={colors.faint}
              style={styles.modalInput}
              value={phone}
            />
            <TextInput
              onChangeText={setNickname}
              placeholder="Contact name"
              placeholderTextColor={colors.faint}
              style={styles.modalInput}
              value={nickname}
            />
            <Pressable
              disabled={adding || !phone.trim()}
              onPress={addContact}
              style={({ pressed }) => [
                styles.primaryButton,
                styles.fullWidthButton,
                pressed && styles.pressablePressed,
                (adding || !phone.trim()) && styles.buttonDisabled,
              ]}
            >
              {adding ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
              <Text style={styles.primaryText}>{adding ? "Adding..." : "Add contact"}</Text>
            </Pressable>
          </View>
          {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}
          <ScrollView contentContainerStyle={styles.newChatContactListContent} style={styles.newChatContactList}>
            {contacts.length ? contacts.map((contact) => (
              <Pressable
                key={contact.id}
                onPress={() => onOpenConversation(contact.id)}
                style={({ pressed }) => [styles.newChatContactRow, pressed && styles.rowPressed]}
              >
                <Avatar
                  avatarUrl={contact.avatarUrl}
                  isBot={contact.about?.trim().toLowerCase() === "task manager agent"}
                  name={contact.displayName}
                />
                <View style={styles.chatRowBody}>
                  <Text numberOfLines={1} style={styles.chatTitle}>{contact.displayName}</Text>
                  <Text numberOfLines={1} style={styles.chatPreview}>{contact.phone}</Text>
                </View>
                <Ionicons color={themeColors.primaryDark} name="chatbubble-outline" size={21} />
              </Pressable>
            )) : <EmptyState compact icon="person-add-outline" title="No contacts" copy="Add a registered phone number first." />}
          </ScrollView>
          <View style={styles.newChatActions}>
            <ModalActions onCancel={onClose} />
          </View>
    </KeyboardAwareModal>
  );
}

function SaveContactModal({
  onClose,
  onSave,
  peer,
  visible,
}: {
  onClose: () => void;
  onSave: (nickname: string) => Promise<void>;
  peer: UnsavedPeer | null;
  visible: boolean;
}) {
  const { themeColors } = useAppTheme();
  const [nickname, setNickname] = useState("");

  useEffect(() => {
    if (!peer) {
      setNickname("");
      return;
    }
    setNickname(/^\+?[\d\s().-]+$/.test(peer.defaultName) ? "" : peer.defaultName);
  }, [peer]);

  async function submit() {
    const nextNickname = nickname.trim();
    if (!nextNickname) return;
    await onSave(nextNickname);
    setNickname("");
  }

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
      <Text style={styles.modalTitle}>Save contact</Text>
      {peer ? (
        <View style={styles.saveContactPeer}>
          <View style={styles.attachmentMenuIcon}>
            <Ionicons color={themeColors.primaryDark} name="call-outline" size={20} />
          </View>
          <View style={styles.chatRowBody}>
            <Text style={styles.chatTitle}>Phone number</Text>
            <Text selectable style={styles.chatPreview}>{peer.phone}</Text>
          </View>
        </View>
      ) : null}
      <TextInput
        autoFocus={Platform.OS !== "web"}
        onChangeText={setNickname}
        placeholder="Contact name"
        placeholderTextColor={colors.faint}
        style={styles.modalInput}
        value={nickname}
      />
      <ModalActions disabled={!nickname.trim()} onCancel={onClose} onSubmit={submit} submitLabel="Save" />
    </KeyboardAwareModal>
  );
}

function KeyboardAwareModal({ children, onClose, visible }: { children: ReactNode; onClose: () => void; visible: boolean }) {
  const keyboardInset = useKeyboardClearance(visible);
  const { height } = useWindowDimensions();
  const keyboardOpen = keyboardInset > 0;
  const maxModalHeight = Math.max(260, height - keyboardInset - 36);

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View
        style={[
          styles.modalBackdrop,
          keyboardOpen && styles.modalBackdropKeyboardOpen,
          keyboardInset ? { paddingBottom: keyboardInset } : null,
        ]}
      >
        <View style={[styles.modalKeyboardFrame, { maxHeight: maxModalHeight }]}>
          <View style={[styles.modalCard, { maxHeight: maxModalHeight }]}>{children}</View>
        </View>
      </View>
    </Modal>
  );
}

function GroupModal({
  contacts,
  onClose,
  onCreate,
  visible,
}: {
  contacts: BackendProfile[];
  onClose: () => void;
  onCreate: (title: string, memberIds: string[]) => Promise<void>;
  visible: boolean;
}) {
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  async function submit() {
    if (!title.trim()) return;
    await onCreate(title.trim(), selected);
    setTitle("");
    setSelected([]);
  }

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
          <Text style={styles.modalTitle}>Create group</Text>
          <TextInput onChangeText={setTitle} placeholder="Group name" placeholderTextColor={colors.faint} style={styles.modalInput} value={title} />
          <ContactPicker contacts={contacts} selected={selected} toggle={toggle} />
          <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Create" disabled={!title.trim()} />
    </KeyboardAwareModal>
  );
}

function AddMembersModal({
  contacts,
  conversation,
  onClose,
  onSave,
  visible,
}: {
  contacts: BackendProfile[];
  conversation: BackendConversation | null;
  onClose: () => void;
  onSave: (memberIds: string[]) => Promise<void>;
  visible: boolean;
}) {
  const { themeColors } = useAppTheme();
  const [selected, setSelected] = useState<string[]>([]);
  const existing = new Set(conversation?.participants.map((participant) => participant.id) ?? []);
  const available = contacts.filter((contact) => !existing.has(contact.id));

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  async function submit() {
    await onSave(selected);
    setSelected([]);
  }

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
          <Text style={styles.modalTitle}>Add members</Text>
          <ContactPicker contacts={available} selected={selected} toggle={toggle} />
          <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Add" disabled={!selected.length} />
    </KeyboardAwareModal>
  );
}

function MembersListModal({
  currentUserId,
  members,
  onClose,
  onOpenMember,
  title,
  visible,
}: {
  currentUserId: string;
  members: Array<BackendProfile & { role?: "owner" | "admin" | "member" }>;
  onClose: () => void;
  onOpenMember: (memberId: string) => void | Promise<void>;
  title: string;
  visible: boolean;
}) {
  const { themeColors } = useAppTheme();
  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
      <Text style={styles.modalTitle}>{title}</Text>
      <Text style={styles.modalSubtitle}>
        {members.length} member{members.length === 1 ? "" : "s"}
      </Text>
      <ScrollView style={styles.modalList}>
        {members.length ? members.map((member) => {
          const isSelf = member.id === currentUserId;
          return (
            <Pressable
              key={member.id}
              disabled={isSelf}
              onPress={() => onOpenMember(member.id)}
              style={({ pressed }) => [
                styles.modalRow,
                pressed && styles.modalRowPressed,
                isSelf && styles.memberRowDisabled,
              ]}
            >
              <Avatar
                avatarUrl={member.avatarUrl}
                isBot={false}
                name={member.displayName}
              />
              <View style={styles.chatRowBody}>
                <Text style={styles.chatTitle}>{isSelf ? "You" : member.displayName}</Text>
                <Text style={styles.chatPreview}>
                  {[member.role ? member.role : "", member.phone ?? ""].filter(Boolean).join(" - ") || "Member"}
                </Text>
              </View>
              {isSelf ? (
                <Text style={styles.memberSelfTag}>You</Text>
              ) : (
                <Ionicons color={themeColors.primaryDark} name="chatbubble-outline" size={21} />
              )}
            </Pressable>
          );
        }) : <EmptyState compact icon="people-outline" title="No members" copy="No members are available for this chat." />}
      </ScrollView>
      <ModalActions onCancel={onClose} />
    </KeyboardAwareModal>
  );
}

function TaskThreadMembersModal({
  conversation,
  onClose,
  onSave,
  users,
  visible,
}: {
  conversation: BackendConversation | null;
  onClose: () => void;
  onSave: (userIds: string[]) => Promise<void>;
  users: TaskManagerAdminUser[];
  visible: boolean;
}) {
  const { themeColors } = useAppTheme();
  const [selected, setSelected] = useState<string[]>([]);
  const existingOrbitaProfileIds = new Set(conversation?.participants.map((participant) => participant.id) ?? []);
  const available = users.filter((user) => {
    const orbitaProfileId = user.channels?.orbita?.profile_id;
    return !orbitaProfileId || !existingOrbitaProfileIds.has(orbitaProfileId);
  });

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  async function submit() {
    await onSave(selected);
    setSelected([]);
  }

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
      <Text style={styles.modalTitle}>Add task members</Text>
      <ScrollView style={styles.modalList}>
        {available.length ? available.map((user) => {
          const linked = Boolean(user.channels?.orbita?.profile_id);
          return (
            <Pressable
              key={user._id}
              onPress={() => toggle(user._id)}
              style={({ pressed }) => [styles.modalRow, pressed && styles.modalRowPressed]}
            >
              <Avatar isBot={false} name={user.name} />
              <View style={styles.chatRowBody}>
                <Text style={styles.chatTitle}>{user.name}</Text>
                <Text style={styles.chatPreview}>{linked ? "Orbita linked" : "Pending until Orbita account is linked"}</Text>
              </View>
              <Ionicons
                color={selected.includes(user._id) ? themeColors.primaryDark : colors.faint}
                name={selected.includes(user._id) ? "checkbox" : "square-outline"}
                size={23}
              />
            </Pressable>
          );
        }) : <EmptyState compact icon="people-outline" title="No employees available" copy="All linked employees are already in this thread." />}
      </ScrollView>
      <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Add" disabled={!selected.length} />
    </KeyboardAwareModal>
  );
}

function CreateTaskThreadSubtaskModal({
  contacts,
  onClose,
  onCreate,
  parent,
  visible,
}: {
  contacts: BackendProfile[];
  onClose: () => void;
  onCreate: (input: {
    assigneeOrbitaUserId: string;
    title: string;
    description?: string;
    dueDate?: string | null;
    memberOrbitaUserIds?: string[];
  }) => Promise<void>;
  parent: BackendConversation | null;
  visible: boolean;
}) {
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueParts, setDueParts] = useState(defaultDueDateParts);
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) {
      setTitle("");
      setAssigneeId("");
      setDueParts(defaultDueDateParts());
      setDescription("");
      setMembers([]);
      return;
    }
    setAssigneeId((current) => current || contacts[0]?.id || "");
  }, [contacts, visible]);

  function toggleMember(id: string) {
    if (id === assigneeId) return;
    setMembers((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  async function submit() {
    if (!title.trim() || !assigneeId) return;
    await onCreate({
      assigneeOrbitaUserId: assigneeId,
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      dueDate: dueDatePartsToIso(dueParts.date, dueParts.time),
      memberOrbitaUserIds: members,
    });
  }

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
      <Text style={styles.modalTitle}>Create subtask</Text>
      <Text numberOfLines={2} style={styles.modalSubtitle}>
        Under {parent?.taskThread?.taskNumber ?? "task"} - {parent?.taskThread?.title ?? parent?.title ?? ""}
      </Text>
      <TextInput
        autoFocus={Platform.OS !== "web"}
        onChangeText={setTitle}
        placeholder="Subtask title"
        placeholderTextColor={colors.faint}
        style={styles.modalInput}
        value={title}
      />
      <Text style={styles.modalFieldLabel}>Assignee</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.assigneeChipRow}>
        {contacts.map((contact) => {
          const active = contact.id === assigneeId;
          return (
            <Pressable
              key={contact.id}
              onPress={() => {
                setAssigneeId(contact.id);
                setMembers((current) => current.filter((id) => id !== contact.id));
              }}
              style={({ pressed }) => [
                styles.assigneeChip,
                active && styles.assigneeChipActive,
                pressed && styles.pressablePressed,
              ]}
            >
              <Text style={[styles.assigneeChipText, active && styles.assigneeChipTextActive]}>{contact.displayName}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Text style={styles.modalFieldLabel}>Due date and time</Text>
      <View style={styles.dateTimeGrid}>
        <View style={styles.dateTimeInputWrap}>
          <Ionicons color={colors.muted} name="calendar-outline" size={17} />
          <TextInput
            {...(Platform.OS === "web" ? ({ type: "date" } as Record<string, unknown>) : {})}
            onChangeText={(date) => setDueParts((current) => ({ ...current, date }))}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.faint}
            style={styles.dateTimeInput}
            value={dueParts.date}
          />
        </View>
        <View style={styles.dateTimeInputWrap}>
          <Ionicons color={colors.muted} name="time-outline" size={17} />
          <TextInput
            onChangeText={(time) => setDueParts((current) => ({ ...current, time }))}
            placeholder="6:00 PM"
            placeholderTextColor={colors.faint}
            style={styles.dateTimeInput}
            value={dueParts.time}
          />
        </View>
      </View>
      <View style={styles.dateTimeQuickRow}>
        <Pressable
          onPress={() => setDueParts(defaultDueDateParts())}
          style={({ pressed }) => [styles.dateTimeChip, pressed && styles.pressablePressed]}
        >
          <Text style={styles.dateTimeChipText}>Today 6 PM</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(18, 0, 0, 0);
            const yyyy = String(tomorrow.getFullYear());
            const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
            const dd = String(tomorrow.getDate()).padStart(2, "0");
            setDueParts({ date: `${yyyy}-${mm}-${dd}`, time: "6:00 PM" });
          }}
          style={({ pressed }) => [styles.dateTimeChip, pressed && styles.pressablePressed]}
        >
          <Text style={styles.dateTimeChipText}>Tomorrow 6 PM</Text>
        </Pressable>
      </View>
      <TextInput
        multiline
        onChangeText={setDescription}
        placeholder="Description"
        placeholderTextColor={colors.faint}
        style={[styles.modalInput, styles.statusInput]}
        value={description}
      />
      <Text style={styles.modalFieldLabel}>Extra thread members</Text>
      <ContactPicker contacts={contacts.filter((contact) => contact.id !== assigneeId)} selected={members} toggle={toggleMember} />
      <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Create" disabled={!title.trim() || !assigneeId} />
    </KeyboardAwareModal>
  );
}

function ContactPicker({
  contacts,
  selected,
  toggle,
}: {
  contacts: BackendProfile[];
  selected: string[];
  toggle: (id: string) => void;
}) {
  const { themeColors } = useAppTheme();
  return (
    <ScrollView style={styles.modalList}>
      {contacts.length ? contacts.map((contact) => (
        <Pressable
          key={contact.id}
          onPress={() => toggle(contact.id)}
          style={({ pressed }) => [styles.modalRow, pressed && styles.modalRowPressed]}
        >
          <Avatar
            avatarUrl={contact.avatarUrl}
            isBot={contact.about?.trim().toLowerCase() === "task manager agent"}
            name={contact.displayName}
          />
          <View style={styles.chatRowBody}>
            <Text style={styles.chatTitle}>{contact.displayName}</Text>
            <Text style={styles.chatPreview}>{contact.phone}</Text>
          </View>
          <Ionicons color={selected.includes(contact.id) ? themeColors.primaryDark : colors.faint} name={selected.includes(contact.id) ? "checkbox" : "square-outline"} size={23} />
        </Pressable>
      )) : <EmptyState compact icon="people-outline" title="No contacts available" copy="Add contacts before selecting members." />}
    </ScrollView>
  );
}

function AttachmentMenuModal({
  onClose,
  onPickAudio,
  onPickDocument,
  onPickImage,
  visible,
}: {
  onClose: () => void;
  onPickAudio: () => void;
  onPickDocument: () => void;
  onPickImage: () => void;
  visible: boolean;
}) {
  const { themeColors } = useAppTheme();
  const actions: Array<{
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    subtitle: string;
    onPress: () => void;
  }> = [
    { icon: "image-outline", label: "Photo", subtitle: "Pick from your library", onPress: onPickImage },
    { icon: "headset-outline", label: "Audio", subtitle: "Send an audio file", onPress: onPickAudio },
    { icon: "document-text-outline", label: "Document", subtitle: "PDF, DOCX, XLSX, PPTX", onPress: onPickDocument },
  ];

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
      <Text style={styles.modalTitle}>Add attachment</Text>
      <View style={styles.attachmentMenuList}>
        {actions.map((action) => (
          <Pressable
            key={action.label}
            onPress={action.onPress}
            style={({ pressed }) => [styles.attachmentMenuRow, pressed && styles.rowPressed]}
          >
            <View style={styles.attachmentMenuIcon}>
              <Ionicons color={themeColors.primaryDark} name={action.icon} size={20} />
            </View>
            <View style={styles.chatRowBody}>
              <Text style={styles.chatTitle}>{action.label}</Text>
              <Text style={styles.chatPreview}>{action.subtitle}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <ModalActions onCancel={onClose} />
    </KeyboardAwareModal>
  );
}

function MessageActionsModal({
  anchor,
  message,
  onClose,
  onReply,
  visible,
}: {
  anchor?: MessageActionAnchor;
  message: ChatMessage | null;
  onClose: () => void;
  onReply: (message: ChatMessage) => void;
  visible: boolean;
}) {
  const { isDarkTheme } = useAppTheme();
  const { height, width } = useWindowDimensions();
  const menuWidth = Math.min(MESSAGE_ACTION_MENU_WIDTH, Math.max(144, width - 32));
  const menuHeight = MESSAGE_ACTION_MENU_HEIGHT;
  const viewportMargin = 10;
  const top = anchor
    ? clamp(
        anchor.y + anchor.height + menuHeight + MESSAGE_ACTION_MENU_GAP > height - viewportMargin
          ? anchor.y - menuHeight - MESSAGE_ACTION_MENU_GAP
          : anchor.y + anchor.height + MESSAGE_ACTION_MENU_GAP,
        viewportMargin,
        Math.max(viewportMargin, height - menuHeight - viewportMargin),
      )
    : Math.max(viewportMargin, height - menuHeight - 28);
  const anchoredLeft = anchor
    ? anchor.mine
      ? anchor.x + anchor.width - menuWidth
      : anchor.x
    : (width - menuWidth) / 2;
  const left = clamp(
    anchoredLeft,
    viewportMargin,
    Math.max(viewportMargin, width - menuWidth - viewportMargin),
  );
  const copyMessage = () => {
    if (!message?.body) return;
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(message.body).catch(() => undefined);
    }
    onClose();
  };
  const actions: Array<{
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    onPress: () => void;
  }> = [
    { icon: "return-up-back-outline", label: "Reply", onPress: () => message && onReply(message) },
    { icon: "copy-outline", label: "Copy", onPress: copyMessage },
  ];
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable onPress={onClose} style={styles.messageActionsBackdrop}>
        <Pressable
          onPress={(event) => event.stopPropagation()}
          style={[
            styles.messageActionsSheet,
            isDarkTheme && styles.messageActionsSheetDark,
            { left, top, width: menuWidth },
          ]}
        >
          {actions.map((action) => (
            <Pressable
              disabled={!message}
              key={action.label}
              onPress={action.onPress}
              style={({ pressed }) => [styles.messageActionRow, pressed && styles.messageActionRowPressed]}
            >
              <Ionicons
                color={isDarkTheme ? "rgba(233,237,239,0.92)" : colors.ink}
                name={action.icon}
                size={19}
              />
              <Text style={[styles.messageActionText, isDarkTheme && styles.messageActionTextDark]}>{action.label}</Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ForwardPickerModal({
  message,
  onClose,
  onSubmit,
  targets,
  visible,
}: {
  message: ChatMessage | null;
  onClose: () => void;
  onSubmit: (targets: ForwardTarget[]) => Promise<void>;
  targets: ForwardTarget[];
  visible: boolean;
}) {
  const { themeColors } = useAppTheme();
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) setSelectedTargetIds([]);
  }, [visible]);

  const selectedTargets = targets.filter((target) => selectedTargetIds.includes(target.id));

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
      <Text style={styles.modalTitle}>Forward message</Text>
      {message ? (
        <View style={styles.forwardPreviewCard}>
          <Text numberOfLines={2} style={styles.chatPreview}>
            {messagePreviewText(message)}
          </Text>
        </View>
      ) : null}
      <ScrollView style={styles.modalList}>
        {targets.length ? targets.map((target) => {
          const selected = selectedTargetIds.includes(target.id);
          return (
            <Pressable
              key={`${target.type}-${target.id}`}
              onPress={() =>
                setSelectedTargetIds((current) =>
                  selected ? current.filter((item) => item !== target.id) : [...current, target.id],
                )
              }
              style={({ pressed }) => [styles.modalRow, pressed && styles.modalRowPressed]}
            >
              <Avatar avatarUrl={target.avatarUrl} isBot={Boolean(target.isBot)} name={target.title} />
              <View style={styles.chatRowBody}>
                <Text style={styles.chatTitle}>{target.title}</Text>
                <Text style={styles.chatPreview}>{target.subtitle}</Text>
              </View>
              <Ionicons
                color={selected ? themeColors.primaryDark : colors.faint}
                name={selected ? "checkbox" : "square-outline"}
                size={23}
              />
            </Pressable>
          );
        }) : <EmptyState compact icon="arrow-redo-outline" title="No destinations available" copy="Add more chats or contacts first." />}
      </ScrollView>
      <ModalActions
        disabled={!selectedTargets.length}
        onCancel={onClose}
        onSubmit={() => onSubmit(selectedTargets)}
        submitLabel="Forward"
      />
    </KeyboardAwareModal>
  );
}

function StatusModal({
  onClose,
  onCreate,
  visible,
}: {
  onClose: () => void;
  onCreate: (text: string) => Promise<void>;
  visible: boolean;
}) {
  const [text, setText] = useState("");

  async function submit() {
    if (!text.trim()) return;
    await onCreate(text.trim());
    setText("");
  }

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
          <Text style={styles.modalTitle}>New status</Text>
          <TextInput multiline onChangeText={setText} placeholder="Share a quick update" placeholderTextColor={colors.faint} style={[styles.modalInput, styles.statusInput]} value={text} />
          <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Post" disabled={!text.trim()} />
    </KeyboardAwareModal>
  );
}

function ProfileModal({
  onClose,
  onSave,
  profile,
  visible,
}: {
  onClose: () => void;
  onSave: (displayName: string, about: string) => Promise<void>;
  profile: BackendProfile;
  visible: boolean;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [about, setAbout] = useState(profile.about);

  useEffect(() => {
    setDisplayName(profile.displayName);
    setAbout(profile.about);
  }, [profile]);

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
          <Text style={styles.modalTitle}>Profile</Text>
          <TextInput onChangeText={setDisplayName} placeholder="Display name" placeholderTextColor={colors.faint} style={styles.modalInput} value={displayName} />
          <TextInput onChangeText={setAbout} placeholder="About" placeholderTextColor={colors.faint} style={styles.modalInput} value={about} />
          <ModalActions onCancel={onClose} onSubmit={() => onSave(displayName, about)} submitLabel="Save" disabled={!displayName.trim()} />
    </KeyboardAwareModal>
  );
}

function ModalActions({
  disabled,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  disabled?: boolean;
  onCancel: () => void;
  onSubmit?: () => void | Promise<void>;
  submitLabel?: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);
  const blocked = Boolean(disabled || submitting);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function submit() {
    if (blocked || !onSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit();
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <View style={styles.modalActions}>
      <Pressable
        disabled={submitting}
        onPress={onCancel}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressablePressed, submitting && styles.buttonDisabled]}
      >
        <Text style={styles.secondaryText}>Cancel</Text>
      </Pressable>
      {onSubmit ? (
        <Pressable
          disabled={blocked}
          onPress={submit}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressablePressed, blocked && styles.buttonDisabled]}
        >
          {submitting ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
          <Text style={styles.primaryText}>{submitting ? `${submitLabel ?? "Save"}...` : submitLabel ?? "Save"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.page },
  safeDark: { backgroundColor: "#111B21" },
  loadingScreen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  loadingScreenDark: { backgroundColor: "#111B21" },
  loadingLabel: { color: colors.muted, fontSize: 14, fontWeight: "700" },
  loadingLabelDark: { color: "rgba(255,255,255,0.70)" },
  pressablePressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  rowPressed: {
    backgroundColor: "rgba(0,168,132,0.14)",
    borderColor: "rgba(0,168,132,0.32)",
  },
  rowPressedDark: {
    backgroundColor: "rgba(6,207,156,0.16)",
    borderColor: "rgba(6,207,156,0.34)",
  },
  bottomTabPressed: { backgroundColor: "rgba(0,168,132,0.10)", transform: [{ scale: 0.98 }] },
  modalRowPressed: { backgroundColor: "rgba(0,168,132,0.10)" },
  bubblePressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
  inlineIconHit: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  logoFrame: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111B21",
    borderWidth: 1,
    borderColor: "rgba(6,207,156,0.38)",
    shadowColor: "#53BDEB",
    shadowOpacity: 0.26,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  logoCore: {
    position: "absolute",
    backgroundColor: "rgba(0,168,132,0.72)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  logoNode: { position: "absolute", backgroundColor: colors.accent },
  logoNodeTop: { top: "17%", right: "24%" },
  logoNodeLeft: { left: "20%", bottom: "24%", backgroundColor: "#53BDEB" },
  logoNodeRight: { right: "18%", bottom: "20%", backgroundColor: "#FFFFFF" },
  logoSignal: {
    position: "absolute",
    height: 2,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.42)",
  },
  logoScan: {
    position: "absolute",
    width: 9,
    borderRadius: 999,
    backgroundColor: "rgba(6,207,156,0.55)",
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  brandTitle: { color: colors.ink, fontSize: 25, fontWeight: "700" },
  brandTitleCompact: { fontSize: 21 },
  brandTagline: { color: colors.muted, fontSize: 12, fontWeight: "700", marginTop: 1 },
  brandTitleInverse: { color: "#FFFFFF" },
  brandTaglineInverse: { color: "rgba(255,255,255,0.68)" },
  loadingErrorScreen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 },
  loginKeyboard: { flex: 1 },
  loginScroll: { flexGrow: 1 },
  loginScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Platform.select({ web: 48, default: 22 }),
    paddingVertical: Platform.select({ web: 42, default: 22 }),
    backgroundColor: "#111B21",
    overflow: "hidden",
  },
  loginScreenLight: { backgroundColor: "#F0F2F5" },
  loginBackdropGrid: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.22,
    backgroundColor: "#111B21",
  },
  loginBackdropGridLight: { opacity: 1, backgroundColor: "#F0F2F5" },
  loginGlow: {
    position: "absolute",
    width: 330,
    height: 330,
    right: -128,
    top: -72,
    borderRadius: 165,
    backgroundColor: "rgba(85,214,255,0.16)",
  },
  loginGlowLight: { backgroundColor: "rgba(0,168,132,0.14)" },
  authSignalScene: {
    position: "absolute",
    top: 36,
    right: 14,
    width: 190,
    height: 190,
    opacity: 0.92,
  },
  authSignalSceneInline: {
    position: "relative",
    top: 0,
    right: 0,
    width: 286,
    height: 286,
    opacity: 1,
    zIndex: 2,
  },
  authSignalCore: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 34,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.04)",
    overflow: "hidden",
  },
  authSignalCoreLight: {
    borderColor: "rgba(0,128,105,0.14)",
    backgroundColor: "rgba(255,255,255,0.74)",
  },
  authScanLine: {
    position: "absolute",
    left: 18,
    right: 18,
    height: 2,
    borderRadius: 999,
    backgroundColor: "rgba(6,207,156,0.62)",
  },
  authScanLineLight: { backgroundColor: "rgba(0,128,105,0.34)" },
  authNode: {
    position: "absolute",
    width: 9,
    height: 9,
    borderRadius: 999,
    backgroundColor: "#53BDEB",
  },
  authNodeLight: { backgroundColor: "#008069" },
  authNodeOne: { left: 26, top: 38 },
  authNodeTwo: { right: 32, top: 60, backgroundColor: colors.accent },
  authNodeTwoLight: { backgroundColor: "#53BDEB" },
  authNodeThree: { left: 44, bottom: 38, backgroundColor: "#FFFFFF" },
  authNodeThreeLight: { backgroundColor: colors.primaryDark },
  authTrace: {
    position: "absolute",
    height: 1,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  authTraceLight: { backgroundColor: "rgba(0,128,105,0.18)" },
  authTraceOne: { width: 112, top: 44, left: 34, transform: [{ rotate: "10deg" }] },
  authTraceTwo: { width: 104, top: 82, right: 34, transform: [{ rotate: "-18deg" }] },
  authTraceThree: { width: 92, bottom: 52, left: 50, transform: [{ rotate: "-8deg" }] },
  loginHero: {
    width: "100%",
    maxWidth: 460,
    gap: 12,
  },
  loginContent: {
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
    zIndex: 1,
  },
  loginContentWide: {
    maxWidth: 1120,
    minHeight: 560,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 72,
  },
  loginAuthColumn: {
    width: "100%",
    maxWidth: 460,
  },
  loginAuthColumnWide: {
    flex: 1,
    maxWidth: 500,
    justifyContent: "center",
  },
  loginTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14 },
  authThemeButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  authThemeButtonLight: {
    borderColor: "rgba(0,128,105,0.14)",
    backgroundColor: "rgba(255,255,255,0.78)",
  },
  loginBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 18,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  loginBadgeLight: {
    backgroundColor: "rgba(255,255,255,0.82)",
    borderColor: "rgba(0,128,105,0.16)",
  },
  loginBadgeText: { color: "rgba(255,255,255,0.82)", fontSize: 12, fontWeight: "600" },
  loginBadgeTextLight: { color: colors.primaryDark },
  loginTitle: {
    color: "#FFFFFF",
    fontSize: 38,
    lineHeight: 43,
    fontWeight: "700",
    maxWidth: 420,
  },
  loginTitleWide: { fontSize: 44, lineHeight: 50, maxWidth: 500 },
  loginTitleLight: { color: colors.ink },
  loginCopy: { color: "rgba(255,255,255,0.70)", fontSize: 15, lineHeight: 22, maxWidth: 420 },
  loginCopyWide: { maxWidth: 460 },
  loginCopyLight: { color: colors.muted },
  loginForm: {
    marginTop: 22,
    gap: 12,
    width: "100%",
    maxWidth: 460,
    padding: 16,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  loginFormWide: {
    marginTop: 28,
    maxWidth: 500,
    padding: 18,
  },
  loginFormLight: {
    borderColor: "rgba(0,128,105,0.14)",
    backgroundColor: "rgba(255,255,255,0.88)",
    shadowColor: "#008069",
    shadowOpacity: 0.10,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  authVisualPanel: {
    flex: 1,
    maxWidth: 470,
    minHeight: 490,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 34,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.045)",
    overflow: "hidden",
  },
  authVisualPanelLight: {
    borderColor: "rgba(0,128,105,0.14)",
    backgroundColor: "rgba(255,255,255,0.62)",
  },
  authVisualHalo: {
    position: "absolute",
    width: 390,
    height: 390,
    borderRadius: 195,
    backgroundColor: "rgba(85,214,255,0.12)",
  },
  authVisualHaloLight: { backgroundColor: "rgba(0,168,132,0.10)" },
  authVisualRail: {
    position: "absolute",
    height: 2,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.20)",
  },
  authVisualRailLight: { backgroundColor: "rgba(0,128,105,0.18)" },
  authVisualRailTop: { width: 260, top: 106, right: 44, transform: [{ rotate: "7deg" }] },
  authVisualRailMiddle: { width: 330, top: 246, left: 54, transform: [{ rotate: "-4deg" }] },
  authVisualRailBottom: { width: 230, bottom: 106, right: 74, transform: [{ rotate: "-11deg" }] },
  authModeSwitch: {
    minHeight: 46,
    flexDirection: "row",
    padding: 4,
    gap: 4,
    borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  authModeSwitchLight: { backgroundColor: "#E9EDEF" },
  authModeButton: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 12 },
  authModeButtonActive: { backgroundColor: "#FFFFFF" },
  authModeButtonActiveLight: { backgroundColor: colors.primaryDark },
  authModeText: { color: "rgba(255,255,255,0.62)", fontSize: 14, fontWeight: "700" },
  authModeTextLight: { color: colors.muted },
  authModeTextActive: { color: colors.ink },
  authModeTextActiveLight: { color: "#FFFFFF" },
  inputShell: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    paddingHorizontal: 14,
    backgroundColor: "rgba(11,20,26,0.64)",
  },
  inputShellLight: {
    borderColor: "rgba(0,128,105,0.14)",
    backgroundColor: "#F0F2F5",
  },
  loginInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  loginInputLight: { color: colors.ink },
  otpInput: { letterSpacing: 4 },
  otpActionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  textActionButton: { minHeight: 34, justifyContent: "center" },
  textAction: { color: colors.accent, fontSize: 13, fontWeight: "700" },
  textActionLight: { color: colors.primaryDark },
  textActionDisabled: { color: "rgba(255,255,255,0.38)" },
  textActionDisabledLight: { color: colors.faint },
  loginButton: {
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: "#00A884",
  },
  loginButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  buttonDisabled: { opacity: 0.55 },
  loginNoticeText: { color: colors.accent, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  loginNoticeTextLight: { color: colors.primaryDark },
  loginHintText: { color: "rgba(255,255,255,0.58)", fontSize: 12, lineHeight: 18 },
  loginHintTextLight: { color: colors.muted },
  loginLegalRow: {
    maxWidth: 520,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  loginLegalText: { color: "rgba(255,255,255,0.58)", fontSize: 12, lineHeight: 18, textAlign: "center" },
  loginLegalTextLight: { color: colors.muted },
  loginLegalLinkButton: { borderRadius: 6 },
  loginLegalLink: { color: colors.accent, fontSize: 12, fontWeight: "800", lineHeight: 18 },
  loginLegalLinkLight: { color: colors.primaryDark },
  noticeText: { color: colors.primaryDark, fontSize: 13, fontWeight: "700" },
  hintText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  appFrame: { flex: 1, flexDirection: "row", backgroundColor: colors.page },
  appFrameDark: { backgroundColor: "#111B21" },
  sidebar: {
    width: Platform.select({ web: 104, default: 82 }),
    backgroundColor: colors.primaryDark,
    borderRightColor: "rgba(255,255,255,0.16)",
    borderRightWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 18,
    alignItems: "center",
    gap: 18,
  },
  sidebarDark: { backgroundColor: "#111B21", borderRightColor: "rgba(255,255,255,0.10)" },
  brandMark: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
    ...shadow,
  },
  navStack: { flex: 1, width: "100%", gap: 8 },
  navItem: { minHeight: 62, alignItems: "center", justifyContent: "center", borderRadius: radii.md, gap: 4 },
  navItemActive: { backgroundColor: colors.accentSoft, borderColor: "rgba(255,255,255,0.42)", borderWidth: 1 },
  navLabel: { color: "rgba(255,255,255,0.76)", fontSize: 11, fontWeight: "700" },
  navLabelActive: { color: colors.primaryDark },
  composeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  workspace: { flex: 1, minWidth: 0 },
  workspaceDark: { backgroundColor: "#111B21" },
  header: {
    minHeight: 74,
    paddingHorizontal: 18,
    paddingVertical: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  headerDark: { borderBottomColor: "rgba(255,255,255,0.10)", backgroundColor: "#202C33" },
  headerMobile: { minHeight: 62, paddingHorizontal: 16 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  errorBar: { color: colors.danger, backgroundColor: "#FFF3F3", paddingHorizontal: 14, paddingVertical: 8 },
  content: { flex: 1, flexDirection: "row", padding: 18, gap: 18 },
  contentDark: { backgroundColor: "#111B21" },
  contentMobile: { padding: 0, paddingBottom: 72, backgroundColor: colors.page },
  contentMobileDark: { backgroundColor: "#111B21" },
  contentMobileChat: { paddingBottom: 0, flexDirection: "column", gap: 0, width: "100%" },
  listPanel: {
    width: Platform.select({ web: 390, default: 330 }),
    maxWidth: "100%",
    borderRadius: radii.lg,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.surface,
    overflow: "hidden",
    ...shadow,
  },
  listPanelDark: {
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "#202C33",
    shadowColor: "#000000",
    shadowOpacity: 0.25,
  },
  adminPanel: { flexShrink: 0 },
  adminPanelWide: { flex: 1, width: "100%", maxWidth: "100%" },
  mobilePanel: { flex: 1, width: "100%", borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0, borderTopWidth: 0 },
  panelTitle: {
    minHeight: 58,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.primaryDark,
  },
  panelTitleDark: { backgroundColor: "#202C33", borderBottomColor: "rgba(6,207,156,0.12)", borderBottomWidth: 1 },
  panelHeading: { color: "#FFFFFF", fontSize: 22, fontWeight: "700", letterSpacing: 0.2 },
  chatSearchHeader: {
    minHeight: 70,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    backgroundColor: colors.surface,
  },
  chatSearchHeaderDark: { backgroundColor: "#202C33", borderBottomColor: "rgba(6,207,156,0.12)" },
  searchBox: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.page,
  },
  searchBoxDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  searchInput: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 14, paddingVertical: 8 },
  searchInputDark: { color: "#FFFFFF" },
  searchAddButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.14)",
  },
  searchAddButtonDark: { backgroundColor: "rgba(6,207,156,0.12)", borderColor: "rgba(6,207,156,0.20)" },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.12)",
  },
  iconButtonDark: { backgroundColor: "rgba(255,255,255,0.10)", borderColor: "rgba(255,255,255,0.12)" },
  bottomTabs: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 58,
    paddingTop: 5,
    paddingHorizontal: 6,
    flexDirection: "row",
    justifyContent: "space-around",
    borderTopColor: colors.line,
    borderTopWidth: 1,
    backgroundColor: colors.surface,
  },
  bottomTabsDark: { borderTopColor: "rgba(255,255,255,0.10)", backgroundColor: "#202C33" },
  bottomTab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2, borderRadius: 16 },
  bottomTabLabel: { color: colors.muted, fontSize: 10, fontWeight: "600" },
  bottomTabLabelDark: { color: "rgba(255,255,255,0.58)" },
  bottomTabLabelActive: { color: colors.primaryDark },
  bottomTabLabelActiveDark: { color: colors.accent },
  listContent: { padding: 12, gap: 10 },
  listContentDark: { backgroundColor: "#202C33" },
  adminHeader: {
    minHeight: 76,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  adminHeaderDark: { borderBottomColor: "rgba(255,255,255,0.10)", backgroundColor: "#202C33" },
  adminEyebrow: { color: colors.muted, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  adminMutedText: { color: "rgba(255,255,255,0.58)" },
  adminTitle: { color: colors.ink, fontSize: 20, fontWeight: "700" },
  adminContent: { padding: 12, gap: 12 },
  adminContentWide: { padding: 18, maxWidth: 1180, width: "100%", alignSelf: "flex-start" },
  adminSectionTabs: { gap: 8, paddingRight: 12 },
  adminSectionTab: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  adminSectionTabDark: { borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.06)" },
  adminSectionTabActive: { borderColor: colors.primaryDark, backgroundColor: colors.primaryDark },
  adminSectionTabText: { color: colors.primaryDark, fontSize: 12, fontWeight: "700" },
  adminSectionTabTextActive: { color: "#FFFFFF" },
  adminSectionTabCount: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  adminMetricGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  adminMetricCard: {
    flexGrow: 1,
    flexBasis: 116,
    minHeight: 82,
    justifyContent: "center",
    gap: 6,
    padding: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  adminMetricLabel: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  adminMetricValue: { color: colors.primaryDark, fontSize: 24, fontWeight: "700" },
  adminSection: {
    gap: 10,
    padding: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  adminSectionDark: { borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.06)" },
  adminSectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  adminSectionTitle: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  adminOverviewGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  adminCompactStat: {
    flexGrow: 1,
    flexBasis: 92,
    minHeight: 66,
    justifyContent: "center",
    gap: 3,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.page,
  },
  adminFormRow: { gap: 10 },
  adminInput: {
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 12,
    color: colors.ink,
    fontSize: 14,
    fontWeight: "700",
    backgroundColor: colors.page,
  },
  roleToggle: {
    minHeight: 42,
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: 14,
    backgroundColor: colors.page,
  },
  roleToggleButton: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  roleToggleButtonActive: { backgroundColor: colors.primaryDark },
  roleToggleText: { color: colors.muted, fontSize: 13, fontWeight: "700", textTransform: "capitalize" },
  roleToggleTextActive: { color: "#FFFFFF" },
  adminPrimaryButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    backgroundColor: colors.primaryDark,
  },
  adminPrimaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  adminListRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.12)",
    backgroundColor: "rgba(255,255,255,0.62)",
  },
  adminListRowDark: {
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  adminListRowActive: { borderColor: "rgba(0,128,105,0.36)", backgroundColor: colors.accentSoft },
  adminListRowActiveDark: { borderColor: "rgba(6,207,156,0.32)", backgroundColor: "rgba(6,207,156,0.12)" },
  adminRowTitle: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  adminRowMeta: { color: colors.muted, fontSize: 12, fontWeight: "700", marginTop: 2 },
  adminTaskRow: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,168,132,0.10)",
  },
  adminTaskRowCompact: { minHeight: 46, paddingVertical: 6 },
  adminTaskText: { flex: 1, minWidth: 0 },
  adminTaskMetaLine: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 },
  adminTaskButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  adminTaskButtonDone: { backgroundColor: colors.accent },
  adminTaskButtonDisabled: { opacity: 0.58 },
  adminStatusPill: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  adminStatusOpen: { borderColor: "rgba(59,130,246,0.28)", backgroundColor: "rgba(59,130,246,0.12)" },
  adminStatusProgress: { borderColor: "rgba(245,158,11,0.30)", backgroundColor: "rgba(245,158,11,0.14)" },
  adminStatusDone: { borderColor: "rgba(16,185,129,0.32)", backgroundColor: "rgba(16,185,129,0.16)" },
  adminStatusDiscarded: { borderColor: "rgba(239,68,68,0.30)", backgroundColor: "rgba(239,68,68,0.12)" },
  adminStatusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#3B82F6",
  },
  adminStatusDotDone: { alignItems: "center", justifyContent: "center", borderColor: "#10B981", backgroundColor: "#10B981" },
  adminStatusText: { color: colors.muted, fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  adminStatusTextDone: { color: "#047857" },
  adminFilterCard: {
    gap: 10,
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.12)",
    backgroundColor: "rgba(255,255,255,0.58)",
  },
  adminFilterCardDark: {
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  adminFilterTrigger: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  adminFilterMenu: { gap: 8 },
  adminFilterOption: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.10)",
    backgroundColor: "rgba(255,255,255,0.34)",
  },
  adminFilterOptionDark: {
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  adminFilterOptionActive: { borderColor: "rgba(0,128,105,0.34)", backgroundColor: colors.accentSoft },
  adminFilterOptionActiveDark: {
    borderColor: "rgba(6,207,156,0.34)",
    backgroundColor: "rgba(6,207,156,0.12)",
  },
  adminChatRow: {
    gap: 3,
    padding: 10,
    borderRadius: 12,
    backgroundColor: "rgba(0,168,132,0.08)",
  },
  adminChatRowDark: { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 1 },
  adminDepartmentList: { gap: 10 },
  adminDepartmentCard: {
    gap: 8,
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.12)",
    backgroundColor: "rgba(255,255,255,0.54)",
  },
  adminDepartmentTrigger: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  adminDepartmentMembersInline: { gap: 8, paddingTop: 4 },
  adminDepartmentMembers: {
    gap: 10,
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.12)",
    backgroundColor: "rgba(255,255,255,0.48)",
  },
  listFooterText: { color: colors.muted, fontSize: 12, fontWeight: "700", textAlign: "center", paddingVertical: 8 },
  listFooterTextDark: { color: "rgba(255,255,255,0.52)" },
  skeletonBlock: { backgroundColor: "#DADDE0" },
  skeletonBlockDark: { backgroundColor: "rgba(255,255,255,0.16)" },
  skeletonLogo: { width: 48, height: 48, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.35)" },
  skeletonBrand: { width: 116, height: 22, borderRadius: 8 },
  skeletonPanelHeading: { width: 138, height: 38, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.36)" },
  skeletonIconButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.36)" },
  skeletonAvatar: { width: 46, height: 46, borderRadius: 23 },
  skeletonAvatarLarge: { width: 54, height: 54, borderRadius: 27 },
  skeletonAvatarXL: { width: 64, height: 64, borderRadius: 32 },
  skeletonIcon: { width: 22, height: 22, borderRadius: 8 },
  skeletonTitle: { width: 118, height: 16, borderRadius: 7 },
  skeletonTitleWide: { width: 156, height: 20, borderRadius: 8 },
  skeletonTime: { width: 54, height: 12, borderRadius: 6 },
  skeletonUnreadBadge: { width: 22, height: 22, borderRadius: 11 },
  skeletonLine: { height: 13, borderRadius: 7, marginTop: 9 },
  skeletonLineLong: { width: "82%" },
  skeletonLineMid: { width: "62%" },
  skeletonLineShort: { width: "42%" },
  skeletonStatusText: { width: "88%", height: 56, borderRadius: 12 },
  skeletonBubble: { gap: 9, padding: 12, borderRadius: 16 },
  skeletonBubbleIncoming: { backgroundColor: "rgba(255,255,255,0.82)", borderTopLeftRadius: 4 },
  skeletonBubbleOutgoing: { alignSelf: "flex-end", backgroundColor: "rgba(0,128,105,0.30)", borderTopRightRadius: 4 },
  skeletonBubbleIncomingDark: { backgroundColor: "#202C33", borderColor: "rgba(255,255,255,0.08)", borderWidth: 1 },
  skeletonBubbleOutgoingDark: { backgroundColor: "rgba(0,168,132,0.44)" },
  skeletonMessageLineWide: { width: 210, maxWidth: "100%", height: 14, borderRadius: 7 },
  skeletonMessageLineMid: { width: 154, maxWidth: "85%", height: 14, borderRadius: 7 },
  skeletonMessageLineShort: { width: 92, maxWidth: "60%", height: 14, borderRadius: 7 },
  skeletonMedia: { width: 150, height: 92, borderRadius: 12, marginTop: 2 },
  chatRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.12)",
    backgroundColor: "rgba(255,255,255,0.84)",
  },
  chatRowDark: { borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.06)" },
  chatRowActive: { backgroundColor: colors.accentSoft, borderColor: "rgba(0,168,132,0.20)" },
  chatRowActiveDark: { backgroundColor: "rgba(6,207,156,0.12)", borderColor: "rgba(6,207,156,0.26)" },
  taskThreadRowFrame: { position: "relative", zIndex: 1 },
  taskThreadRowFrameOpen: { zIndex: 30 },
  taskThreadRow: {
    minHeight: 62,
    gap: 8,
    paddingVertical: 9,
    borderStyle: "solid",
    backgroundColor: "rgba(255,255,255,0.58)",
  },
  taskThreadRowArchived: {
    minHeight: 54,
    opacity: 0.88,
    backgroundColor: "rgba(255,255,255,0.34)",
  },
  taskThreadRowArchivedDark: {
    borderColor: "rgba(255,255,255,0.065)",
    backgroundColor: "rgba(255,255,255,0.035)",
  },
  completedTaskSectionRow: {
    minHeight: 32,
    marginLeft: 0,
    marginRight: 0,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "transparent",
  },
  completedTaskSectionRowDark: {
    backgroundColor: "transparent",
  },
  completedTaskSectionIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,168,132,0.10)",
  },
  completedTaskSectionLine: {
    flex: 1,
    height: 1,
    backgroundColor: "rgba(0,128,105,0.16)",
  },
  completedTaskSectionLineDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  completedTaskSectionTitle: { color: colors.muted, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  completedTaskSectionTitleDark: { color: "rgba(233,237,239,0.56)" },
  completedTaskSectionCount: {
    minWidth: 22,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    textAlign: "center",
    color: colors.primaryDark,
    fontSize: 11,
    fontWeight: "800",
    backgroundColor: "rgba(0,168,132,0.10)",
    overflow: "hidden",
  },
  completedTaskSectionCountDark: {
    color: colors.accent,
    backgroundColor: "rgba(6,207,156,0.08)",
  },
  taskThreadRail: {
    width: 3,
    height: 34,
    borderRadius: 2,
    backgroundColor: "rgba(0,168,132,0.34)",
    flexShrink: 0,
  },
  taskThreadRailDark: { backgroundColor: "rgba(6,207,156,0.40)" },
  taskThreadRailArchived: { backgroundColor: "rgba(134,150,160,0.45)" },
  taskThreadChevron: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  taskThreadChevronSpacer: { width: 28, height: 28, flexShrink: 0 },
  taskNumberPill: {
    minWidth: 70,
    maxWidth: 98,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 9,
    backgroundColor: "rgba(0,168,132,0.12)",
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.20)",
    flexShrink: 0,
  },
  taskNumberPillDark: {
    backgroundColor: "rgba(6,207,156,0.10)",
    borderColor: "rgba(6,207,156,0.20)",
  },
  taskNumberPillArchived: {
    backgroundColor: "rgba(134,150,160,0.10)",
    borderColor: "rgba(134,150,160,0.22)",
  },
  taskNumberText: { color: colors.primaryDark, fontSize: 11, fontWeight: "800" },
  taskNumberTextDark: { color: colors.accent },
  taskNumberTextArchived: { color: colors.faint },
  taskThreadTitleRow: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0 },
  taskThreadTitle: { fontSize: 14 },
  taskThreadTitleArchived: { color: colors.faint },
  taskThreadMetaActions: { alignItems: "flex-end", gap: 6 },
  taskActionDots: {
    width: 28,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,168,132,0.08)",
  },
  taskActionDotsArchived: { backgroundColor: "rgba(134,150,160,0.10)" },
  taskActionDotsActive: { backgroundColor: "rgba(0,168,132,0.18)" },
  taskStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#F59E0B",
    flexShrink: 0,
  },
  taskStatusDotProgress: { backgroundColor: "#00A884" },
  taskStatusDotDone: { backgroundColor: "#10B981" },
  taskStatusDotClosed: { backgroundColor: "#8696A0" },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.surface,
  },
  contactRowDark: { borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.06)" },
  avatarWrap: { alignItems: "center", justifyContent: "center" },
  botAvatarPulse: {
    position: "absolute",
    borderWidth: 2,
    borderColor: "rgba(0,128,105,0.38)",
    backgroundColor: "rgba(0,128,105,0.08)",
  },
  botAvatarRing: {
    position: "absolute",
    borderWidth: 1.5,
    borderColor: "rgba(6,207,156,0.75)",
    backgroundColor: "transparent",
  },
  avatar: { alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  botAvatarFace: {
    width: "80%",
    height: "80%",
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F0F2F5",
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.22)",
    position: "relative",
    gap: 4,
  },
  botAvatarEyeRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  botAvatarEye: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.primaryDark,
  },
  botAvatarMouth: {
    width: 14,
    height: 3,
    borderRadius: 3,
    backgroundColor: "rgba(0,128,105,0.72)",
  },
  botAvatarChip: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.28)",
  },
  avatarImage: { resizeMode: "cover" },
  avatarText: { color: "#FFFFFF", fontWeight: "700" },
  chatRowBody: { flex: 1, minWidth: 0 },
  chatListRowBody: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  chatListTextColumn: { flex: 1, minWidth: 0 },
  chatListMetaColumn: { width: 58, alignItems: "flex-end", justifyContent: "center", gap: 7, flexShrink: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  chatTitle: { color: colors.ink, fontSize: 16, fontWeight: "700", maxWidth: "100%" },
  chatTitleDark: { color: "#FFFFFF" },
  chatTime: { color: colors.faint, fontSize: 12, fontWeight: "700", textAlign: "right" },
  chatTimeDark: { color: "rgba(255,255,255,0.48)" },
  chatPreview: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  chatPreviewDark: { color: "rgba(255,255,255,0.62)" },
  chatPreviewUnread: { color: colors.ink, fontWeight: "600" },
  chatPreviewUnreadDark: { color: "#FFFFFF" },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    backgroundColor: colors.primaryDark,
  },
  unreadBadgeCompact: {
    position: "absolute",
    right: -12,
    top: -8,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    paddingHorizontal: 5,
  },
  unreadBadgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  chatPane: {
    flex: 1,
    minWidth: 0,
    borderRadius: radii.lg,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.page,
    overflow: "hidden",
    ...shadow,
  },
  chatPaneDark: {
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "#0B141A",
    shadowColor: "#000000",
  },
  chatPaneMobile: { width: "100%", maxWidth: "100%", borderRadius: 0, borderWidth: 0 },
  chatHeader: {
    minHeight: 74,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomColor: "rgba(255,255,255,0.18)",
    borderBottomWidth: 1,
    backgroundColor: colors.primaryDark,
    gap: 10,
  },
  chatHeaderDark: { backgroundColor: "#202C33", borderBottomColor: "rgba(6,207,156,0.12)" },
  chatHeaderMain: { flex: 1, minWidth: 0 },
  chatHeaderActions: { flexShrink: 0 },
  subtasksHeaderPill: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.86)",
  },
  subtasksHeaderPillText: { color: "#0B7F68", fontSize: 12, fontWeight: "800" },
  chatHeaderTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  chatHeaderSubButton: { alignSelf: "flex-start", borderRadius: 6 },
  chatHeaderSub: { color: "rgba(255,255,255,0.76)", fontSize: 12 },
  chatHeaderSubTyping: { color: "#FFFFFF", fontWeight: "600" },
  archivedTaskBanner: {
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,128,105,0.12)",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(233,237,239,0.82)",
  },
  archivedTaskBannerDark: {
    borderBottomColor: "rgba(255,255,255,0.08)",
    backgroundColor: "rgba(255,255,255,0.045)",
  },
  archivedTaskBannerIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(16,185,129,0.12)",
  },
  archivedTaskBannerIconDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  archivedTaskBannerText: { flex: 1, minWidth: 0, gap: 3 },
  archivedTaskBannerTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  archivedTaskBannerTitle: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  archivedTaskBannerTitleDark: { color: "#E9EDEF" },
  archivedTaskBannerPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
    color: colors.primaryDark,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
    backgroundColor: "rgba(0,168,132,0.12)",
  },
  archivedTaskBannerPillDark: {
    color: colors.accent,
    backgroundColor: "rgba(6,207,156,0.10)",
  },
  archivedTaskBannerCopy: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  archivedTaskBannerCopyDark: { color: "rgba(233,237,239,0.62)" },
  subtasksPanel: {
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,168,132,0.12)",
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  subtasksPanelDark: {
    borderBottomColor: "rgba(255,255,255,0.08)",
    backgroundColor: "#111B21",
  },
  subtasksPanelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  subtasksPanelTitle: { color: colors.ink, fontSize: 14, fontWeight: "800" },
  subtasksPanelTitleDark: { color: "#E9EDEF" },
  subtasksPanelMeta: { color: colors.muted, fontSize: 12, fontWeight: "700", marginTop: 2 },
  subtasksPanelMetaDark: { color: "rgba(233,237,239,0.62)" },
  subtasksCreateButton: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    borderRadius: 17,
  },
  subtasksCreateButtonText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  subtasksScroller: { gap: 8, paddingRight: 16 },
  subtaskCard: {
    width: 184,
    minHeight: 106,
    justifyContent: "space-between",
    gap: 8,
    padding: 11,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.18)",
    backgroundColor: colors.accentSoft,
  },
  subtaskCardDark: {
    borderColor: "rgba(6,207,156,0.20)",
    backgroundColor: "rgba(6,207,156,0.10)",
  },
  subtaskCardResolved: { opacity: 0.78 },
  subtaskCardNumber: { color: colors.primaryDark, fontSize: 11, fontWeight: "900" },
  subtaskCardNumberDark: { color: colors.accent },
  subtaskCardTitle: { color: colors.ink, fontSize: 13, fontWeight: "800", lineHeight: 18 },
  subtaskCardTitleDark: { color: "#E9EDEF" },
  subtaskCardFooter: { flexDirection: "row", alignItems: "center", gap: 6 },
  subtaskCardStatus: { color: colors.muted, fontSize: 11, fontWeight: "800", textTransform: "capitalize" },
  subtaskCardStatusDark: { color: "rgba(233,237,239,0.68)" },
  subtasksEmptyText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  subtasksEmptyTextDark: { color: "rgba(233,237,239,0.62)" },
  messageList: { flexGrow: 1, padding: 18, gap: 12, backgroundColor: colors.page },
  messageListDark: { backgroundColor: "#0B141A" },
  olderMessagesLoader: {
    alignSelf: "center",
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  olderMessagesLoaderDark: { backgroundColor: "#202C33", borderColor: "rgba(255,255,255,0.10)" },
  messageWithDate: { gap: 12 },
  datePill: {
    alignSelf: "center",
    minHeight: 28,
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: radii.pill,
    backgroundColor: "rgba(17,27,33,0.10)",
  },
  datePillDark: { backgroundColor: "rgba(255,255,255,0.12)" },
  datePillText: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  datePillTextDark: { color: "rgba(255,255,255,0.70)" },
  messageIdentityRow: { width: "100%", flexDirection: "row", alignItems: "flex-end", gap: 8 },
  messageIdentityMine: { justifyContent: "flex-end" },
  messageIdentityTheirs: { justifyContent: "flex-start" },
  messageWrap: { width: "78%", maxWidth: "78%", minWidth: 0, flexShrink: 1 },
  messageWrapAudio: { width: "90%", maxWidth: "90%" },
  messageWrapWithAvatar: { width: "72%", maxWidth: "72%" },
  messageMine: { alignSelf: "flex-end" },
  messageTheirs: { alignSelf: "flex-start" },
  senderName: { color: colors.primaryDark, fontSize: 12, fontWeight: "600", marginBottom: 4, marginLeft: 8 },
  senderNameDark: { color: colors.accent },
  bubble: { alignSelf: "flex-start", maxWidth: "100%", padding: 11, borderRadius: 14, gap: 6 },
  mineBubble: { alignSelf: "flex-end", backgroundColor: colors.bubbleMine, borderTopRightRadius: 4 },
  mineBubbleDark: { backgroundColor: "#005C4B" },
  theirBubble: { backgroundColor: colors.bubbleTheirs, borderTopLeftRadius: 4, borderColor: "rgba(233,237,239,0.72)", borderWidth: 1 },
  theirBubbleDark: { backgroundColor: "#202C33", borderColor: "rgba(255,255,255,0.10)" },
  swipeBubbleFrame: { position: "relative", overflow: "visible" },
  replySwipeCue: {
    position: "absolute",
    top: "50%",
    width: 30,
    height: 30,
    marginTop: -15,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,128,105,0.12)",
  },
  replySwipeCueMine: { right: -38 },
  replySwipeCueTheirs: { left: -38 },
  replySwipeCueDark: { backgroundColor: "rgba(6,207,156,0.14)" },
  messageMenuButton: {
    position: "absolute",
    top: 5,
    width: 30,
    height: 26,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0,
    backgroundColor: "rgba(255,255,255,0.58)",
    shadowColor: "transparent",
    zIndex: 5,
  },
  messageMenuButtonMine: { right: 6 },
  messageMenuButtonTheirs: { right: 6 },
  messageMenuButtonDark: {
    backgroundColor: "rgba(17,27,33,0.52)",
  },
  messageMenuButtonVisible: { opacity: 1 },
  forwardedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  forwardedText: { color: colors.primaryDark, fontSize: 11, fontWeight: "600" },
  forwardedTextMine: { color: colors.primaryDark },
  forwardedTextMineDark: { color: "rgba(233,237,239,0.82)" },
  replyQuote: {
    minWidth: 180,
    maxWidth: "100%",
    flexDirection: "row",
    overflow: "hidden",
    borderRadius: 10,
    backgroundColor: "rgba(0,168,132,0.08)",
  },
  replyQuoteDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  replyQuoteMine: { backgroundColor: "rgba(17,27,33,0.06)" },
  replyQuoteMineDark: { backgroundColor: "rgba(255,255,255,0.13)" },
  replyQuoteBar: { width: 4, backgroundColor: colors.primaryDark },
  replyQuoteBarMine: { backgroundColor: colors.accent },
  replyQuoteBody: { flex: 1, minWidth: 0, gap: 2, paddingHorizontal: 9, paddingVertical: 7 },
  replyQuoteName: { color: colors.primaryDark, fontSize: 12, fontWeight: "800" },
  replyQuoteNameMine: { color: colors.primaryDark },
  replyQuoteNameMineDark: { color: colors.accent },
  replyQuoteText: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  replyQuoteTextMine: { color: colors.muted },
  replyQuoteTextMineDark: { color: "rgba(233,237,239,0.74)" },
  thinkingBubble: { flexDirection: "row", alignItems: "center", gap: 8 },
  thinkingText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  thinkingTextDark: { color: "rgba(255,255,255,0.62)" },
  messageText: { flexShrink: 1, color: colors.ink, fontSize: 15, lineHeight: 21 },
  messageTextDark: { color: "#FFFFFF" },
  messageTextMine: { color: colors.ink },
  messageTextMineDark: { color: "#E9EDEF" },
  messageStrong: { fontWeight: "700" },
  messageEmphasis: { fontStyle: "italic" },
  messageLink: { color: colors.primaryDark, fontWeight: "700", textDecorationLine: "underline" },
  messageLinkMine: { color: colors.primaryDark },
  messageLinkMineDark: { color: "#53BDEB" },
  messageMention: {
    paddingHorizontal: 5,
    borderRadius: 7,
    overflow: "hidden",
    color: colors.primaryDark,
    fontWeight: "800",
    backgroundColor: "rgba(0,168,132,0.16)",
  },
  messageMentionMine: {
    color: colors.primaryDark,
    backgroundColor: "rgba(0,128,105,0.14)",
  },
  messageMentionDark: {
    color: colors.accent,
    backgroundColor: "rgba(6,207,156,0.18)",
  },
  messageCode: {
    paddingHorizontal: 5,
    borderRadius: 5,
    overflow: "hidden",
    color: colors.ink,
    backgroundColor: colors.primarySoft,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  messageCodeMine: { color: colors.ink, backgroundColor: "rgba(17,27,33,0.08)" },
  messageCodeMineDark: { color: "#E9EDEF", backgroundColor: "rgba(255,255,255,0.18)" },
  messageMeta: { alignSelf: "flex-end", flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: colors.faint, fontSize: 10 },
  metaTextMine: { color: colors.faint },
  metaTextMineDark: { color: "rgba(233,237,239,0.72)" },
  imageAttachment: { gap: 8, marginBottom: 2 },
  imageAttachmentMedia: { width: 184, height: 156, borderRadius: 12, backgroundColor: "#E9EDEF" },
  attachmentCaption: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  attachmentCaptionMine: { color: colors.muted },
  attachmentCaptionMineDark: { color: "rgba(233,237,239,0.78)" },
  documentAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: colors.surfaceBlue,
  },
  documentAttachmentMine: { backgroundColor: "rgba(17,27,33,0.06)" },
  documentAttachmentMineDark: { backgroundColor: "rgba(255,255,255,0.14)" },
  documentAttachmentIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,128,105,0.12)",
  },
  documentAttachmentIconMine: { backgroundColor: "rgba(17,27,33,0.08)" },
  documentAttachmentIconMineDark: { backgroundColor: "rgba(255,255,255,0.16)" },
  documentAttachmentTitle: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  documentAttachmentTitleMine: { color: colors.ink },
  documentAttachmentTitleMineDark: { color: "#E9EDEF" },
  documentAttachmentMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  documentAttachmentMetaMine: { color: colors.muted },
  documentAttachmentMetaMineDark: { color: "rgba(233,237,239,0.72)" },
  audioAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 14,
    backgroundColor: colors.surfaceBlue,
    minWidth: 240,
    width: "100%",
  },
  audioAttachmentMine: { backgroundColor: "rgba(17,27,33,0.06)" },
  audioAttachmentMineDark: { backgroundColor: "rgba(255,255,255,0.14)" },
  audioPlayButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  audioPlayButtonMine: { backgroundColor: "rgba(255,255,255,0.82)" },
  audioPlayButtonMineDark: { backgroundColor: "rgba(255,255,255,0.16)" },
  audioWaveRow: { flexDirection: "row", alignItems: "center", gap: 3, minHeight: 26, flexWrap: "nowrap", overflow: "hidden" },
  audioWaveBar: { width: 4, borderRadius: 999, flexShrink: 0 },
  audioWaveMissing: { flex: 1, height: 3, borderRadius: 999, backgroundColor: "#D1D7DB" },
  audioWaveMissingMine: { backgroundColor: "rgba(17,27,33,0.28)" },
  audioWaveMissingDark: { backgroundColor: "rgba(233,237,239,0.32)" },
  audioDuration: { color: colors.muted, fontSize: 11, marginTop: 4 },
  audioDurationMine: { color: colors.muted },
  audioDurationMineDark: { color: "rgba(233,237,239,0.78)" },
  composer: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    backgroundColor: colors.surface,
  },
  composerDark: { borderTopColor: "rgba(255,255,255,0.10)", backgroundColor: "#202C33" },
  composerRecording: { alignItems: "center" },
  inlineVoiceRecorder: {
    flex: 1,
    minHeight: 48,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 4,
    borderRadius: 24,
    backgroundColor: colors.surface,
  },
  inlineVoiceRecorderDark: { backgroundColor: "#202C33" },
  voiceInlineButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceBlue,
  },
  voiceInlineButtonDark: { backgroundColor: "rgba(255,255,255,0.10)" },
  voiceDeleteButton: { backgroundColor: "#FFF0F1" },
  voiceDeleteButtonDark: { backgroundColor: "rgba(241,92,109,0.14)" },
  voiceRecorderContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 2,
  },
  voiceRecorderMeta: { minWidth: 54, flexDirection: "row", alignItems: "center", gap: 6 },
  voiceRecordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.danger,
  },
  voiceRecordingDotPaused: { backgroundColor: colors.faint },
  voiceRecorderTime: { color: colors.muted, fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
  voiceRecorderTimeDark: { color: "#E9EDEF" },
  voiceRecorderWaveRow: {
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    overflow: "hidden",
  },
  voiceRecorderWaveBar: {
    width: 3,
    maxHeight: 34,
    borderRadius: 999,
    backgroundColor: colors.primaryDark,
  },
  voiceSendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  quickPromptDock: {
    position: "relative",
    alignSelf: "flex-end",
    marginBottom: 2,
    zIndex: 80,
    elevation: 10,
  },
  quickPromptBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 60,
    backgroundColor: "transparent",
  },
  quickPromptButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.20)",
    backgroundColor: "#F0F2F5",
  },
  quickPromptButtonDark: {
    borderColor: "rgba(255,255,255,0.20)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  quickPromptMenu: {
    position: "absolute",
    left: 0,
    bottom: 40,
    width: 250,
    padding: 10,
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    shadowColor: "#101828",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 6,
  },
  quickPromptMenuDark: {
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "#202C33",
  },
  quickPromptMenuTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.muted,
    paddingHorizontal: 2,
  },
  quickPromptMenuTitleDark: { color: "rgba(255,255,255,0.62)" },
  quickPromptItem: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: "#F0F2F5",
  },
  quickPromptItemDark: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  quickPromptItemText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "700",
  },
  quickPromptItemTextDark: { color: "#FFFFFF" },
  mentionSuggestion: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.22)",
    backgroundColor: "#E7FCEB",
  },
  mentionSuggestionDark: {
    borderColor: "rgba(6,207,156,0.22)",
    backgroundColor: "rgba(6,207,156,0.12)",
  },
  mentionSuggestionAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  mentionSuggestionAvatarDark: { backgroundColor: colors.accent },
  mentionSuggestionBody: { flex: 1, minWidth: 0 },
  mentionSuggestionName: { color: colors.ink, fontSize: 14, fontWeight: "800" },
  mentionSuggestionNameDark: { color: "#FFFFFF" },
  mentionSuggestionHandle: { color: colors.primaryDark, fontSize: 12, fontWeight: "800", marginTop: 1 },
  mentionSuggestionHandleDark: { color: colors.accent },
  composerAccessoryButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F0F2F5",
  },
  composerAccessoryButtonDark: { backgroundColor: "rgba(255,255,255,0.10)" },
  composerBody: { flex: 1, gap: 8, justifyContent: "center" },
  composerQuickActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  composerReply: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    overflow: "hidden",
    borderRadius: 15,
    backgroundColor: "#F0F2F5",
  },
  composerReplyDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  composerReplyBar: { width: 4, alignSelf: "stretch", backgroundColor: colors.primaryDark },
  composerReplyName: { color: colors.primaryDark, fontSize: 12, fontWeight: "800" },
  composerReplyNameDark: { color: colors.accent },
  composerReplyText: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  composerReplyTextDark: { color: "rgba(255,255,255,0.66)" },
  composerInputShell: {
    minHeight: 44,
    maxHeight: 110,
    borderRadius: 22,
    backgroundColor: "#F0F2F5",
    overflow: "hidden",
    position: "relative",
  },
  composerInputShellDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  composerInput: {
    height: 44,
    minHeight: 44,
    maxHeight: 110,
    paddingHorizontal: 16,
    paddingTop: Platform.select({ android: 0, default: 11 }),
    paddingBottom: Platform.select({ android: 0, default: 11 }),
    color: colors.ink,
    fontSize: 16,
    lineHeight: 22,
    backgroundColor: "transparent",
    textAlignVertical: "center",
    includeFontPadding: false,
  },
  composerInputDark: { color: "#FFFFFF", backgroundColor: "transparent" },
  composerInputField: { position: "relative", zIndex: 2 },
  composerInputOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  composerInputOverlayText: {
    height: 44,
    minHeight: 44,
    maxHeight: 110,
    paddingHorizontal: 16,
    paddingTop: Platform.select({ android: 0, default: 11 }),
    paddingBottom: Platform.select({ android: 0, default: 11 }),
    color: colors.ink,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: "center",
    includeFontPadding: false,
  },
  composerInputOverlayTextDark: { color: "#FFFFFF" },
  composerInputTransparentText: { color: "transparent" },
  composerInputMention: {
    borderRadius: 7,
    backgroundColor: "rgba(0, 168, 132, 0.18)",
    color: colors.primaryDark,
    fontWeight: "800",
  },
  composerInputMentionDark: {
    backgroundColor: "rgba(6, 207, 156, 0.18)",
    color: colors.accent,
  },
  composerInputWithAttachment: { minHeight: 44 },
  composerAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 16,
    backgroundColor: "#F0F2F5",
  },
  composerAttachmentDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  composerAttachmentImage: { width: 42, height: 42, borderRadius: 12, backgroundColor: "#E9EDEF" },
  composerAttachmentIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,128,105,0.12)",
  },
  composerAttachmentIconDark: { backgroundColor: "rgba(6,207,156,0.12)" },
  composerAttachmentTitle: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  composerAttachmentTitleDark: { color: "#FFFFFF" },
  composerAttachmentMeta: { color: colors.muted, fontSize: 11, marginTop: 3 },
  composerAttachmentMetaDark: { color: "rgba(255,255,255,0.62)" },
  composerAttachmentClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(17,27,33,0.06)",
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  cameraQuickButton: {
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.14)",
  },
  cameraQuickButtonDark: {
    backgroundColor: "rgba(6,207,156,0.12)",
    borderColor: "rgba(6,207,156,0.20)",
  },
  statusComposer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceBlue,
  },
  statusComposerDark: { backgroundColor: "rgba(255,255,255,0.06)" },
  statusCard: { padding: 14, borderRadius: radii.md, borderColor: colors.line, borderWidth: 1, backgroundColor: colors.surface, gap: 12 },
  statusCardDark: { borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.06)" },
  statusText: { color: colors.ink, fontSize: 16, lineHeight: 23 },
  statusTextDark: { color: "#FFFFFF" },
  quickAction: {
    marginHorizontal: 14,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceBlue,
  },
  quickActionDark: { backgroundColor: "rgba(6,207,156,0.10)" },
  quickActionText: { color: colors.primaryDark, fontWeight: "700" },
  quickActionTextDark: { color: colors.accent },
  settingsContent: { paddingBottom: 18, backgroundColor: colors.surface },
  profileCard: { margin: 14, padding: 14, borderRadius: radii.md, flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: colors.surfaceBlue },
  profileCardDark: { backgroundColor: "rgba(255,255,255,0.06)" },
  profileAvatarButton: { borderRadius: 32, position: "relative" },
  profileAvatarBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 21,
    height: 21,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.08)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  profileAvatarBadgeDark: {
    borderColor: "rgba(6,207,156,0.36)",
    backgroundColor: colors.accent,
  },
  profileAvatarHint: { marginTop: 4, color: colors.primaryDark, fontSize: 11, fontWeight: "700" },
  profileAvatarHintDark: { color: colors.accent },
  profileName: { color: colors.ink, fontSize: 20, fontWeight: "700" },
  profileNameDark: { color: "#FFFFFF" },
  settingRow: {
    marginHorizontal: 14,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 13,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  settingRowDark: { borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.06)" },
  settingRowStack: {
    marginHorizontal: 14,
    marginBottom: 10,
    gap: 12,
    padding: 13,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  disabledPressable: { opacity: 0.7 },
  settingDangerRow: { borderColor: "rgba(229,72,77,0.22)" },
  settingDangerText: { color: colors.danger },
  settingsNotice: {
    marginHorizontal: 14,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.sm,
    color: colors.primaryDark,
    fontSize: 12,
    fontWeight: "600",
    backgroundColor: colors.accentSoft,
  },
  settingsNoticeDark: { color: colors.accent, backgroundColor: "rgba(6,207,156,0.12)" },
  themeSwitch: {
    width: 46,
    height: 26,
    borderRadius: 13,
    justifyContent: "center",
    padding: 3,
    backgroundColor: "#D1D7DB",
  },
  themeSwitchOn: { backgroundColor: "rgba(6,207,156,0.28)" },
  themeSwitchKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#FFFFFF" },
  themeSwitchKnobOn: { transform: [{ translateX: 20 }], backgroundColor: colors.accent },
  themeSelectedDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    flexShrink: 0,
  },
  accentThemeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  accentThemeOption: {
    minWidth: 96,
    flexGrow: 1,
    minHeight: 50,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.52)",
  },
  accentSwatchStack: {
    width: 34,
    height: 18,
    position: "relative",
    flexShrink: 0,
  },
  accentSwatch: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.72)",
  },
  accentSwatchMid: { left: 8 },
  accentSwatchLight: { left: 16 },
  accentThemeLabel: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    fontSize: 12,
    fontWeight: "800",
  },
  accentThemeLabelDark: { color: "#FFFFFF" },
  desktopEmpty: { flex: 1, borderRadius: radii.lg, borderColor: colors.line, borderWidth: 1, backgroundColor: colors.surface },
  desktopEmptyDark: { borderColor: "rgba(255,255,255,0.10)", backgroundColor: "#202C33" },
  emptyState: { alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingVertical: 42, gap: 8 },
  emptyCompact: { paddingVertical: 18 },
  emptyIcon: { width: 58, height: 58, borderRadius: 29, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceBlue },
  emptyIconDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "700", textAlign: "center" },
  emptyTitleDark: { color: "#FFFFFF" },
  emptyCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: "center" },
  emptyCopyDark: { color: "rgba(255,255,255,0.62)" },
  agentWelcomeCard: {
    marginHorizontal: 14,
    marginVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.18)",
    backgroundColor: colors.surfaceBlue,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  agentWelcomeCardDark: {
    borderColor: "rgba(6,207,156,0.22)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  agentWelcomeTitle: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  agentWelcomeTitleDark: { color: "#FFFFFF" },
  agentWelcomeBody: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  agentWelcomeBodyDark: { color: "rgba(255,255,255,0.70)" },
  agentFab: {
    position: "absolute",
    right: 16,
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.primaryDark,
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.35)",
    ...shadow,
    zIndex: 130,
    elevation: 12,
  },
  agentFabDark: {
    backgroundColor: colors.accent,
    borderColor: "rgba(6,207,156,0.55)",
  },
  agentFabText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
  agentFabTextDark: {
    color: colors.primaryDark,
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(17, 27, 33, 0.24)",
  },
  sheetBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    backgroundColor: "rgba(17,27,33,0.34)",
    padding: 18,
  },
  taskActionSheet: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 18,
    backgroundColor: colors.surface,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.line,
    ...shadow,
  },
  taskActionSheetDark: {
    backgroundColor: "#202C33",
    borderColor: "rgba(255,255,255,0.10)",
  },
  taskActionList: { gap: 8, paddingVertical: 4 },
  taskInlineActions: {
    position: "absolute",
    right: 12,
    top: 58,
    zIndex: 20,
    width: 188,
    borderRadius: 12,
    padding: 6,
    gap: 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.22)",
    ...shadow,
  },
  taskInlineActionsDark: {
    backgroundColor: "#111B21",
    borderColor: "rgba(6,207,156,0.20)",
  },
  taskActionButton: {
    minHeight: 38,
    borderRadius: 9,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "transparent",
  },
  taskActionButtonDanger: {
    backgroundColor: "transparent",
  },
  taskActionButtonText: { color: colors.primaryDark, fontSize: 13, fontWeight: "800" },
  taskActionButtonDangerText: { color: "#DC2626" },
  modalBackdrop: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.overlay, padding: 18 },
  modalBackdropKeyboardOpen: { justifyContent: "flex-start", paddingTop: 18 },
  modalKeyboardFrame: { width: "100%", maxWidth: 460 },
  modalCard: {
    width: "100%",
    maxWidth: 460,
    flexShrink: 1,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    padding: 18,
    gap: 14,
    overflow: "hidden",
  },
  modalTitle: { color: colors.ink, fontSize: 22, fontWeight: "700" },
  modalSubtitle: { color: colors.muted, fontSize: 13, fontWeight: "700", lineHeight: 18 },
  modalFieldLabel: { color: colors.muted, fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  modalInput: {
    minHeight: 46,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 12,
    color: colors.ink,
    backgroundColor: colors.page,
  },
  dateTimeGrid: { flexDirection: "row", gap: 10 },
  dateTimeInputWrap: {
    flex: 1,
    minHeight: 46,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 12,
    backgroundColor: colors.page,
  },
  dateTimeInput: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    fontSize: 14,
    fontWeight: "700",
    paddingVertical: 0,
  },
  dateTimeQuickRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: -6 },
  dateTimeChip: {
    minHeight: 30,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: 15,
    backgroundColor: "rgba(0,168,132,0.11)",
  },
  dateTimeChipText: { color: colors.primaryDark, fontSize: 12, fontWeight: "800" },
  assigneeChipRow: { gap: 8, paddingVertical: 2, paddingRight: 8 },
  assigneeChip: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "rgba(0,168,132,0.16)",
    backgroundColor: colors.page,
  },
  assigneeChipActive: { borderColor: colors.primaryDark, backgroundColor: colors.primaryDark },
  assigneeChipText: { color: colors.ink, fontSize: 12, fontWeight: "800" },
  assigneeChipTextActive: { color: "#FFFFFF" },
  newContactForm: { gap: 10 },
  statusInput: { minHeight: 130, textAlignVertical: "top", paddingTop: 12 },
  modalList: { maxHeight: 430, minHeight: 120, flexShrink: 1 },
  modalRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, paddingVertical: 10, borderRadius: 14 },
  memberRowDisabled: { opacity: 0.72 },
  memberSelfTag: {
    color: colors.primaryDark,
    fontSize: 12,
    fontWeight: "900",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(0,168,132,0.12)",
  },
  newChatContactList: { maxHeight: 430, minHeight: 120, flexShrink: 1 },
  newChatContactListContent: { gap: 8, paddingVertical: 2 },
  newChatContactRow: {
    width: "100%",
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: 14,
    backgroundColor: colors.page,
    overflow: "hidden",
  },
  newChatActions: { paddingTop: 2 },
  saveContactPeer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: colors.page,
  },
  attachmentMenuList: { gap: 10 },
  attachmentMenuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: colors.page,
  },
  attachmentMenuIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,128,105,0.12)",
  },
  forwardPreviewCard: {
    padding: 12,
    borderRadius: 14,
    backgroundColor: colors.page,
    borderWidth: 1,
    borderColor: colors.line,
  },
  forwardPreviewCardDark: {
    borderColor: "rgba(255,255,255,0.10)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  messageActionsSheet: {
    position: "absolute",
    maxWidth: MESSAGE_ACTION_MENU_WIDTH,
    overflow: "hidden",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "rgba(17,27,33,0.12)",
    shadowColor: "#101828",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 22,
    elevation: 12,
  },
  messageActionsBackdrop: {
    flex: 1,
    backgroundColor: "rgba(17,27,33,0.08)",
  },
  messageActionsSheetDark: {
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "#111B21",
  },
  messageActionRow: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
  },
  messageActionRowPressed: { backgroundColor: "rgba(17,27,33,0.07)" },
  messageActionDivider: {
    height: 1,
    marginHorizontal: 18,
    marginVertical: 7,
    backgroundColor: "rgba(17,27,33,0.10)",
  },
  messageActionDividerDark: { backgroundColor: "rgba(255,255,255,0.10)" },
  messageActionText: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  messageActionTextDark: { color: "#FFFFFF" },
  voiceComposerCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 28,
    backgroundColor: colors.surface,
    paddingHorizontal: 20,
    paddingVertical: 22,
    gap: 18,
  },
  voiceComposerTitle: { color: colors.ink, fontSize: 22, fontWeight: "700", textAlign: "center" },
  voiceWaveCard: {
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: "#F0F2F5",
    alignItems: "center",
    gap: 10,
  },
  voiceWaveRow: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 34 },
  voiceWaveBar: { width: 5, borderRadius: 999 },
  voiceComposerTime: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  voiceComposerActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  voiceMiniButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F0F2F5",
  },
  voiceRecordButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  secondaryButton: {
    height: 42,
    paddingHorizontal: 16,
    borderRadius: radii.sm,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.page,
  },
  secondaryText: { color: colors.ink, fontWeight: "600" },
  primaryButton: {
    height: 42,
    paddingHorizontal: 18,
    borderRadius: radii.sm,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  fullWidthButton: { width: "100%" },
  primaryText: { color: "#FFFFFF", fontWeight: "700" },
});
