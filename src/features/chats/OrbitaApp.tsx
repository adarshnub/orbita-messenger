import { Ionicons } from "@expo/vector-icons";
import {
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import * as DeviceContacts from "expo-contacts";
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
  BackendStatus,
} from "@/features/chats/backendTypes";
import {
  attachmentFromMessage,
  formatBytes,
  formatDurationMs,
  messagePreviewText,
  waveformBars,
} from "@/features/chats/messageUtils";
import { messengerApi } from "@/lib/messengerApi";
import {
  applySavedContactNamesToConversations,
  markCachedMessageFailed,
  readCachedBootstrap,
  readCachedMessages,
  replaceCachedMessage,
  upsertCachedMessage,
  writeBootstrapCache,
  writeConversationMessages,
} from "@/lib/localChatCache";
import { hapticMessageReceived, hapticMessageSent } from "@/lib/haptics";
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

type Tab = "chats" | "status" | "contacts" | "calls" | "settings";
type AuthMode = "signin" | "signup";
type AppThemeMode = "light" | "dark";
type ChatMessage = BackendMessage & { localState?: "sending" | "failed" };
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
};
type ForwardTarget = {
  avatarUrl?: string | null;
  id: string;
  isBot?: boolean;
  type: "conversation" | "contact";
  title: string;
  subtitle: string;
};
type ChatListContact = BackendProfile & { existingConversationId?: string };
type UnsavedPeer = {
  defaultName: string;
  phone: string;
};

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
const CHAT_PAGE_SIZE = 24;
const tabs: Array<{ id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { id: "chats", label: "Chats", icon: "chatbubbles-outline" },
  { id: "status", label: "Status", icon: "aperture-outline" },
  { id: "contacts", label: "Contacts", icon: "people-outline" },
  { id: "calls", label: "Calls", icon: "call-outline" },
  { id: "settings", label: "Settings", icon: "settings-outline" },
];

const DEV_BYPASS_OTP = "123456";
const DEV_OTP_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_ENABLE_DEV_OTP === "1";
const OTP_RESEND_SECONDS = 45;
const THEME_STORAGE_KEY = "orbita.themeMode";
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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

type AppThemeContextValue = {
  isDarkTheme: boolean;
  setThemeMode: (mode: AppThemeMode) => void;
  themeMode: AppThemeMode;
  toggleTheme: () => void;
};

const AppThemeContext = createContext<AppThemeContextValue>({
  isDarkTheme: true,
  setThemeMode: () => undefined,
  themeMode: "dark",
  toggleTheme: () => undefined,
});

function useAppTheme() {
  return useContext(AppThemeContext);
}

function usePersistedTheme() {
  const [themeMode, setThemeModeState] = useState<AppThemeMode>("dark");
  const isDarkTheme = themeMode === "dark";

  useEffect(() => {
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((savedTheme) => {
        if (savedTheme === "light" || savedTheme === "dark") {
          setThemeModeState(savedTheme);
        }
      })
      .catch(() => undefined);
  }, []);

  const setThemeMode = useCallback((mode: AppThemeMode) => {
    setThemeModeState(mode);
    void AsyncStorage.setItem(THEME_STORAGE_KEY, mode).catch(() => undefined);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeMode(themeMode === "dark" ? "light" : "dark");
  }, [setThemeMode, themeMode]);

  return useMemo<AppThemeContextValue>(
    () => ({ isDarkTheme, setThemeMode, themeMode, toggleTheme }),
    [isDarkTheme, setThemeMode, themeMode, toggleTheme],
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

function isTaskManagerAgentConversation(conversation: BackendConversation) {
  return conversation.participants.some((participant) => participant.about?.trim().toLowerCase() === "task manager agent");
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
  if (conversation.kind === "direct") return "1:1 conversation";
  return `${conversation.participants.length} member${conversation.participants.length === 1 ? "" : "s"}`;
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
  const stable = [...incoming];
  const stableById = new Set(stable.map((message) => message.id));

  pending.forEach((pendingMessage) => {
    if (stableById.has(pendingMessage.id)) return;
    const pendingTime = Date.parse(pendingMessage.createdAt);
    const match = stable.some((serverMessage) => {
      const sameSenderAndBody = messageSignature(serverMessage) === messageSignature(pendingMessage);
      if (!sameSenderAndBody) return false;
      const serverTime = Date.parse(serverMessage.createdAt);
      return Math.abs(serverTime - pendingTime) <= MESSAGE_RECONCILE_WINDOW_MS;
    });
    if (!match) stable.push(pendingMessage);
  });

  stable.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return stable;
}

function upsertMessage(messages: ChatMessage[], incoming: BackendMessage): ChatMessage[] {
  const withoutDuplicate = messages.filter((message) => message.id !== incoming.id);
  const matchingLocal = withoutDuplicate.find((message) => {
    if (!message.localState) return false;
    if (message.senderId !== incoming.senderId) return false;
    if (messageSignature(message) !== messageSignature(incoming)) return false;
    return Math.abs(Date.parse(message.createdAt) - Date.parse(incoming.createdAt)) <= MESSAGE_RECONCILE_WINDOW_MS;
  });
  const next = matchingLocal
    ? withoutDuplicate.map((message) => (message.id === matchingLocal.id ? incoming : message))
    : [...withoutDuplicate, incoming];

  return next.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function OrbitaLogo({ size = 64 }: { size?: number }) {
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
    <Animated.View style={[styles.logoFrame, { width: size, height: size, borderRadius: size * 0.28, transform: [{ scale: pulse }] }]}>
      <View style={[styles.logoCore, { width: size * 0.72, height: size * 0.72, borderRadius: size * 0.2 }]} />
      <View style={[styles.logoNode, styles.logoNodeTop, { width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08 }]} />
      <View style={[styles.logoNode, styles.logoNodeLeft, { width: size * 0.13, height: size * 0.13, borderRadius: size * 0.065 }]} />
      <View style={[styles.logoNode, styles.logoNodeRight, { width: size * 0.12, height: size * 0.12, borderRadius: size * 0.06 }]} />
      <View style={[styles.logoSignal, { width: size * 0.5, top: size * 0.32 }]} />
      <View style={[styles.logoSignal, { width: size * 0.38, top: size * 0.48 }]} />
      <Animated.View
        style={[
          styles.logoScan,
          {
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
  const { isDarkTheme } = useAppTheme();
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
        <Animated.View style={[styles.authScanLine, !isDarkTheme && styles.authScanLineLight, { transform: [{ translateY: scanY }] }]} />
        <Animated.View style={[styles.authNode, !isDarkTheme && styles.authNodeLight, styles.authNodeOne, { opacity: nodePulse }]} />
        <Animated.View style={[styles.authNode, styles.authNodeTwo, !isDarkTheme && styles.authNodeTwoLight, { opacity: nodePulse }]} />
        <Animated.View style={[styles.authNode, styles.authNodeThree, !isDarkTheme && styles.authNodeThreeLight, { opacity: nodePulse }]} />
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
                opacity: pulseOpacity,
                transform: [{ scale: pulseScale }],
              },
            ]}
          />
          <View style={[styles.botAvatarRing, { width: size + 4, height: size + 4, borderRadius: (size + 4) / 2 }]} />
        </>
      ) : null}
      <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      {hasImage ? (
        <Image
          source={{ uri: avatarUrl! }}
          onError={() => setFailed(true)}
          style={[styles.avatarImage, { width: size, height: size, borderRadius: size / 2 }]}
        />
      ) : isBot ? (
        <View style={styles.botAvatarFace}>
          <View style={styles.botAvatarEyeRow}>
            <View style={styles.botAvatarEye} />
            <View style={styles.botAvatarEye} />
          </View>
          <View style={styles.botAvatarMouth} />
          <View style={styles.botAvatarChip}>
            <Ionicons color={colors.primaryDark} name="sparkles" size={9} />
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
  const { isDarkTheme } = useAppTheme();
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
  const { isDarkTheme } = useAppTheme();
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
  const { isDarkTheme } = useAppTheme();
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
  const { isDarkTheme } = useAppTheme();
  return (
    <Text style={[styles.messageText, isDarkTheme && !mine && styles.messageTextDark, mine && styles.messageTextMine]}>
      {renderMessageInline(text, mine, "message")}
    </Text>
  );
}

function renderMessageInline(text: string, mine: boolean, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^)\s]+)\)|((?:https?:\/\/|www\.)[^\s<]+)/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    if (match.index > cursor) {
      nodes.push(...renderMessageFormatting(text.slice(cursor, match.index), mine, `${keyPrefix}-text-${cursor}`));
    }

    const label = match[1] || match[3] || "";
    const rawUrl = match[2] || match[3] || "";
    const { cleanUrl, trailing } = splitTrailingPunctuation(rawUrl);
    nodes.push(
      <Text
        accessibilityRole="link"
        key={`${keyPrefix}-link-${match.index}`}
        onPress={() => openMessageUrl(cleanUrl)}
        style={[styles.messageLink, mine && styles.messageLinkMine]}
      >
        {label === rawUrl ? cleanUrl : label}
      </Text>,
    );
    if (trailing) nodes.push(<Text key={`${keyPrefix}-trail-${match.index}`}>{trailing}</Text>);
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(...renderMessageFormatting(text.slice(cursor), mine, `${keyPrefix}-text-${cursor}`));
  }

  return nodes;
}

function renderMessageFormatting(text: string, mine: boolean, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const formatPattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*\n]+)\*)|(_([^_\n]+)_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = formatPattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    const code = match[2];
    const strong = match[4] || match[6];
    const emphasis = match[8] || match[10];
    if (code) {
      nodes.push(
        <Text key={`${keyPrefix}-code-${match.index}`} style={[styles.messageCode, mine && styles.messageCodeMine]}>
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

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function StatusSkeleton() {
  const { isDarkTheme } = useAppTheme();
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
  const { isDarkTheme } = useAppTheme();
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
  const { isDarkTheme } = useAppTheme();
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
  onPress?: () => void;
}) {
  const { isDarkTheme } = useAppTheme();
  return (
    <Pressable accessibilityLabel={label} onPress={onPress} style={[styles.iconButton, isDarkTheme && styles.iconButtonDark]}>
      <Ionicons color={isDarkTheme ? "#FFFFFF" : colors.ink} name={icon} size={21} />
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
  const { isDarkTheme } = useAppTheme();
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
  const { isDarkTheme, toggleTheme } = useAppTheme();
  const { width } = useWindowDimensions();
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
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
    setNotice("");
    setResendSeconds(0);
  }

  function editLoginDetails() {
    setOtp("");
    setOtpSent(false);
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
      if (DEV_OTP_ENABLED) {
        setNotice(`${result.error.message} You can use ${DEV_BYPASS_OTP} for local testing.`);
        setOtpSent(true);
        setResendSeconds(OTP_RESEND_SECONDS);
      } else {
        setNotice(result.error.message);
      }
      return;
    }

    setPhone(normalizedPhone);
    setDisplayName(normalizedName);
    setOtp("");
    setOtpSent(true);
    setResendSeconds(OTP_RESEND_SECONDS);
    setNotice(
      DEV_OTP_ENABLED
        ? `${isResend ? "New OTP sent" : "OTP sent"} to your phone. Enter the code, or use ${DEV_BYPASS_OTP} for local testing.`
        : `${isResend ? "New OTP sent" : "OTP sent"} to your phone. Enter the code to continue.`,
    );
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
    ? `We sent a one-time code to ${phone || "your phone"}.`
    : authMode === "signup"
      ? "Build your AI-ready messaging profile with a verified phone number."
      : "Sign in with your phone OTP to continue your encrypted workspace.";
  const primaryLabel = otpSent ? "Verify and continue" : authMode === "signup" ? "Create account" : "Send phone OTP";
  const resendLabel = resendSeconds > 0 ? `Resend in ${resendSeconds}s` : "Resend OTP";
  const authIconColor = isDarkTheme ? colors.accent : colors.primaryDark;
  const authPlaceholderColor = isDarkTheme ? "rgba(255,255,255,0.52)" : "rgba(23,18,36,0.42)";
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
          <View style={[styles.loginGlow, !isDarkTheme && styles.loginGlowLight]} />
          {!isAuthWide ? <AuthSignalScene /> : null}
          <View style={[styles.loginContent, isAuthWide && styles.loginContentWide]}>
            <View style={[styles.loginAuthColumn, isAuthWide && styles.loginAuthColumnWide]}>
              <View style={styles.loginHero}>
                <View style={styles.loginTopRow}>
                  <OrbitaBrand inverse={isDarkTheme} />
                  <Pressable
                    accessibilityLabel={isDarkTheme ? "Switch to light theme" : "Switch to dark theme"}
                    onPress={toggleTheme}
                    style={[styles.authThemeButton, !isDarkTheme && styles.authThemeButtonLight]}
                  >
                    <Ionicons color={authIconColor} name={isDarkTheme ? "sunny-outline" : "moon-outline"} size={18} />
                  </Pressable>
                </View>
                <View style={[styles.loginBadge, !isDarkTheme && styles.loginBadgeLight]}>
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
                      style={[
                        styles.authModeButton,
                        authMode === "signin" && styles.authModeButtonActive,
                        !isDarkTheme && authMode === "signin" && styles.authModeButtonActiveLight,
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
                      style={[
                        styles.authModeButton,
                        authMode === "signup" && styles.authModeButtonActive,
                        !isDarkTheme && authMode === "signup" && styles.authModeButtonActiveLight,
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
                      <Pressable disabled={loading || resendSeconds > 0} onPress={() => requestOtp(true)} style={styles.textActionButton}>
                        <Text
                          style={[
                            styles.textAction,
                            !isDarkTheme && styles.textActionLight,
                            (loading || resendSeconds > 0) && styles.textActionDisabled,
                            !isDarkTheme && (loading || resendSeconds > 0) && styles.textActionDisabledLight,
                          ]}
                        >
                          {resendLabel}
                        </Text>
                      </Pressable>
                      <Pressable disabled={loading} onPress={editLoginDetails} style={styles.textActionButton}>
                        <Text style={[styles.textAction, !isDarkTheme && styles.textActionLight]}>Edit details</Text>
                      </Pressable>
                    </View>
                  </>
                ) : null}
                <Pressable
                  disabled={loading || !hasSupabaseConfig}
                  onPress={otpSent ? verifyOtp : () => requestOtp(false)}
                  style={[styles.loginButton, (loading || !hasSupabaseConfig) && styles.buttonDisabled]}
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
                {notice ? <Text style={[styles.loginNoticeText, !isDarkTheme && styles.loginNoticeTextLight]}>{notice}</Text> : null}
                {!hasSupabaseConfig ? (
                  <Text style={[styles.loginHintText, !isDarkTheme && styles.loginHintTextLight]}>
                    Required: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.
                  </Text>
                ) : null}
              </View>
            </View>
            {isAuthWide ? (
              <View style={[styles.authVisualPanel, !isDarkTheme && styles.authVisualPanelLight]}>
                <View style={[styles.authVisualHalo, !isDarkTheme && styles.authVisualHaloLight]} />
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
  const { isDarkTheme } = useAppTheme();
  const isWide = width >= 840;
  const [activeTab, setActiveTab] = useState<Tab>("chats");
  const [appLifecycleState, setAppLifecycleState] = useState(AppState.currentState);
  const [profile, setProfile] = useState<BackendProfile | null>(null);
  const [contacts, setContacts] = useState<BackendProfile[]>([]);
  const [conversations, setConversations] = useState<BackendConversation[]>([]);
  const [statuses, setStatuses] = useState<BackendStatus[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedMessages, setSelectedMessages] = useState<ChatMessage[]>([]);
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
  const [agentThinkingFor, setAgentThinkingFor] = useState<Record<string, string>>({});
  const [typingByConversation, setTypingByConversation] = useState<Record<string, Record<string, TypingParticipant>>>({});
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const [forwardPickerOpen, setForwardPickerOpen] = useState(false);
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
  const pushTokenRef = useRef<string | null>(null);
  const openingAgentFromFabRef = useRef(false);
  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;
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
          lastMessage: message,
          updatedAt: message.createdAt,
          unreadCount: shouldIncrementUnread ? conversation.unreadCount + 1 : conversation.unreadCount,
        };
      }),
    );

    if (message.senderId !== profileId && agentThinkingForRef.current[message.conversationId]) {
      setAgentThinkingFor((currentThinking) => {
        const next = { ...currentThinking };
        delete next[message.conversationId];
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
        const gotAgentReply = merged.some(
          (message) => message.senderId !== profileId && Date.parse(message.createdAt) >= since,
        );
        if (gotAgentReply) {
          setAgentThinkingFor((currentThinking) => {
            const next = { ...currentThinking };
            delete next[conversationId];
            return next;
          });
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
      onRealtimeEvent: (conversationId) => {
        refreshActiveConversation(conversationId && conversationId === selectedId ? conversationId : "");
      },
      onUserEvent: () => {
        scheduleBootstrapRefresh();
      },
    });
  }, [applyRealtimeMessage, conversationKey, profileId, scheduleBootstrapRefresh, scheduleMessageRefresh, selectedId]);

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
      if (selectedId) void loadMessages(selectedId);
    });

    return () => subscription.remove();
  }, [loadBootstrap, loadMessages, selectedId, stopTyping]);

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
  }, [selectedId]);

  const selectConversation = useCallback((conversationId: string) => {
    if (!conversationId) {
      setSelectedId("");
      setSelectedMessages([]);
      setLoadingMessagesFor("");
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

  const existingDirectByContactId = useMemo(() => {
    const directMap = new Map<string, BackendConversation>();
    conversations.forEach((conversation) => {
      if (conversation.kind !== "direct") return;
      const peer = conversation.participants.find((participant) => participant.id !== profileId);
      if (peer) directMap.set(peer.id, conversation);
    });
    return directMap;
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
      .filter((contact) => !existingDirectByContactId.has(contact.id))
      .map((contact) => ({
        avatarUrl: contact.avatarUrl,
        id: contact.id,
        isBot: contact.about?.trim().toLowerCase() === "task manager agent",
        type: "contact" as const,
        title: contact.displayName,
        subtitle: contact.phone || "Create direct chat",
      }));

    return [...conversationTargets, ...extraContactTargets];
  }, [contacts, conversations, existingDirectByContactId, selectedId]);

  const chatListContacts = useMemo<ChatListContact[]>(
    () =>
      contactsWithDefaultAgent.map((contact) => ({
        ...contact,
        existingConversationId: existingDirectByContactId.get(contact.id)?.id,
      })),
    [contactsWithDefaultAgent, existingDirectByContactId],
  );
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
      const existingConversationId = existingDirectByContactId.get(otherUserId)?.id;
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
    const modelText = (modelBodyOverride ?? body).trim();
    if (!selected || !profile || (!text && !modelText && !attachment)) return;
    stopTyping(selected.id);
    let resolvedKind = kind;
    if (attachment) {
      resolvedKind = attachment.kind;
    }

    const tempId = `local-${Date.now()}`;
    const optimisticMessage: ChatMessage = {
      id: tempId,
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
              url: attachment.uri,
            },
          ]
        : [],
      forwardedFrom: null,
      createdAt: new Date().toISOString(),
      status: "sent",
      localState: "sending",
    };

    setDraft("");
    setComposerAttachment(null);
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
    if (isTaskManagerAgentConversation(selected)) {
      setAgentThinkingFor((current) => ({ ...current, [selected.id]: optimisticMessage.createdAt }));
    }

    try {
      let attachmentId: string | undefined;
      if (attachment) {
        const uploadResult = await messengerApi.uploadMedia({
          kind: attachment.kind,
          durationMs: attachment.durationMs,
          file:
            Platform.OS === "web"
              ? await (await fetch(attachment.uri)).blob().then((blob) => new File([blob], attachment.name, { type: attachment.mimeType }))
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
        ...(modelText && modelText !== text ? { taskManagerText: modelText } : {}),
      });
      setSelectedMessages((current) => {
        const withoutTemp = current.filter(
          (message) => message.id !== tempId && message.id !== result.message.id,
        );
        const next = [...withoutTemp, result.message];
        messagesByConversationRef.current = {
          ...messagesByConversationRef.current,
          [selected.id]: next,
        };
        return next;
      });
      void replaceCachedMessage(profile.id, selected.id, tempId, result.message).catch(() => undefined);
      updateConversationPreview(result.message);
      void hapticMessageSent();
      if (isTaskManagerAgentConversation(selected)) {
        if (result.taskManagerForward?.forwarded === false) {
          setAgentThinkingFor((current) => {
            const next = { ...current };
            delete next[selected.id];
            return next;
          });
          setError(userFacingTaskManagerError(result.taskManagerForward.reason));
        } else {
          setAgentThinkingFor((current) => ({ ...current, [selected.id]: result.message.createdAt }));
        }
      }
      scheduleBootstrapRefresh();
      scheduleMessageRefresh(selected.id);
    } catch (nextError) {
      if (attachment) setComposerAttachment(attachment);
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
      if (isTaskManagerAgentConversation(selected)) {
        const raw = nextError instanceof Error ? nextError.message : "Unable to send message.";
        setError(userFacingTaskManagerError(raw));
      } else {
        setError(nextError instanceof Error ? nextError.message : "Unable to send message.");
      }
    }
  }

  function changeTab(tab: Tab) {
    setActiveTab(tab);
    if (tab !== "chats") selectConversation("");
  }

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
            <Pressable onPress={signOut} style={styles.secondaryButton}>
              <Text style={styles.secondaryText}>Sign out</Text>
            </Pressable>
            <Pressable onPress={retryBootstrap} style={styles.primaryButton}>
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
        {isWide ? <Sidebar activeTab={activeTab} onChange={changeTab} onNewChat={() => setNewChatOpen(true)} /> : null}
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
                contacts={chatListContacts}
                conversations={conversations}
                isWide={isWide}
                onCreateGroup={() => setGroupOpen(true)}
                onNewChat={() => setNewChatOpen(true)}
                onNewStatus={() => setStatusOpen(true)}
                onOpenProfile={() => setProfileOpen(true)}
                onOpenContact={openContactConversation}
                onSignOut={signOut}
                onSyncDeviceContacts={syncDeviceContacts}
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
                onForwardMessage={(message) => {
                  setForwardingMessage(message);
                  setForwardPickerOpen(true);
                }}
                onLoadOlder={() => loadOlderMessages(selected.id)}
                onOpenAttachmentMenu={() => setAttachmentMenuOpen(true)}
                onTakePhoto={() => void takePhotoAttachment()}
                onBack={() => selectConversation("")}
                onRemoveAttachment={() => setComposerAttachment(null)}
                onSend={(nextKind, nextBody, nextAttachment, modelBodyOverride) =>
                  sendMessage(nextKind, nextBody, nextAttachment, modelBodyOverride)}
                onSaveContact={() => {
                  if (selectedUnsavedPeer) setSaveContactPeer(selectedUnsavedPeer);
                }}
                setDraft={handleDraftChange}
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
        <BottomTabs activeTab={activeTab} bottomInset={bottomInset} onChange={changeTab} unreadTotal={unreadTotal} />
      ) : null}
      {showAgentFab ? (
        <Pressable
          accessibilityLabel="Open agent chat"
          onPress={() => {
            void openAgentChatFromFab();
          }}
          style={[
            styles.agentFab,
            isDarkTheme && styles.agentFabDark,
            { bottom: showBottomTabs ? 66 + bottomInset : 20 + bottomInset },
          ]}
        >
          <Ionicons color={isDarkTheme ? colors.primaryDark : "#FFFFFF"} name="sparkles" size={18} />
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
        contacts={contacts}
        conversation={selected}
        onClose={() => setMembersOpen(false)}
        onSave={async (memberIds) => {
          if (!selected) return;
          await run(async () => {
            await messengerApi.addGroupMembers(selected.id, memberIds);
            setMembersOpen(false);
            await loadBootstrap();
          });
        }}
        visible={membersOpen}
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
  const { isDarkTheme } = useAppTheme();
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
}: {
  activeTab: Tab;
  onChange: (tab: Tab) => void;
  onNewChat: () => void;
}) {
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[styles.sidebar, isDarkTheme && styles.sidebarDark]}>
      <View style={styles.brandMark}>
        <OrbitaLogo size={36} />
      </View>
      <View style={styles.navStack}>
        {tabs.map((tab) => (
          <Pressable
            accessibilityLabel={tab.label}
            key={tab.id}
            onPress={() => onChange(tab.id)}
            style={[styles.navItem, activeTab === tab.id && styles.navItemActive]}
          >
            <Ionicons color={activeTab === tab.id ? colors.primaryDark : "rgba(255,255,255,0.76)"} name={tab.icon} size={22} />
            <Text style={[styles.navLabel, activeTab === tab.id && styles.navLabelActive]}>{tab.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable accessibilityLabel="New chat" onPress={onNewChat} style={styles.composeButton}>
        <Ionicons color="#FFFFFF" name="add" size={26} />
      </Pressable>
    </View>
  );
}

function BottomTabs({
  activeTab,
  bottomInset,
  onChange,
  unreadTotal,
}: {
  activeTab: Tab;
  bottomInset: number;
  onChange: (tab: Tab) => void;
  unreadTotal: number;
}) {
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[styles.bottomTabs, isDarkTheme && styles.bottomTabsDark, { paddingBottom: bottomInset + 8 }]}>
      {tabs.map((tab) => (
        <Pressable accessibilityLabel={tab.label} key={tab.id} onPress={() => onChange(tab.id)} style={styles.bottomTab}>
          <View>
            <Ionicons
              color={activeTab === tab.id ? (isDarkTheme ? colors.accent : colors.primaryDark) : isDarkTheme ? "rgba(255,255,255,0.58)" : colors.muted}
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
  const label = count > 99 ? "99+" : String(count);
  return (
    <View style={[styles.unreadBadge, compact && styles.unreadBadgeCompact]}>
      <Text style={styles.unreadBadgeText}>{label}</Text>
    </View>
  );
}

function Panel({
  activeTab,
  contacts,
  conversations,
  isWide,
  onCreateGroup,
  onOpenContact,
  onNewChat,
  onNewStatus,
  onOpenProfile,
  onSelect,
  onSignOut,
  onSyncDeviceContacts,
  onUploadProfilePhoto,
  isSyncingDeviceContacts,
  isUploadingProfilePhoto,
  profile,
  selectedId,
  settingsNotice,
  statuses,
}: {
  activeTab: Tab;
  contacts: ChatListContact[];
  conversations: BackendConversation[];
  isWide: boolean;
  onCreateGroup: () => void;
  onOpenContact: (contactId: string) => void;
  onNewChat: () => void;
  onNewStatus: () => void;
  onOpenProfile: () => void;
  onSelect: (id: string) => void;
  onSignOut: () => void;
  onSyncDeviceContacts: () => void;
  onUploadProfilePhoto: () => void;
  isSyncingDeviceContacts: boolean;
  isUploadingProfilePhoto: boolean;
  profile: BackendProfile;
  selectedId?: string;
  settingsNotice: string;
  statuses: BackendStatus[];
}) {
  const { isDarkTheme } = useAppTheme();
  if (activeTab === "status") {
    return <StatusPanel isWide={isWide} onNewStatus={onNewStatus} profile={profile} statuses={statuses} />;
  }
  if (activeTab === "contacts") {
    return <ContactsPanel contacts={contacts} isWide={isWide} onCreateGroup={onCreateGroup} onNewChat={onNewChat} />;
  }
  if (activeTab === "calls") {
    return <CallsPanel isWide={isWide} />;
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
      selectedId={selectedId}
    />
  );
}

function ChatsPanel({
  contacts,
  conversations,
  isWide,
  onNewChat,
  onOpenContact,
  onSelect,
  selectedId,
}: {
  contacts: ChatListContact[];
  conversations: BackendConversation[];
  isWide: boolean;
  onNewChat: () => void;
  onOpenContact: (contactId: string) => void;
  onSelect: (id: string) => void;
  selectedId?: string;
}) {
  const { isDarkTheme } = useAppTheme();
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CHAT_PAGE_SIZE);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    setVisibleCount(CHAT_PAGE_SIZE);
  }, [normalizedQuery, conversations.length, contacts.length]);

  const rows = useMemo(() => {
    const conversationRows = conversations
      .filter((conversation) => {
        if (!normalizedQuery) return true;
        return searchableText([
          conversation.title,
          messagePreviewText(conversation.lastMessage),
          ...conversation.participants.map((participant) => participant.displayName),
          ...conversation.participants.map((participant) => participant.phone),
        ]).includes(normalizedQuery);
      })
      .map((conversation) => ({ conversation, id: `conversation-${conversation.id}`, type: "conversation" as const }));

    const contactRows = contacts
      .filter((contact) => !contact.existingConversationId)
      .filter((contact) => {
        if (!normalizedQuery) return true;
        return searchableText([contact.displayName, contact.phone, contact.about]).includes(normalizedQuery);
      })
      .map((contact) => ({ contact, id: `contact-${contact.id}`, type: "contact" as const }));

    return [...conversationRows, ...contactRows];
  }, [contacts, conversations, normalizedQuery]);

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
            <Pressable onPress={() => setQuery("")}>
              <Ionicons color={isDarkTheme ? "rgba(255,255,255,0.58)" : colors.muted} name="close-circle" size={18} />
            </Pressable>
          ) : null}
        </View>
        <Pressable accessibilityLabel="Add contact" onPress={onNewChat} style={[styles.searchAddButton, isDarkTheme && styles.searchAddButtonDark]}>
          <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name="person-add-outline" size={20} />
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
                    style={[
                      styles.chatRow,
                      isDarkTheme && styles.chatRowDark,
                      selectedId === conversation.id && styles.chatRowActive,
                      isDarkTheme && selectedId === conversation.id && styles.chatRowActiveDark,
                    ]}
                  >
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

              const contact = row.contact;
              return (
                <Pressable
                  key={row.id}
                  onPress={() => onOpenContact(contact.id)}
                  style={[styles.chatRow, isDarkTheme && styles.chatRowDark]}
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
                    <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name="chatbubble-outline" size={21} />
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
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[styles.panelTitle, isDarkTheme && styles.panelTitleDark]}>
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
  onForwardMessage,
  onOpenAttachmentMenu,
  onTakePhoto,
  draft,
  setDraft,
  onRemoveAttachment,
  onSaveContact,
  onSend,
  onBack,
  onAddMembers,
  isWide,
  loadingOlder,
  onLoadOlder,
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
  onForwardMessage: (message: ChatMessage) => void;
  onOpenAttachmentMenu: () => void;
  onTakePhoto: () => void;
  draft: string;
  setDraft: (value: string) => void;
  onRemoveAttachment: () => void;
  onSaveContact: () => void;
  onSend: (
    kind?: BackendMessage["kind"],
    body?: string,
    attachment?: ComposerAttachment | null,
    modelBodyOverride?: string,
  ) => Promise<void> | void;
  onBack: () => void;
  onAddMembers: () => void;
  isWide: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  typingText: string;
  unsavedPeer: UnsavedPeer | null;
}) {
  const { isDarkTheme } = useAppTheme();
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView | null>(null);
  const keyboardInset = useKeyboardClearance(!isWide);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 160);
  const previewPlayer = useMemo(() => createAudioPlayer(), []);
  const previewStatus = useAudioPlayerStatus(previewPlayer);
  const [voiceComposerOpen, setVoiceComposerOpen] = useState(false);
  const [voiceAttachment, setVoiceAttachment] = useState<ComposerAttachment | null>(null);
  const [quickPromptOpen, setQuickPromptOpen] = useState(false);
  const canTriggerOlderRef = useRef(false);
  const contentHeightRef = useRef(0);
  const isNearLatestRef = useRef(true);
  const lastOlderTriggerAtRef = useRef(0);
  const preserveOffsetOnNextSizeChangeRef = useRef(false);
  const previousLastMessageIdRef = useRef("");
  const previousMessageCountRef = useRef(0);
  const scrollOffsetYRef = useRef(0);
  const waitingForOlderLoadRef = useRef(false);
  const isAgentConversation = isTaskManagerAgentConversation(conversation);

  const scrollToLatest = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated });
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
    const shouldFollowLatest = lastMessage?.senderId === currentUserId || isNearLatestRef.current;
    if (shouldFollowLatest) scrollToLatest();
  }, [currentUserId, lastMessageId, loadingOlder, messages, scrollToLatest]);

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
    setQuickPromptOpen(false);
  }, [conversation.id]);

  useEffect(() => {
    if (keyboardInset) scrollToLatest(false);
  }, [keyboardInset, scrollToLatest]);

  useEffect(() => {
    return () => {
      previewPlayer.remove();
    };
  }, [previewPlayer]);

  useEffect(() => {
    if (!voiceAttachment?.uri) return;
    previewPlayer.pause();
    previewPlayer.replace(voiceAttachment.uri);
    void previewPlayer.seekTo(0).catch(() => undefined);
  }, [previewPlayer, voiceAttachment]);

  async function startVoiceRecording() {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return;
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
    });
    setVoiceAttachment(null);
    setVoiceComposerOpen(true);
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  async function stopVoiceRecording() {
    await recorder.stop();
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
    });
    const uri = recorder.uri ?? recorderState.url;
    if (!uri) return;
    setVoiceAttachment({
      localId: `voice-${Date.now()}`,
      kind: "voice",
      uri,
      name: `voice-note-${Date.now()}.m4a`,
      mimeType: Platform.OS === "web" ? "audio/webm" : "audio/mp4",
      durationMs: recorderState.durationMillis || null,
    });
  }

  async function discardVoiceAttachment() {
    if (recorderState.isRecording) {
      await recorder.stop().catch(() => undefined);
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "duckOthers",
      }).catch(() => undefined);
    }
    previewPlayer.pause();
    setVoiceAttachment(null);
    setVoiceComposerOpen(false);
  }

  async function sendVoiceAttachment() {
    if (!voiceAttachment) return;
    const pendingVoice = voiceAttachment;
    previewPlayer.pause();
    setVoiceAttachment(null);
    setVoiceComposerOpen(false);
    await onSend("voice", draft, pendingVoice);
  }

  async function sendQuickPrompt(item: (typeof AGENT_QUICK_PROMPTS)[number]) {
    setQuickPromptOpen(false);
    await onSend("text", item.label, null, item.prompt);
  }

  const composerCanSend = Boolean(draft.trim() || attachment);
  const waveformSeed = voiceAttachment?.name || attachment?.name || conversation.id;

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
        !isWide && { paddingBottom: keyboardInset || Math.max(bottomInset, KEYBOARD_COMPOSER_GAP) },
      ]}
    >
      {quickPromptOpen ? (
        <Pressable onPress={() => setQuickPromptOpen(false)} style={styles.quickPromptBackdrop} />
      ) : null}
      <View style={[styles.chatHeader, isDarkTheme && styles.chatHeaderDark]}>
        <View style={[styles.row, styles.chatHeaderMain]}>
          {!isWide ? <IconButton icon="arrow-back" label="Back to chats" onPress={onBack} /> : null}
          <Avatar avatarUrl={conversation.avatarUrl} isBot={isAgentConversation} name={conversation.title} />
          <View style={styles.chatRowBody}>
            <Text numberOfLines={1} style={styles.chatHeaderTitle}>{conversation.title}</Text>
            <Text style={[styles.chatHeaderSub, Boolean(typingText) && styles.chatHeaderSubTyping]}>
              {agentThinking
                ? `${conversation.title.split(" ")[0] || "Agent"} is thinking...`
                : typingText
                  ? typingText
                  : conversation.kind === "group"
                    ? `${conversation.participants.length} members`
                    : "1:1 conversation"}
            </Text>
          </View>
        </View>
        <View style={[styles.headerActions, styles.chatHeaderActions]}>
          {conversation.kind === "group" ? <IconButton icon="person-add-outline" label="Add members" onPress={onAddMembers} /> : null}
          {unsavedPeer ? <IconButton icon="person-add-outline" label="Save contact" onPress={onSaveContact} /> : null}
          <IconButton icon="call-outline" label="Voice call" />
        </View>
      </View>
      <ScrollView
        contentContainerStyle={[styles.messageList, isDarkTheme && styles.messageListDark]}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={handleContentSizeChange}
        onLayout={() => scrollToLatest(false)}
        onScroll={handleMessageScroll}
        scrollEventThrottle={80}
        ref={scrollRef}
      >
        {messagesLoading ? (
          <MessageListSkeleton />
        ) : messages.length ? (
          <>
            {loadingOlder ? (
              <View style={[styles.olderMessagesLoader, isDarkTheme && styles.olderMessagesLoaderDark]}>
                <ActivityIndicator color={isDarkTheme ? colors.accent : colors.primaryDark} size="small" />
              </View>
            ) : null}
            {messages.map((message, index) => {
              const mine = message.senderId === currentUserId;
              const sender = conversation.participants.find((participant) => participant.id === message.senderId);
              const isAudioKind = message.kind === "voice" || message.kind === "audio";
              const previous = messages[index - 1];
              const showDate = !previous || messageDateKey(previous.createdAt) !== messageDateKey(message.createdAt);
              return (
                <View key={message.id} style={styles.messageWithDate}>
                  {showDate ? (
                    <View style={[styles.datePill, isDarkTheme && styles.datePillDark]}>
                      <Text style={[styles.datePillText, isDarkTheme && styles.datePillTextDark]}>{messageDateLabel(message.createdAt)}</Text>
                    </View>
                  ) : null}
                  <View style={[styles.messageWrap, isAudioKind && styles.messageWrapAudio, mine ? styles.messageMine : styles.messageTheirs]}>
                    {!mine && conversation.kind === "group" ? (
                      <Text style={styles.senderName}>{sender?.displayName ?? "Member"}</Text>
                    ) : null}
                    <Pressable
                      onLongPress={() => onForwardMessage(message)}
                      style={[
                        styles.bubble,
                        mine ? styles.mineBubble : styles.theirBubble,
                        isDarkTheme && !mine && styles.theirBubbleDark,
                      ]}
                    >
                      {message.forwardedFrom ? (
                        <View style={styles.forwardedRow}>
                          <Ionicons color={mine ? "rgba(255,255,255,0.78)" : colors.primaryDark} name="arrow-redo-outline" size={13} />
                          <Text style={[styles.forwardedText, mine && styles.forwardedTextMine]}>
                            Forwarded from {message.forwardedFrom.senderName}
                          </Text>
                        </View>
                      ) : null}
                      {message.attachments[0] ? <MessageAttachmentCard attachment={message.attachments[0]} mine={mine} /> : null}
                      {message.body ? <MessageBody mine={mine} text={message.body} /> : null}
                      <View style={styles.messageMeta}>
                        <Text style={[styles.metaText, mine && styles.metaTextMine]}>{formatTime(message.createdAt)}</Text>
                        {mine && message.localState === "sending" ? (
                          <Ionicons color="rgba(255,255,255,0.72)" name="time-outline" size={13} />
                        ) : null}
                        {mine && message.localState === "failed" ? (
                          <Ionicons color={colors.danger} name="alert-circle" size={15} />
                        ) : null}
                        {mine && !message.localState ? (
                          <Ionicons color={colors.primarySoft} name="checkmark-done" size={15} />
                        ) : null}
                      </View>
                    </Pressable>
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
              <ActivityIndicator color={isDarkTheme ? colors.accent : colors.primaryDark} size="small" />
              <Text style={[styles.thinkingText, isDarkTheme && styles.thinkingTextDark]}>Thinking...</Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.composer, isDarkTheme && styles.composerDark]}>
        {isAgentConversation ? (
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
                    style={[styles.quickPromptItem, isDarkTheme && styles.quickPromptItemDark]}
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
              style={[styles.quickPromptButton, isDarkTheme && styles.quickPromptButtonDark]}
            >
              <Ionicons color={isDarkTheme ? "#FFFFFF" : colors.primaryDark} name="help-circle-outline" size={18} />
            </Pressable>
          </View>
        ) : null}
        <Pressable accessibilityLabel="Add attachment" onPress={onOpenAttachmentMenu} style={[styles.composerAccessoryButton, isDarkTheme && styles.composerAccessoryButtonDark]}>
          <Ionicons color={isDarkTheme ? "#FFFFFF" : colors.ink} name="add" size={22} />
        </Pressable>
        <View style={styles.composerBody}>
          {attachment ? (
            <ComposerAttachmentPreview attachment={attachment} onRemove={onRemoveAttachment} />
          ) : null}
        <TextInput
          blurOnSubmit={false}
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
          style={[styles.composerInput, isDarkTheme && styles.composerInputDark, attachment && styles.composerInputWithAttachment]}
          value={draft}
        />
        </View>
        {composerCanSend ? (
          <Pressable
            accessibilityLabel="Send message"
            disabled={!composerCanSend}
            onPress={() => onSend()}
            style={[styles.sendButton, !composerCanSend && styles.buttonDisabled]}
          >
            <Ionicons color="#FFFFFF" name="send" size={20} />
          </Pressable>
        ) : (
          <View style={styles.composerQuickActions}>
            <Pressable
              accessibilityLabel="Take photo"
              onPress={onTakePhoto}
              style={[styles.sendButton, styles.cameraQuickButton, isDarkTheme && styles.cameraQuickButtonDark]}
            >
              <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name="camera-outline" size={20} />
            </Pressable>
            <Pressable accessibilityLabel="Record voice note" onPress={startVoiceRecording} style={styles.sendButton}>
              <Ionicons color="#FFFFFF" name="mic" size={19} />
            </Pressable>
          </View>
        )}
      </View>
      <Modal animationType="slide" onRequestClose={discardVoiceAttachment} transparent visible={voiceComposerOpen}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.voiceComposerCard, keyboardInset ? { marginBottom: keyboardInset } : null]}>
            <Text style={styles.voiceComposerTitle}>Voice Note</Text>
            <View style={styles.voiceWaveCard}>
              <View style={styles.voiceWaveRow}>
                {waveformBars(waveformSeed).map((bar, index) => (
                  <View
                    key={`${waveformSeed}-${index}`}
                    style={[
                      styles.voiceWaveBar,
                      {
                        height: bar,
                        backgroundColor:
                          previewStatus.playing && voiceAttachment
                            ? index < Math.max(1, Math.round(((previewStatus.currentTime || 0) / Math.max(previewStatus.duration || 1, 1)) * 22))
                              ? colors.primaryDark
                              : "#B7AEDF"
                            : index % 2 === 0
                              ? colors.primaryDark
                              : "#C8C1EA",
                      },
                    ]}
                  />
                ))}
              </View>
              <Text style={styles.voiceComposerTime}>
                {voiceAttachment
                  ? formatDurationMs(voiceAttachment.durationMs)
                  : formatDurationMs(recorderState.durationMillis)}
              </Text>
            </View>
            <View style={styles.voiceComposerActions}>
              <Pressable onPress={discardVoiceAttachment} style={styles.voiceMiniButton}>
                <Ionicons color={colors.ink} name="close" size={20} />
              </Pressable>
              {voiceAttachment ? (
                <Pressable
                  onPress={() => {
                    if (previewStatus.playing) {
                      previewPlayer.pause();
                    } else {
                      if ((previewStatus.currentTime || 0) >= (previewStatus.duration || 0)) {
                        void previewPlayer.seekTo(0);
                      }
                      previewPlayer.play();
                    }
                  }}
                  style={styles.voiceRecordButton}
                >
                  <Ionicons color="#FFFFFF" name={previewStatus.playing ? "pause" : "play"} size={22} />
                </Pressable>
              ) : (
                <Pressable
                  onPress={recorderState.isRecording ? stopVoiceRecording : startVoiceRecording}
                  style={styles.voiceRecordButton}
                >
                  <Ionicons color="#FFFFFF" name={recorderState.isRecording ? "stop" : "mic"} size={22} />
                </Pressable>
              )}
              <Pressable
                disabled={!voiceAttachment}
                onPress={sendVoiceAttachment}
                style={[styles.voiceMiniButton, !voiceAttachment && styles.buttonDisabled]}
              >
                <Ionicons color={colors.ink} name="send-outline" size={20} />
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[styles.composerAttachment, isDarkTheme && styles.composerAttachmentDark]}>
      {attachment.kind === "image" ? (
        <Image source={{ uri: attachment.uri }} style={styles.composerAttachmentImage} />
      ) : (
        <View style={[styles.composerAttachmentIcon, isDarkTheme && styles.composerAttachmentIconDark]}>
          <Ionicons
            color={isDarkTheme ? colors.accent : colors.primaryDark}
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
      <Pressable onPress={onRemove} style={styles.composerAttachmentClose}>
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
  if (attachment.kind === "image") {
    return (
      <Pressable onPress={() => openMessageUrl(attachment.url)} style={styles.imageAttachment}>
        <Image source={{ uri: attachment.url }} style={styles.imageAttachmentMedia} />
        <Text numberOfLines={1} style={[styles.attachmentCaption, mine && styles.attachmentCaptionMine]}>
          {attachment.filename}
        </Text>
      </Pressable>
    );
  }

  if (attachment.kind === "voice" || attachment.kind === "audio") {
    return <AudioAttachmentCard attachment={attachment} mine={mine} />;
  }

  return (
    <Pressable onPress={() => openMessageUrl(attachment.url)} style={[styles.documentAttachment, mine && styles.documentAttachmentMine]}>
      <View style={[styles.documentAttachmentIcon, mine && styles.documentAttachmentIconMine]}>
        <Ionicons color={mine ? "#FFFFFF" : colors.primaryDark} name="document-text-outline" size={20} />
      </View>
      <View style={styles.chatRowBody}>
        <Text numberOfLines={1} style={[styles.documentAttachmentTitle, mine && styles.documentAttachmentTitleMine]}>
          {attachment.filename}
        </Text>
        <Text style={[styles.documentAttachmentMeta, mine && styles.documentAttachmentMetaMine]}>
          {formatBytes(attachment.sizeBytes)}
        </Text>
      </View>
      <Ionicons color={mine ? "rgba(255,255,255,0.8)" : colors.primaryDark} name="open-outline" size={18} />
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
  const player = useAudioPlayer(attachment.url);
  const status = useAudioPlayerStatus(player);
  const bars = useMemo(() => waveformBars(attachment.filename || attachment.id), [attachment.filename, attachment.id]);
  const durationLabel = status.duration
    ? formatDurationMs(status.duration * 1000)
    : formatDurationMs(attachment.durationMs);

  return (
    <View style={[styles.audioAttachment, mine && styles.audioAttachmentMine]}>
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
        style={[styles.audioPlayButton, mine && styles.audioPlayButtonMine]}
      >
        <Ionicons color={mine ? colors.primaryDark : "#FFFFFF"} name={status.playing ? "pause" : "play"} size={17} />
      </Pressable>
      <View style={styles.chatRowBody}>
        <View style={styles.audioWaveRow}>
          {bars.map((bar, index) => {
            const playedRatio = status.duration ? (status.currentTime || 0) / Math.max(status.duration, 0.01) : 0;
            const isPlayed = index / bars.length <= playedRatio;
            return (
              <View
                key={`${attachment.id}-${index}`}
                style={[
                  styles.audioWaveBar,
                  {
                    height: bar,
                    backgroundColor: mine
                      ? isPlayed
                        ? "#FFFFFF"
                        : "rgba(255,255,255,0.45)"
                      : isPlayed
                        ? colors.primaryDark
                        : "#C7C0E5",
                  },
                ]}
              />
            );
          })}
        </View>
        <Text style={[styles.audioDuration, mine && styles.audioDurationMine]}>{durationLabel}</Text>
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
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Status" actionIcon="add-circle-outline" actionLabel="New status" onAction={onNewStatus} />
      <ScrollView contentContainerStyle={[styles.listContent, isDarkTheme && styles.listContentDark]}>
        <Pressable onPress={onNewStatus} style={[styles.statusComposer, isDarkTheme && styles.statusComposerDark]}>
          <Avatar avatarUrl={profile.avatarUrl} name={profile.displayName} size={54} />
          <View style={styles.chatRowBody}>
            <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>My status</Text>
            <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>Create a text status backed by Supabase.</Text>
          </View>
          <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name="add-circle" size={24} />
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
}: {
  contacts: BackendProfile[];
  isWide: boolean;
  onCreateGroup: () => void;
  onNewChat: () => void;
}) {
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Contacts" actionIcon="person-add-outline" actionLabel="Add contact" onAction={onNewChat} />
      <Pressable onPress={onCreateGroup} style={[styles.quickAction, isDarkTheme && styles.quickActionDark]}>
        <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name="people-outline" size={22} />
        <Text style={[styles.quickActionText, isDarkTheme && styles.quickActionTextDark]}>New group</Text>
      </Pressable>
      <ScrollView contentContainerStyle={[styles.listContent, isDarkTheme && styles.listContentDark]}>
        {contacts.length ? contacts.map((contact) => (
          <View key={contact.id} style={[styles.contactRow, isDarkTheme && styles.contactRowDark]}>
            <Avatar
              avatarUrl={contact.avatarUrl}
              isBot={contact.about?.trim().toLowerCase() === "task manager agent"}
              name={contact.displayName}
            />
            <View style={styles.chatRowBody}>
              <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>{contact.displayName}</Text>
              <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>{contact.phone ?? contact.about}</Text>
            </View>
          </View>
        )) : <EmptyState icon="person-add-outline" title="No contacts" copy="Add contacts by phone number to start 1:1 chats or groups." />}
      </ScrollView>
    </View>
  );
}

function CallsPanel({ isWide }: { isWide: boolean }) {
  const { isDarkTheme } = useAppTheme();
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
  const { isDarkTheme, themeMode, toggleTheme } = useAppTheme();
  return (
    <View style={[styles.listPanel, isDarkTheme && styles.listPanelDark, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Settings" actionIcon="create-outline" actionLabel="Edit profile" onAction={onOpenProfile} />
      <ScrollView contentContainerStyle={[styles.settingsContent, isDarkTheme && styles.listContentDark]}>
      <View style={[styles.profileCard, isDarkTheme && styles.profileCardDark]}>
        <Pressable
          disabled={isUploadingProfilePhoto}
          hitSlop={10}
          onPress={onUploadProfilePhoto}
          style={[styles.profileAvatarButton, isUploadingProfilePhoto && styles.disabledPressable]}
        >
          <Avatar avatarUrl={profile.avatarUrl} name={profile.displayName} size={64} />
          <View style={[styles.profileAvatarBadge, isDarkTheme && styles.profileAvatarBadgeDark]}>
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
      <Pressable onPress={toggleTheme} style={[styles.settingRow, isDarkTheme && styles.settingRowDark]}>
        <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name={isDarkTheme ? "moon" : "sunny-outline"} size={22} />
        <View style={styles.chatRowBody}>
          <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>Theme</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>
            {themeMode === "dark" ? "Dark AI signal theme" : "Light Orbita theme"}
          </Text>
        </View>
        <View style={[styles.themeSwitch, isDarkTheme && styles.themeSwitchOn]}>
          <View style={[styles.themeSwitchKnob, isDarkTheme && styles.themeSwitchKnobOn]} />
        </View>
      </Pressable>
      <Pressable onPress={onOpenProfile} style={[styles.settingRow, isDarkTheme && styles.settingRowDark]}>
        <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name="person-circle-outline" size={22} />
        <View style={styles.chatRowBody}>
          <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>Profile</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>Edit your display name and status line</Text>
        </View>
      </Pressable>
      <Pressable onPress={onNewChat} style={[styles.settingRow, isDarkTheme && styles.settingRowDark]}>
        <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name="person-add-outline" size={22} />
        <View style={styles.chatRowBody}>
          <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>Add contact</Text>
          <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>Start a chat by phone number</Text>
        </View>
      </Pressable>
      {notice ? <Text style={[styles.settingsNotice, isDarkTheme && styles.settingsNoticeDark]}>{notice}</Text> : null}
      {[
        ["key-outline", "Account", "Phone OTP session stored by Supabase Auth"],
        ["lock-closed-outline", "Privacy", "Profile and contact visibility enforced by RLS"],
        ["cloud-upload-outline", "Storage", "Media buckets are configured in Supabase"],
      ].map(([icon, title, copy]) => (
        <View key={title} style={[styles.settingRow, isDarkTheme && styles.settingRowDark]}>
          <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name={icon as keyof typeof Ionicons.glyphMap} size={22} />
          <View style={styles.chatRowBody}>
            <Text style={[styles.chatTitle, isDarkTheme && styles.chatTitleDark]}>{title}</Text>
            <Text style={[styles.chatPreview, isDarkTheme && styles.chatPreviewDark]}>{copy}</Text>
          </View>
        </View>
      ))}
      <Pressable onPress={onSignOut} style={[styles.settingRow, styles.settingDangerRow, isDarkTheme && styles.settingRowDark]}>
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
  return (
    <View style={styles.desktopEmpty}>
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
  const { isDarkTheme } = useAppTheme();
  return (
    <View style={[styles.emptyState, compact && styles.emptyCompact]}>
      <View style={[styles.emptyIcon, isDarkTheme && styles.emptyIconDark]}>
        <Ionicons color={isDarkTheme ? colors.accent : colors.primaryDark} name={icon} size={28} />
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
  const [phone, setPhone] = useState("");
  const [nickname, setNickname] = useState("");
  const [notice, setNotice] = useState("");

  async function addContact() {
    try {
      await messengerApi.addContactByPhone(phone, nickname.trim() || undefined);
      setPhone("");
      setNickname("");
      setNotice("Contact added.");
      await onContactAdded();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to add contact.");
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
            <Pressable onPress={addContact} style={[styles.primaryButton, styles.fullWidthButton]}>
              <Text style={styles.primaryText}>Add contact</Text>
            </Pressable>
          </View>
          {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}
          <ScrollView contentContainerStyle={styles.newChatContactListContent} style={styles.newChatContactList}>
            {contacts.length ? contacts.map((contact) => (
              <Pressable key={contact.id} onPress={() => onOpenConversation(contact.id)} style={styles.newChatContactRow}>
                <Avatar
                  avatarUrl={contact.avatarUrl}
                  isBot={contact.about?.trim().toLowerCase() === "task manager agent"}
                  name={contact.displayName}
                />
                <View style={styles.chatRowBody}>
                  <Text numberOfLines={1} style={styles.chatTitle}>{contact.displayName}</Text>
                  <Text numberOfLines={1} style={styles.chatPreview}>{contact.phone}</Text>
                </View>
                <Ionicons color={colors.primaryDark} name="chatbubble-outline" size={21} />
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
            <Ionicons color={colors.primaryDark} name="call-outline" size={20} />
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

function ContactPicker({
  contacts,
  selected,
  toggle,
}: {
  contacts: BackendProfile[];
  selected: string[];
  toggle: (id: string) => void;
}) {
  return (
    <ScrollView style={styles.modalList}>
      {contacts.length ? contacts.map((contact) => (
        <Pressable key={contact.id} onPress={() => toggle(contact.id)} style={styles.modalRow}>
          <Avatar
            avatarUrl={contact.avatarUrl}
            isBot={contact.about?.trim().toLowerCase() === "task manager agent"}
            name={contact.displayName}
          />
          <View style={styles.chatRowBody}>
            <Text style={styles.chatTitle}>{contact.displayName}</Text>
            <Text style={styles.chatPreview}>{contact.phone}</Text>
          </View>
          <Ionicons color={selected.includes(contact.id) ? colors.primaryDark : colors.faint} name={selected.includes(contact.id) ? "checkbox" : "square-outline"} size={23} />
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
            style={styles.attachmentMenuRow}
          >
            <View style={styles.attachmentMenuIcon}>
              <Ionicons color={colors.primaryDark} name={action.icon} size={20} />
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
              style={styles.modalRow}
            >
              <Avatar avatarUrl={target.avatarUrl} isBot={Boolean(target.isBot)} name={target.title} />
              <View style={styles.chatRowBody}>
                <Text style={styles.chatTitle}>{target.title}</Text>
                <Text style={styles.chatPreview}>{target.subtitle}</Text>
              </View>
              <Ionicons
                color={selected ? colors.primaryDark : colors.faint}
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
  onSubmit?: () => void;
  submitLabel?: string;
}) {
  return (
    <View style={styles.modalActions}>
      <Pressable onPress={onCancel} style={styles.secondaryButton}>
        <Text style={styles.secondaryText}>Cancel</Text>
      </Pressable>
      {onSubmit ? (
        <Pressable disabled={disabled} onPress={disabled ? undefined : onSubmit} style={[styles.primaryButton, disabled && styles.buttonDisabled]}>
          <Text style={styles.primaryText}>{submitLabel ?? "Save"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.page },
  safeDark: { backgroundColor: "#101421" },
  loadingScreen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  loadingScreenDark: { backgroundColor: "#101421" },
  loadingLabel: { color: colors.muted, fontSize: 14, fontWeight: "700" },
  loadingLabelDark: { color: "rgba(255,255,255,0.70)" },
  logoFrame: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#15172A",
    borderWidth: 1,
    borderColor: "rgba(242,244,123,0.38)",
    shadowColor: "#33D6FF",
    shadowOpacity: 0.26,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  logoCore: {
    position: "absolute",
    backgroundColor: "rgba(122,94,214,0.72)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  logoNode: { position: "absolute", backgroundColor: colors.accent },
  logoNodeTop: { top: "17%", right: "24%" },
  logoNodeLeft: { left: "20%", bottom: "24%", backgroundColor: "#55D6FF" },
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
    backgroundColor: "rgba(242,244,123,0.55)",
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  brandTitle: { color: colors.ink, fontSize: 25, fontWeight: "900" },
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
    backgroundColor: "#101421",
    overflow: "hidden",
  },
  loginScreenLight: { backgroundColor: "#F4F7FA" },
  loginBackdropGrid: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.22,
    backgroundColor: "#161C2D",
  },
  loginBackdropGridLight: { opacity: 1, backgroundColor: "#F4F7FA" },
  loginGlow: {
    position: "absolute",
    width: 330,
    height: 330,
    right: -128,
    top: -72,
    borderRadius: 165,
    backgroundColor: "rgba(85,214,255,0.16)",
  },
  loginGlowLight: { backgroundColor: "rgba(122,94,214,0.14)" },
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
    borderColor: "rgba(101,81,196,0.14)",
    backgroundColor: "rgba(255,255,255,0.74)",
  },
  authScanLine: {
    position: "absolute",
    left: 18,
    right: 18,
    height: 2,
    borderRadius: 999,
    backgroundColor: "rgba(242,244,123,0.62)",
  },
  authScanLineLight: { backgroundColor: "rgba(101,81,196,0.34)" },
  authNode: {
    position: "absolute",
    width: 9,
    height: 9,
    borderRadius: 999,
    backgroundColor: "#55D6FF",
  },
  authNodeLight: { backgroundColor: "#6551C4" },
  authNodeOne: { left: 26, top: 38 },
  authNodeTwo: { right: 32, top: 60, backgroundColor: colors.accent },
  authNodeTwoLight: { backgroundColor: "#55D6FF" },
  authNodeThree: { left: 44, bottom: 38, backgroundColor: "#FFFFFF" },
  authNodeThreeLight: { backgroundColor: colors.primaryDark },
  authTrace: {
    position: "absolute",
    height: 1,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  authTraceLight: { backgroundColor: "rgba(101,81,196,0.18)" },
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
    borderColor: "rgba(101,81,196,0.14)",
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
    borderColor: "rgba(101,81,196,0.16)",
  },
  loginBadgeText: { color: "rgba(255,255,255,0.82)", fontSize: 12, fontWeight: "800" },
  loginBadgeTextLight: { color: colors.primaryDark },
  loginTitle: {
    color: "#FFFFFF",
    fontSize: 38,
    lineHeight: 43,
    fontWeight: "900",
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
    borderColor: "rgba(101,81,196,0.14)",
    backgroundColor: "rgba(255,255,255,0.88)",
    shadowColor: "#6551C4",
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
    borderColor: "rgba(101,81,196,0.14)",
    backgroundColor: "rgba(255,255,255,0.62)",
  },
  authVisualHalo: {
    position: "absolute",
    width: 390,
    height: 390,
    borderRadius: 195,
    backgroundColor: "rgba(85,214,255,0.12)",
  },
  authVisualHaloLight: { backgroundColor: "rgba(122,94,214,0.10)" },
  authVisualRail: {
    position: "absolute",
    height: 2,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.20)",
  },
  authVisualRailLight: { backgroundColor: "rgba(101,81,196,0.18)" },
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
  authModeSwitchLight: { backgroundColor: "#E9EDF4" },
  authModeButton: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 12 },
  authModeButtonActive: { backgroundColor: "#FFFFFF" },
  authModeButtonActiveLight: { backgroundColor: colors.primaryDark },
  authModeText: { color: "rgba(255,255,255,0.62)", fontSize: 14, fontWeight: "900" },
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
    backgroundColor: "rgba(10,14,26,0.64)",
  },
  inputShellLight: {
    borderColor: "rgba(101,81,196,0.14)",
    backgroundColor: "#F7F8FB",
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
  textAction: { color: colors.accent, fontSize: 13, fontWeight: "900" },
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
    backgroundColor: "#6D5CF6",
  },
  loginButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  buttonDisabled: { opacity: 0.55 },
  loginNoticeText: { color: colors.accent, fontSize: 13, fontWeight: "800", lineHeight: 18 },
  loginNoticeTextLight: { color: colors.primaryDark },
  loginHintText: { color: "rgba(255,255,255,0.58)", fontSize: 12, lineHeight: 18 },
  loginHintTextLight: { color: colors.muted },
  noticeText: { color: colors.primaryDark, fontSize: 13, fontWeight: "700" },
  hintText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  appFrame: { flex: 1, flexDirection: "row", backgroundColor: colors.page },
  appFrameDark: { backgroundColor: "#101421" },
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
  sidebarDark: { backgroundColor: "#101421", borderRightColor: "rgba(255,255,255,0.10)" },
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
  workspaceDark: { backgroundColor: "#101421" },
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
  headerDark: { borderBottomColor: "rgba(255,255,255,0.10)", backgroundColor: "#101421" },
  headerMobile: { minHeight: 62, paddingHorizontal: 16 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  errorBar: { color: colors.danger, backgroundColor: "#FFF3F3", paddingHorizontal: 14, paddingVertical: 8 },
  content: { flex: 1, flexDirection: "row", padding: 18, gap: 18 },
  contentDark: { backgroundColor: "#101421" },
  contentMobile: { padding: 0, paddingBottom: 72, backgroundColor: colors.page },
  contentMobileDark: { backgroundColor: "#101421" },
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
    backgroundColor: "#151A2A",
    shadowColor: "#000000",
    shadowOpacity: 0.25,
  },
  mobilePanel: { flex: 1, width: "100%", borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0, borderTopWidth: 0 },
  panelTitle: {
    minHeight: 58,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.primaryDark,
  },
  panelTitleDark: { backgroundColor: "#171E31", borderBottomColor: "rgba(242,244,123,0.12)", borderBottomWidth: 1 },
  panelHeading: { color: "#FFFFFF", fontSize: 22, fontWeight: "900", letterSpacing: 0.2 },
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
  chatSearchHeaderDark: { backgroundColor: "#171E31", borderBottomColor: "rgba(242,244,123,0.12)" },
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
    borderColor: "rgba(101,81,196,0.14)",
  },
  searchAddButtonDark: { backgroundColor: "rgba(242,244,123,0.12)", borderColor: "rgba(242,244,123,0.20)" },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
    borderWidth: 1,
    borderColor: "rgba(101,81,196,0.12)",
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
  bottomTabsDark: { borderTopColor: "rgba(255,255,255,0.10)", backgroundColor: "#101421" },
  bottomTab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2 },
  bottomTabLabel: { color: colors.muted, fontSize: 10, fontWeight: "800" },
  bottomTabLabelDark: { color: "rgba(255,255,255,0.58)" },
  bottomTabLabelActive: { color: colors.primaryDark },
  bottomTabLabelActiveDark: { color: colors.accent },
  listContent: { padding: 12, gap: 10 },
  listContentDark: { backgroundColor: "#151A2A" },
  listFooterText: { color: colors.muted, fontSize: 12, fontWeight: "700", textAlign: "center", paddingVertical: 8 },
  listFooterTextDark: { color: "rgba(255,255,255,0.52)" },
  skeletonBlock: { backgroundColor: "#DDD7EB" },
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
  skeletonBubbleOutgoing: { alignSelf: "flex-end", backgroundColor: "rgba(101,81,196,0.30)", borderTopRightRadius: 4 },
  skeletonBubbleIncomingDark: { backgroundColor: "#1B2235", borderColor: "rgba(255,255,255,0.08)", borderWidth: 1 },
  skeletonBubbleOutgoingDark: { backgroundColor: "rgba(122,94,214,0.44)" },
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
    borderColor: "rgba(122,94,214,0.12)",
    backgroundColor: "rgba(255,255,255,0.84)",
  },
  chatRowDark: { borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.06)" },
  chatRowActive: { backgroundColor: colors.accentSoft, borderColor: "rgba(122,94,214,0.20)" },
  chatRowActiveDark: { backgroundColor: "rgba(242,244,123,0.12)", borderColor: "rgba(242,244,123,0.26)" },
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
    borderColor: "rgba(101,81,196,0.38)",
    backgroundColor: "rgba(101,81,196,0.08)",
  },
  botAvatarRing: {
    position: "absolute",
    borderWidth: 1.5,
    borderColor: "rgba(242,244,123,0.75)",
    backgroundColor: "transparent",
  },
  avatar: { alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  botAvatarFace: {
    width: "80%",
    height: "80%",
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F5F7FF",
    borderWidth: 1,
    borderColor: "rgba(101,81,196,0.22)",
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
    backgroundColor: "rgba(101,81,196,0.72)",
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
    borderColor: "rgba(101,81,196,0.28)",
  },
  avatarImage: { resizeMode: "cover" },
  avatarText: { color: "#FFFFFF", fontWeight: "900" },
  chatRowBody: { flex: 1, minWidth: 0 },
  chatListRowBody: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  chatListTextColumn: { flex: 1, minWidth: 0 },
  chatListMetaColumn: { width: 58, alignItems: "flex-end", justifyContent: "center", gap: 7, flexShrink: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  chatTitle: { color: colors.ink, fontSize: 16, fontWeight: "900", maxWidth: "100%" },
  chatTitleDark: { color: "#FFFFFF" },
  chatTime: { color: colors.faint, fontSize: 12, fontWeight: "700", textAlign: "right" },
  chatTimeDark: { color: "rgba(255,255,255,0.48)" },
  chatPreview: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  chatPreviewDark: { color: "rgba(255,255,255,0.62)" },
  chatPreviewUnread: { color: colors.ink, fontWeight: "800" },
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
  unreadBadgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900" },
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
    backgroundColor: "#101421",
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
  chatHeaderDark: { backgroundColor: "#171E31", borderBottomColor: "rgba(242,244,123,0.12)" },
  chatHeaderMain: { flex: 1, minWidth: 0 },
  chatHeaderActions: { flexShrink: 0 },
  chatHeaderTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "900" },
  chatHeaderSub: { color: "rgba(255,255,255,0.76)", fontSize: 12 },
  chatHeaderSubTyping: { color: "#FFFFFF", fontWeight: "800" },
  messageList: { flexGrow: 1, padding: 18, gap: 12, backgroundColor: colors.page },
  messageListDark: { backgroundColor: "#101421" },
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
  olderMessagesLoaderDark: { backgroundColor: "#1B2235", borderColor: "rgba(255,255,255,0.10)" },
  messageWithDate: { gap: 12 },
  datePill: {
    alignSelf: "center",
    minHeight: 28,
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: radii.pill,
    backgroundColor: "rgba(23,18,36,0.10)",
  },
  datePillDark: { backgroundColor: "rgba(255,255,255,0.12)" },
  datePillText: { color: colors.muted, fontSize: 12, fontWeight: "900" },
  datePillTextDark: { color: "rgba(255,255,255,0.70)" },
  messageWrap: { width: "78%", maxWidth: "78%", minWidth: 0, flexShrink: 1 },
  messageWrapAudio: { width: "90%", maxWidth: "90%" },
  messageMine: { alignSelf: "flex-end" },
  messageTheirs: { alignSelf: "flex-start" },
  senderName: { color: colors.primaryDark, fontSize: 12, fontWeight: "800", marginBottom: 4, marginLeft: 8 },
  bubble: { alignSelf: "flex-start", maxWidth: "100%", padding: 11, borderRadius: 14, gap: 6 },
  mineBubble: { alignSelf: "flex-end", backgroundColor: colors.bubbleMine, borderTopRightRadius: 4 },
  theirBubble: { backgroundColor: colors.bubbleTheirs, borderTopLeftRadius: 4, borderColor: "rgba(229,224,238,0.72)", borderWidth: 1 },
  theirBubbleDark: { backgroundColor: "#1B2235", borderColor: "rgba(255,255,255,0.10)" },
  forwardedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  forwardedText: { color: colors.primaryDark, fontSize: 11, fontWeight: "800" },
  forwardedTextMine: { color: "rgba(255,255,255,0.82)" },
  thinkingBubble: { flexDirection: "row", alignItems: "center", gap: 8 },
  thinkingText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  thinkingTextDark: { color: "rgba(255,255,255,0.62)" },
  messageText: { flexShrink: 1, color: colors.ink, fontSize: 15, lineHeight: 21 },
  messageTextDark: { color: "#FFFFFF" },
  messageTextMine: { color: "#FFFFFF" },
  messageStrong: { fontWeight: "900" },
  messageEmphasis: { fontStyle: "italic" },
  messageLink: { color: colors.primaryDark, fontWeight: "900", textDecorationLine: "underline" },
  messageLinkMine: { color: colors.accentSoft },
  messageCode: {
    paddingHorizontal: 5,
    borderRadius: 5,
    overflow: "hidden",
    color: colors.ink,
    backgroundColor: colors.primarySoft,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  messageCodeMine: { color: "#FFFFFF", backgroundColor: "rgba(255,255,255,0.18)" },
  messageMeta: { alignSelf: "flex-end", flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: colors.faint, fontSize: 10 },
  metaTextMine: { color: "rgba(255,255,255,0.72)" },
  imageAttachment: { gap: 8, marginBottom: 2 },
  imageAttachmentMedia: { width: 184, height: 156, borderRadius: 12, backgroundColor: "#E6E0F8" },
  attachmentCaption: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  attachmentCaptionMine: { color: "rgba(255,255,255,0.78)" },
  documentAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: colors.surfaceBlue,
  },
  documentAttachmentMine: { backgroundColor: "rgba(255,255,255,0.14)" },
  documentAttachmentIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(101,81,196,0.12)",
  },
  documentAttachmentIconMine: { backgroundColor: "rgba(255,255,255,0.16)" },
  documentAttachmentTitle: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  documentAttachmentTitleMine: { color: "#FFFFFF" },
  documentAttachmentMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  documentAttachmentMetaMine: { color: "rgba(255,255,255,0.72)" },
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
  audioAttachmentMine: { backgroundColor: "rgba(255,255,255,0.14)" },
  audioPlayButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  audioPlayButtonMine: { backgroundColor: "#FFFFFF" },
  audioWaveRow: { flexDirection: "row", alignItems: "center", gap: 3, minHeight: 26, flexWrap: "nowrap", overflow: "hidden" },
  audioWaveBar: { width: 4, borderRadius: 999, flexShrink: 0 },
  audioDuration: { color: colors.muted, fontSize: 11, marginTop: 4 },
  audioDurationMine: { color: "rgba(255,255,255,0.78)" },
  composer: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    backgroundColor: colors.surface,
  },
  composerDark: { borderTopColor: "rgba(255,255,255,0.10)", backgroundColor: "#101421" },
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
    borderColor: "rgba(101,81,196,0.20)",
    backgroundColor: "#F2EEF9",
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
    backgroundColor: "#182034",
  },
  quickPromptMenuTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: colors.muted,
    paddingHorizontal: 2,
  },
  quickPromptMenuTitleDark: { color: "rgba(255,255,255,0.62)" },
  quickPromptItem: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: "#F6F4FA",
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
  composerAccessoryButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1EDF9",
  },
  composerAccessoryButtonDark: { backgroundColor: "rgba(255,255,255,0.10)" },
  composerBody: { flex: 1, gap: 8 },
  composerQuickActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  composerInput: {
    minHeight: 42,
    maxHeight: 110,
    borderRadius: 21,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.ink,
    backgroundColor: "#F6F4FA",
  },
  composerInputDark: { color: "#FFFFFF", backgroundColor: "rgba(255,255,255,0.08)" },
  composerInputWithAttachment: { minHeight: 40 },
  composerAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 16,
    backgroundColor: "#F6F4FA",
  },
  composerAttachmentDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  composerAttachmentImage: { width: 42, height: 42, borderRadius: 12, backgroundColor: "#E6E0F8" },
  composerAttachmentIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(101,81,196,0.12)",
  },
  composerAttachmentIconDark: { backgroundColor: "rgba(242,244,123,0.12)" },
  composerAttachmentTitle: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  composerAttachmentTitleDark: { color: "#FFFFFF" },
  composerAttachmentMeta: { color: colors.muted, fontSize: 11, marginTop: 3 },
  composerAttachmentMetaDark: { color: "rgba(255,255,255,0.62)" },
  composerAttachmentClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(23,18,36,0.06)",
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
    borderColor: "rgba(101,81,196,0.14)",
  },
  cameraQuickButtonDark: {
    backgroundColor: "rgba(242,244,123,0.12)",
    borderColor: "rgba(242,244,123,0.20)",
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
  quickActionDark: { backgroundColor: "rgba(242,244,123,0.10)" },
  quickActionText: { color: colors.primaryDark, fontWeight: "900" },
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
    borderColor: "rgba(242,244,123,0.36)",
    backgroundColor: colors.accent,
  },
  profileAvatarHint: { marginTop: 4, color: colors.primaryDark, fontSize: 11, fontWeight: "700" },
  profileAvatarHintDark: { color: colors.accent },
  profileName: { color: colors.ink, fontSize: 20, fontWeight: "900" },
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
    fontWeight: "800",
    backgroundColor: colors.accentSoft,
  },
  settingsNoticeDark: { color: colors.accent, backgroundColor: "rgba(242,244,123,0.12)" },
  themeSwitch: {
    width: 46,
    height: 26,
    borderRadius: 13,
    justifyContent: "center",
    padding: 3,
    backgroundColor: "#D8D0EB",
  },
  themeSwitchOn: { backgroundColor: "rgba(242,244,123,0.28)" },
  themeSwitchKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#FFFFFF" },
  themeSwitchKnobOn: { transform: [{ translateX: 20 }], backgroundColor: colors.accent },
  desktopEmpty: { flex: 1, borderRadius: radii.lg, borderColor: colors.line, borderWidth: 1, backgroundColor: colors.surface },
  emptyState: { alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingVertical: 42, gap: 8 },
  emptyCompact: { paddingVertical: 18 },
  emptyIcon: { width: 58, height: 58, borderRadius: 29, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceBlue },
  emptyIconDark: { backgroundColor: "rgba(255,255,255,0.08)" },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "900", textAlign: "center" },
  emptyTitleDark: { color: "#FFFFFF" },
  emptyCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: "center" },
  emptyCopyDark: { color: "rgba(255,255,255,0.62)" },
  agentWelcomeCard: {
    marginHorizontal: 14,
    marginVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: "rgba(101,81,196,0.18)",
    backgroundColor: colors.surfaceBlue,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  agentWelcomeCardDark: {
    borderColor: "rgba(242,244,123,0.22)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  agentWelcomeTitle: { color: colors.ink, fontSize: 14, fontWeight: "900" },
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
    borderColor: "rgba(101,81,196,0.35)",
    ...shadow,
    zIndex: 130,
    elevation: 12,
  },
  agentFabDark: {
    backgroundColor: colors.accent,
    borderColor: "rgba(242,244,123,0.55)",
  },
  agentFabText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "900",
  },
  agentFabTextDark: {
    color: colors.primaryDark,
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(16, 32, 51, 0.24)",
  },
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
  modalTitle: { color: colors.ink, fontSize: 22, fontWeight: "900" },
  modalInput: {
    minHeight: 46,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 12,
    color: colors.ink,
    backgroundColor: colors.page,
  },
  newContactForm: { gap: 10 },
  statusInput: { minHeight: 130, textAlignVertical: "top", paddingTop: 12 },
  modalList: { maxHeight: 430, minHeight: 120, flexShrink: 1 },
  modalRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
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
    backgroundColor: "rgba(101,81,196,0.12)",
  },
  forwardPreviewCard: {
    padding: 12,
    borderRadius: 14,
    backgroundColor: colors.page,
    borderWidth: 1,
    borderColor: colors.line,
  },
  voiceComposerCard: {
    width: "100%",
    maxWidth: 380,
    borderRadius: 28,
    backgroundColor: colors.surface,
    paddingHorizontal: 20,
    paddingVertical: 22,
    gap: 18,
  },
  voiceComposerTitle: { color: colors.ink, fontSize: 22, fontWeight: "900", textAlign: "center" },
  voiceWaveCard: {
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: "#FBFAFF",
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
    backgroundColor: "#F3F0FA",
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
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.page,
  },
  secondaryText: { color: colors.ink, fontWeight: "800" },
  primaryButton: {
    height: 42,
    paddingHorizontal: 18,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
  },
  fullWidthButton: { width: "100%" },
  primaryText: { color: "#FFFFFF", fontWeight: "900" },
});
