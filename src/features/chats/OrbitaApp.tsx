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
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Session } from "@supabase/supabase-js";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  SafeAreaView as RNSafeAreaView,
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
import { hapticMessageReceived, hapticMessageSent } from "@/lib/haptics";
import { normalizePhone } from "@/lib/phone";
import {
  hasSupabaseConfig,
  signInWithDevOtpBypass,
  signInWithEmail,
  supabase,
  verifyEmailOtp,
} from "@/lib/supabase";
import { subscribeMessengerRealtime } from "@/lib/messengerRealtime";
import { colors, radii, shadow } from "@/theme/colors";

type Tab = "chats" | "status" | "contacts" | "calls" | "settings";
type ChatMessage = BackendMessage & { localState?: "sending" | "failed" };
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
  id: string;
  type: "conversation" | "contact";
  title: string;
  subtitle: string;
};

const KEYBOARD_COMPOSER_GAP = 18;
const KEYBOARD_SAFETY_GAP = Platform.OS === "android" ? 34 : 14;
const EDGE_SWIPE_WIDTH = 34;
const EDGE_SWIPE_TRIGGER = 72;
const EDGE_SWIPE_VERTICAL_LIMIT = 64;
const MESSAGE_RECONCILE_WINDOW_MS = 12_000;
const tabs: Array<{ id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { id: "chats", label: "Chats", icon: "chatbubbles-outline" },
  { id: "status", label: "Status", icon: "aperture-outline" },
  { id: "contacts", label: "Contacts", icon: "people-outline" },
  { id: "calls", label: "Calls", icon: "call-outline" },
  { id: "settings", label: "Settings", icon: "settings-outline" },
];

const DEV_BYPASS_OTP = "123456";
const DEV_OTP_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_ENABLE_DEV_OTP === "1";
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

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

function OrbitaLogo({ size = 64 }: { size?: number }) {
  const spin = useRef(new Animated.Value(0)).current;
  const counterSpin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const spinLoop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 4200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.07, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );

    spinLoop.start();
    const counterSpinLoop = Animated.loop(
      Animated.timing(counterSpin, {
        toValue: 1,
        duration: 6100,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    counterSpinLoop.start();
    pulseLoop.start();
    return () => {
      spinLoop.stop();
      counterSpinLoop.stop();
      pulseLoop.stop();
    };
  }, [counterSpin, pulse, spin]);

  const spinInterpolate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const counterSpinInterpolate = counterSpin.interpolate({ inputRange: [0, 1], outputRange: ["360deg", "0deg"] });

  return (
    <Animated.View style={[styles.logoFrame, { width: size, height: size, borderRadius: size / 3, transform: [{ scale: pulse }] }]}>
      <View style={[styles.logoCore, { width: size - 22, height: size - 22, borderRadius: (size - 22) / 2 }]} />
      <Animated.View
        style={[
          styles.logoOrbit,
          {
            width: size - 12,
            height: size - 12,
            borderRadius: (size - 12) / 2,
            transform: [{ rotate: spinInterpolate }],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.logoOrbitAlt,
          {
            width: size - 4,
            height: size - 4,
            borderRadius: (size - 4) / 2,
            transform: [{ rotate: counterSpinInterpolate }],
          },
        ]}
      />
      <Ionicons color="#FFFFFF" name="planet-outline" size={Math.max(24, size * 0.45)} />
    </Animated.View>
  );
}

function OrbitaBrand({ compact }: { compact?: boolean }) {
  return (
    <View style={styles.brandRow}>
      <OrbitaLogo size={compact ? 40 : 48} />
      <View>
        <Text style={[styles.brandTitle, compact && styles.brandTitleCompact]}>Orbita</Text>
        {!compact ? <Text style={styles.brandTagline}>Messaging, with momentum</Text> : null}
      </View>
    </View>
  );
}

function Avatar({ name, size = 46 }: { name: string; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarText, { fontSize: size > 52 ? 20 : 15 }]}>{initials(name || "U")}</Text>
    </View>
  );
}

function SkeletonBlock({ style }: { style?: StyleProp<ViewStyle> }) {
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

  return <Animated.View style={[styles.skeletonBlock, style, { opacity }]} />;
}

function ChatRowsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <View key={index} style={styles.chatRow}>
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
  return (
    <>
      <View style={[styles.messageWrap, styles.messageTheirs]}>
        <View style={[styles.skeletonBubble, styles.skeletonBubbleIncoming]}>
          <SkeletonBlock style={styles.skeletonMessageLineWide} />
          <SkeletonBlock style={styles.skeletonMessageLineMid} />
        </View>
      </View>
      <View style={[styles.messageWrap, styles.messageMine]}>
        <View style={[styles.skeletonBubble, styles.skeletonBubbleOutgoing]}>
          <SkeletonBlock style={styles.skeletonMessageLineWide} />
          <SkeletonBlock style={styles.skeletonMessageLineShort} />
        </View>
      </View>
      <View style={[styles.messageWrap, styles.messageTheirs]}>
        <View style={[styles.skeletonBubble, styles.skeletonBubbleIncoming]}>
          <SkeletonBlock style={styles.skeletonMessageLineMid} />
          <SkeletonBlock style={styles.skeletonMedia} />
        </View>
      </View>
      <View style={[styles.messageWrap, styles.messageMine]}>
        <View style={[styles.skeletonBubble, styles.skeletonBubbleOutgoing]}>
          <SkeletonBlock style={styles.skeletonMessageLineShort} />
        </View>
      </View>
    </>
  );
}

function MessageBody({ mine, text }: { mine: boolean; text: string }) {
  return (
    <Text style={[styles.messageText, mine && styles.messageTextMine]}>
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
  return (
    <>
      <View style={styles.statusComposer}>
        <SkeletonBlock style={styles.skeletonAvatarLarge} />
        <View style={styles.chatRowBody}>
          <SkeletonBlock style={styles.skeletonTitle} />
          <SkeletonBlock style={styles.skeletonLineMid} />
        </View>
      </View>
      <View style={styles.statusCard}>
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
  return (
    <>
      <View style={styles.profileCard}>
        <SkeletonBlock style={styles.skeletonAvatarXL} />
        <View style={styles.chatRowBody}>
          <SkeletonBlock style={styles.skeletonTitleWide} />
          <SkeletonBlock style={styles.skeletonLineMid} />
          <SkeletonBlock style={styles.skeletonLineShort} />
        </View>
      </View>
      {Array.from({ length: 3 }).map((_, index) => (
        <View key={index} style={styles.settingRow}>
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
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safe}>
      <View style={styles.appFrame}>
        <View style={styles.workspace}>
          <View style={[styles.header, styles.headerMobile]}>
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
          <View style={[styles.content, styles.contentMobile]}>
            <View style={[styles.listPanel, styles.mobilePanel]}>
              <View style={styles.panelTitle}>
                <SkeletonBlock style={styles.skeletonPanelHeading} />
                <SkeletonBlock style={styles.skeletonIconButton} />
              </View>
              <ScrollView contentContainerStyle={styles.listContent}>
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
  return (
    <Pressable accessibilityLabel={label} onPress={onPress} style={styles.iconButton}>
      <Ionicons color={colors.ink} name={icon} size={21} />
    </Pressable>
  );
}

export function OrbitaApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

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

  if (checkingSession) {
    return <FullScreenLoader />;
  }

  if (!session) {
    return <LoginScreen onSignedIn={setSession} />;
  }

  return <MessengerShell session={session} />;
}

function FullScreenLoader() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.loadingScreen}>
        <OrbitaLogo />
        <Text style={styles.loadingLabel}>Syncing your universe...</Text>
      </View>
    </SafeAreaView>
  );
}

function LoginScreen({ onSignedIn }: { onSignedIn: (session: Session | null) => void }) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const keyboardInset = useKeyboardClearance();

  async function requestOtp() {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      setNotice("Enter a valid email address first.");
      return;
    }
    if (!normalizedPhone) {
      setNotice("Enter your phone number first.");
      return;
    }
    if (!hasSupabaseConfig) {
      setNotice("Add Supabase credentials to .env before logging in.");
      return;
    }

    setLoading(true);
    const result = await signInWithEmail(normalizedEmail, normalizedPhone);
    setLoading(false);

    if (result.error) {
      if (DEV_OTP_ENABLED) {
        setNotice(`${result.error.message} You can use ${DEV_BYPASS_OTP} for local testing.`);
        setOtpSent(true);
      } else {
        setNotice(result.error.message);
      }
      return;
    }

    setEmail(normalizedEmail);
    setPhone(normalizedPhone);
    setOtpSent(true);
    setNotice(
      DEV_OTP_ENABLED
        ? `OTP sent to your email. Enter the code to continue, or use ${DEV_BYPASS_OTP} for local testing.`
        : "OTP sent to your email. Enter the code to continue.",
    );
  }

  async function verifyOtp() {
    if (!otp.trim()) {
      setNotice("Enter the OTP code.");
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = normalizePhone(phone);
    const isDevBypass = DEV_OTP_ENABLED && otp.trim() === DEV_BYPASS_OTP;

    if (!normalizedPhone) {
      setNotice("Enter your phone number first.");
      return;
    }

    setLoading(true);
    const result = isDevBypass
      ? await signInWithDevOtpBypass(normalizedEmail, normalizedPhone)
      : await verifyEmailOtp(normalizedEmail, otp.trim(), normalizedPhone);
    setLoading(false);

    if (result.error) {
      setNotice(result.error.message);
      return;
    }

    onSignedIn(result.data.session);
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safe}>
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
        <View style={styles.loginScreen}>
        <View style={styles.loginGlow} />
        <OrbitaBrand />
        <Text style={styles.loginTitle}>Sign In</Text>
        <Text style={styles.loginCopy}>
          Sign in with your email OTP and add your phone number to access messages, groups, status, and settings.
        </Text>
        <View style={styles.loginForm}>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!otpSent && !loading}
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.faint}
            style={styles.loginInput}
            value={email}
          />
          <TextInput
            editable={!otpSent && !loading}
            keyboardType="phone-pad"
            onChangeText={setPhone}
            placeholder="+91 phone number"
            placeholderTextColor={colors.faint}
            style={styles.loginInput}
            value={phone}
          />
          {otpSent ? (
            <TextInput
              keyboardType="number-pad"
              onChangeText={setOtp}
              placeholder="OTP code"
              placeholderTextColor={colors.faint}
              style={styles.loginInput}
              value={otp}
            />
          ) : null}
          <Pressable
            disabled={loading || !hasSupabaseConfig}
            onPress={otpSent ? verifyOtp : requestOtp}
            style={[styles.loginButton, (loading || !hasSupabaseConfig) && styles.buttonDisabled]}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Ionicons color="#FFFFFF" name="shield-checkmark-outline" size={18} />
                <Text style={styles.loginButtonText}>{otpSent ? "Verify and continue" : "Send email OTP"}</Text>
              </>
            )}
          </Pressable>
          {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}
          {!hasSupabaseConfig ? (
            <Text style={styles.hintText}>Required: EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.</Text>
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
  const isWide = width >= 840;
  const [activeTab, setActiveTab] = useState<Tab>("chats");
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agentThinkingFor, setAgentThinkingFor] = useState<Record<string, string>>({});
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState<ChatMessage | null>(null);
  const [forwardPickerOpen, setForwardPickerOpen] = useState(false);
  const bootstrapRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const conversationsRef = useRef<BackendConversation[]>([]);
  const agentThinkingForRef = useRef<Record<string, string>>({});
  const selectedIdRef = useRef("");
  const lastUnreadTotalRef = useRef<number | null>(null);
  const incomingHapticAtRef = useRef(0);
  const bootstrapHasLoadedRef = useRef(false);

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  const conversationIds = useMemo(() => conversations.map((conversation) => conversation.id), [conversations]);
  const conversationKey = conversationIds.join("|");
  const profileId = profile?.id ?? "";
  const unreadTotal = useMemo(
    () => conversations.reduce((total, conversation) => total + conversation.unreadCount, 0),
    [conversations],
  );

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    agentThinkingForRef.current = agentThinkingFor;
  }, [agentThinkingFor]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

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
        setProfile(data.profile);
        setContacts(data.contacts);
        setConversations(data.conversations);
        setStatuses(data.statuses);
        setError("");
        setLoading(false);
        return;
      } catch (nextError) {
        lastError = nextError;
        if (attempt < maxAttempts) {
          await delay(450 * attempt);
        }
      }
    }

    setError(lastError instanceof Error ? lastError.message : "Unable to load backend data.");
    setLoading(false);
  }, [playIncomingHaptic]);

  const markConversationReadLocally = useCallback((conversationId: string) => {
    const hasUnread = conversationsRef.current.some(
      (conversation) => conversation.id === conversationId && conversation.unreadCount > 0,
    );
    if (hasUnread) {
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

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const data = await messengerApi.listMessages(conversationId);
      setSelectedMessages((current) => {
        const local = current.filter((message) => message.conversationId === conversationId);
        const merged = mergeMessages(data.messages, local);
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
        return merged;
      });
      markConversationReadLocally(conversationId);
      setError("");
    } catch (nextError) {
      if (selectedIdRef.current === conversationId) {
        setError(nextError instanceof Error ? nextError.message : "Unable to load messages.");
      }
    } finally {
      setLoadingMessagesFor((current) => (current === conversationId ? "" : current));
    }
  }, [markConversationReadLocally, playIncomingHaptic, profileId]);

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
    };
  }, []);

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedMessages([]);
      setLoadingMessagesFor("");
      return;
    }
    setSelectedMessages([]);
    setLoadingMessagesFor(selectedId);
    loadMessages(selectedId);
  }, [loadMessages, selectedId]);

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
      onRealtimeEvent: (conversationId) => {
        refreshActiveConversation(conversationId && conversationId === selectedId ? conversationId : "");
      },
      onUserEvent: () => {
        scheduleBootstrapRefresh();
      },
    });
  }, [conversationKey, profileId, scheduleBootstrapRefresh, scheduleMessageRefresh, selectedId]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      scheduleBootstrapRefresh();
      if (selectedId) scheduleMessageRefresh(selectedId);
    });

    return () => subscription.remove();
  }, [scheduleBootstrapRefresh, scheduleMessageRefresh, selectedId]);

  useEffect(() => {
    if (Platform.OS !== "android") return undefined;

    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (selectedId) {
        setSelectedId("");
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
    await supabase?.auth.signOut();
  }

  async function retryBootstrap() {
    setLoading(true);
    await loadBootstrap();
  }

  useEffect(() => {
    setComposerAttachment(null);
    setAttachmentMenuOpen(false);
  }, [selectedId]);

  const existingDirectByContactId = useMemo(() => {
    const directMap = new Map<string, BackendConversation>();
    conversations.forEach((conversation) => {
      if (conversation.kind !== "direct") return;
      const peer = conversation.participants.find((participant) => participant.id !== profileId);
      if (peer) directMap.set(peer.id, conversation);
    });
    return directMap;
  }, [conversations, profileId]);

  const forwardTargets = useMemo<ForwardTarget[]>(() => {
    const conversationTargets = conversations
      .filter((conversation) => conversation.id !== selectedId)
      .map((conversation) => ({
        id: conversation.id,
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
        id: contact.id,
        type: "contact" as const,
        title: contact.displayName,
        subtitle: contact.phone || "Create direct chat",
      }));

    return [...conversationTargets, ...extraContactTargets];
  }, [contacts, conversations, existingDirectByContactId, selectedId]);

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

  async function sendMessage(kind: BackendMessage["kind"] = "text", body = draft.trim(), attachment = composerAttachment) {
    const text = body.trim();
    if (!selected || !profile || (!text && !attachment)) return;
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
    setSelectedMessages((current) => [...current, optimisticMessage]);
    updateConversationPreview(optimisticMessage);

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
      });
      setSelectedMessages((current) => {
        const withoutTemp = current.filter(
          (message) => message.id !== tempId && message.id !== result.message.id,
        );
        return [...withoutTemp, result.message];
      });
      updateConversationPreview(result.message);
      void hapticMessageSent();
      if (isTaskManagerAgentConversation(selected)) {
        setAgentThinkingFor((current) => ({ ...current, [selected.id]: result.message.createdAt }));
      }
      scheduleBootstrapRefresh();
      scheduleMessageRefresh(selected.id);
    } catch (nextError) {
      if (attachment) setComposerAttachment(attachment);
      setSelectedMessages((current) =>
        current.map((message) => (message.id === tempId ? { ...message, localState: "failed" } : message)),
      );
      setAgentThinkingFor((current) => {
        const next = { ...current };
        delete next[selected.id];
        return next;
      });
      setError(nextError instanceof Error ? nextError.message : "Unable to send message.");
    }
  }

  function changeTab(tab: Tab) {
    setActiveTab(tab);
    if (tab !== "chats") setSelectedId("");
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
  const bottomInset = Math.max(insets.bottom, Platform.OS === "android" ? 8 : 0);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.safe}>
      <View style={styles.appFrame}>
        {isWide ? <Sidebar activeTab={activeTab} onChange={changeTab} onNewChat={() => setNewChatOpen(true)} /> : null}
        <View style={styles.workspace}>
          <AppHeader
            isWide={isWide}
            onNewChat={() => setNewChatOpen(true)}
            onOpenProfile={() => setProfileOpen(true)}
            onSignOut={signOut}
          />
          {error ? <Text style={styles.errorBar}>{error}</Text> : null}
          <View
            style={[
              styles.content,
              !isWide && [styles.contentMobile, { paddingBottom: showBottomTabs ? 64 + bottomInset : 0 }],
              !isWide && activeTab === "chats" && selected && styles.contentMobileChat,
            ]}
          >
            {showPanel ? (
              <Panel
                activeTab={activeTab}
                contacts={contacts}
                conversations={conversations}
                isWide={isWide}
                onCreateGroup={() => setGroupOpen(true)}
                onNewChat={() => setNewChatOpen(true)}
                onNewStatus={() => setStatusOpen(true)}
                onOpenProfile={() => setProfileOpen(true)}
                onSelect={(id) => {
                  setSelectedId(id);
                  setActiveTab("chats");
                }}
                profile={profile}
                selectedId={selected?.id}
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
                messages={selectedMessages}
                messagesLoading={loadingMessagesFor === selected.id}
                onAddMembers={() => setMembersOpen(true)}
                onForwardMessage={(message) => {
                  setForwardingMessage(message);
                  setForwardPickerOpen(true);
                }}
                onOpenAttachmentMenu={() => setAttachmentMenuOpen(true)}
                onBack={() => setSelectedId("")}
                onRemoveAttachment={() => setComposerAttachment(null)}
                onSend={(nextKind, nextBody, nextAttachment) => sendMessage(nextKind, nextBody, nextAttachment)}
                setDraft={setDraft}
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
      {busy ? <View style={styles.busyOverlay}><ActivityIndicator color="#FFFFFF" /></View> : null}
      <NewChatModal
        contacts={contacts}
        onClose={() => setNewChatOpen(false)}
        onContactAdded={async () => loadBootstrap()}
        onOpenConversation={async (otherUserId) => {
          await run(async () => {
            const result = await messengerApi.createDirectConversation(otherUserId);
            setNewChatOpen(false);
            await loadBootstrap();
            setSelectedId(result.conversation.id);
            setActiveTab("chats");
          });
        }}
        visible={newChatOpen}
      />
      <GroupModal
        contacts={contacts}
        onClose={() => setGroupOpen(false)}
        onCreate={async (title, memberIds) => {
          await run(async () => {
            const result = await messengerApi.createGroup(title, memberIds);
            setGroupOpen(false);
            await loadBootstrap();
            setSelectedId(result.conversation.id);
            setActiveTab("chats");
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
  onNewChat,
  onOpenProfile,
  onSignOut,
}: {
  isWide: boolean;
  onNewChat: () => void;
  onOpenProfile: () => void;
  onSignOut: () => void;
}) {
  return (
    <View style={[styles.header, !isWide && styles.headerMobile]}>
      <OrbitaBrand compact={!isWide} />
      <View style={styles.headerActions}>
        <IconButton icon="create-outline" label="New chat" onPress={onNewChat} />
        <IconButton icon="person-circle-outline" label="Profile" onPress={onOpenProfile} />
        <IconButton icon="log-out-outline" label="Sign out" onPress={onSignOut} />
      </View>
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
  return (
    <View style={styles.sidebar}>
      <View style={styles.brandMark}>
        <Ionicons color="#FFFFFF" name="planet-outline" size={24} />
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
  return (
    <View style={[styles.bottomTabs, { paddingBottom: bottomInset + 8 }]}>
      {tabs.map((tab) => (
        <Pressable accessibilityLabel={tab.label} key={tab.id} onPress={() => onChange(tab.id)} style={styles.bottomTab}>
          <View>
            <Ionicons color={activeTab === tab.id ? colors.primaryDark : colors.muted} name={tab.icon} size={24} />
            {tab.id === "chats" && unreadTotal > 0 ? <UnreadBadge count={unreadTotal} compact /> : null}
          </View>
          <Text style={[styles.bottomTabLabel, activeTab === tab.id && styles.bottomTabLabelActive]}>{tab.label}</Text>
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
  onNewChat,
  onNewStatus,
  onOpenProfile,
  onSelect,
  profile,
  selectedId,
  statuses,
}: {
  activeTab: Tab;
  contacts: BackendProfile[];
  conversations: BackendConversation[];
  isWide: boolean;
  onCreateGroup: () => void;
  onNewChat: () => void;
  onNewStatus: () => void;
  onOpenProfile: () => void;
  onSelect: (id: string) => void;
  profile: BackendProfile;
  selectedId?: string;
  statuses: BackendStatus[];
}) {
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
    return <SettingsPanel isWide={isWide} onOpenProfile={onOpenProfile} profile={profile} />;
  }

  return (
    <View style={[styles.listPanel, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Chats" actionIcon="create-outline" actionLabel="New chat" onAction={onNewChat} />
      <ScrollView contentContainerStyle={styles.listContent}>
        {conversations.length ? (
          conversations.map((conversation) => (
            <Pressable
              key={conversation.id}
              onPress={() => onSelect(conversation.id)}
              style={[styles.chatRow, selectedId === conversation.id && styles.chatRowActive]}
            >
              <Avatar name={conversation.title} />
              <View style={styles.chatListRowBody}>
                <View style={styles.chatListTextColumn}>
                  <Text numberOfLines={1} style={styles.chatTitle}>{conversation.title}</Text>
                  <Text numberOfLines={1} style={[styles.chatPreview, conversation.unreadCount > 0 && styles.chatPreviewUnread]}>
                    {messagePreviewText(conversation.lastMessage) || `${conversation.participants.length} member${conversation.participants.length === 1 ? "" : "s"}`}
                  </Text>
                </View>
                <View style={styles.chatListMetaColumn}>
                  <Text numberOfLines={1} style={styles.chatTime}>
                    {conversation.lastMessage ? formatTime(conversation.lastMessage.createdAt) : ""}
                  </Text>
                  {conversation.unreadCount > 0 ? <UnreadBadge count={conversation.unreadCount} /> : null}
                </View>
              </View>
            </Pressable>
          ))
        ) : (
          <EmptyState icon="chatbubbles-outline" title="No chats yet" copy="Start a 1:1 chat from Contacts or create a group." />
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
  return (
    <View style={styles.panelTitle}>
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
  draft,
  setDraft,
  onRemoveAttachment,
  onSend,
  onBack,
  onAddMembers,
  isWide,
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
  draft: string;
  setDraft: (value: string) => void;
  onRemoveAttachment: () => void;
  onSend: (
    kind?: BackendMessage["kind"],
    body?: string,
    attachment?: ComposerAttachment | null,
  ) => Promise<void> | void;
  onBack: () => void;
  onAddMembers: () => void;
  isWide: boolean;
}) {
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView | null>(null);
  const keyboardInset = useKeyboardClearance(!isWide);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 160);
  const previewPlayer = useMemo(() => createAudioPlayer(), []);
  const previewStatus = useAudioPlayerStatus(previewPlayer);
  const [voiceComposerOpen, setVoiceComposerOpen] = useState(false);
  const [voiceAttachment, setVoiceAttachment] = useState<ComposerAttachment | null>(null);

  const scrollToLatest = useCallback((animated = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated });
    });
  }, []);

  useEffect(() => {
    scrollToLatest(false);
  }, [conversation.id, messages.length, scrollToLatest]);

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
        !isWide && styles.chatPaneMobile,
        !isWide && { paddingBottom: keyboardInset || Math.max(bottomInset, KEYBOARD_COMPOSER_GAP) },
      ]}
    >
      <View style={styles.chatHeader}>
        <View style={styles.row}>
          {!isWide ? <IconButton icon="arrow-back" label="Back to chats" onPress={onBack} /> : null}
          <Avatar name={conversation.title} />
          <View style={styles.chatRowBody}>
            <Text numberOfLines={1} style={styles.chatHeaderTitle}>{conversation.title}</Text>
            <Text style={styles.chatHeaderSub}>
              {agentThinking
                ? `${conversation.title.split(" ")[0] || "Agent"} is thinking...`
                : conversation.kind === "group"
                  ? `${conversation.participants.length} members`
                  : "1:1 conversation"}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {conversation.kind === "group" ? <IconButton icon="person-add-outline" label="Add members" onPress={onAddMembers} /> : null}
          <IconButton icon="call-outline" label="Voice call" />
        </View>
      </View>
      <ScrollView
        contentContainerStyle={styles.messageList}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollToLatest()}
        onLayout={() => scrollToLatest(false)}
        ref={scrollRef}
      >
        {messagesLoading ? (
          <MessageListSkeleton />
        ) : messages.length ? (
          messages.map((message) => {
            const mine = message.senderId === currentUserId;
            const sender = conversation.participants.find((participant) => participant.id === message.senderId);
            const isAudioKind = message.kind === "voice" || message.kind === "audio";
            return (
              <View key={message.id} style={[styles.messageWrap, isAudioKind && styles.messageWrapAudio, mine ? styles.messageMine : styles.messageTheirs]}>
                {!mine && conversation.kind === "group" ? (
                  <Text style={styles.senderName}>{sender?.displayName ?? "Member"}</Text>
                ) : null}
                <Pressable onLongPress={() => onForwardMessage(message)} style={[styles.bubble, mine ? styles.mineBubble : styles.theirBubble]}>
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
                      <ActivityIndicator color={colors.primarySoft} size="small" />
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
            );
          })
        ) : (
          <EmptyState icon="lock-closed-outline" title="No messages" copy="Send the first message in this conversation." compact />
        )}
        {agentThinking ? (
          <View style={[styles.messageWrap, styles.messageTheirs]}>
            <View style={[styles.bubble, styles.theirBubble, styles.thinkingBubble]}>
              <ActivityIndicator color={colors.primaryDark} size="small" />
              <Text style={styles.thinkingText}>Thinking...</Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
      <View style={styles.composer}>
        <Pressable accessibilityLabel="Add attachment" onPress={onOpenAttachmentMenu} style={styles.composerAccessoryButton}>
          <Ionicons color={colors.ink} name="add" size={22} />
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
          placeholderTextColor={colors.faint}
          style={[styles.composerInput, attachment && styles.composerInputWithAttachment]}
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
          <Pressable accessibilityLabel="Record voice note" onPress={startVoiceRecording} style={styles.sendButton}>
            <Ionicons color="#FFFFFF" name="mic" size={19} />
          </Pressable>
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
  return (
    <View style={styles.composerAttachment}>
      {attachment.kind === "image" ? (
        <Image source={{ uri: attachment.uri }} style={styles.composerAttachmentImage} />
      ) : (
        <View style={styles.composerAttachmentIcon}>
          <Ionicons
            color={colors.primaryDark}
            name={attachment.kind === "document" ? "document-text-outline" : "mic-outline"}
            size={18}
          />
        </View>
      )}
      <View style={styles.chatRowBody}>
        <Text numberOfLines={1} style={styles.composerAttachmentTitle}>{attachment.name}</Text>
        <Text style={styles.composerAttachmentMeta}>
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
        <Ionicons color={colors.ink} name="close" size={16} />
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
  return (
    <View style={[styles.listPanel, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Status" actionIcon="add-circle-outline" actionLabel="New status" onAction={onNewStatus} />
      <ScrollView contentContainerStyle={styles.listContent}>
        <Pressable onPress={onNewStatus} style={styles.statusComposer}>
          <Avatar name={profile.displayName} size={54} />
          <View style={styles.chatRowBody}>
            <Text style={styles.chatTitle}>My status</Text>
            <Text style={styles.chatPreview}>Create a text status backed by Supabase.</Text>
          </View>
          <Ionicons color={colors.primaryDark} name="add-circle" size={24} />
        </Pressable>
        {statuses.length ? (
          statuses.map((status) => (
            <View key={status.id} style={styles.statusCard}>
              <View style={styles.row}>
                <Avatar name={status.author.displayName} />
                <View style={styles.chatRowBody}>
                  <Text style={styles.chatTitle}>{status.author.displayName}</Text>
                  <Text style={styles.chatPreview}>{formatTime(status.createdAt)} · {status.viewCount} views</Text>
                </View>
              </View>
              <Text style={styles.statusText}>{status.text}</Text>
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
  return (
    <View style={[styles.listPanel, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Contacts" actionIcon="person-add-outline" actionLabel="Add contact" onAction={onNewChat} />
      <Pressable onPress={onCreateGroup} style={styles.quickAction}>
        <Ionicons color={colors.primaryDark} name="people-outline" size={22} />
        <Text style={styles.quickActionText}>New group</Text>
      </Pressable>
      <ScrollView contentContainerStyle={styles.listContent}>
        {contacts.length ? contacts.map((contact) => (
          <View key={contact.id} style={styles.contactRow}>
            <Avatar name={contact.displayName} />
            <View style={styles.chatRowBody}>
              <Text style={styles.chatTitle}>{contact.displayName}</Text>
              <Text style={styles.chatPreview}>{contact.phone ?? contact.about}</Text>
            </View>
          </View>
        )) : <EmptyState icon="person-add-outline" title="No contacts" copy="Add contacts by phone number to start 1:1 chats or groups." />}
      </ScrollView>
    </View>
  );
}

function CallsPanel({ isWide }: { isWide: boolean }) {
  return (
    <View style={[styles.listPanel, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Calls" actionIcon="call-outline" actionLabel="New call" onAction={() => undefined} />
      <EmptyState icon="call-outline" title="Calls are not enabled" copy="The database has call tables, but WebRTC signaling is intentionally separate from messaging." />
    </View>
  );
}

function SettingsPanel({
  isWide,
  onOpenProfile,
  profile,
}: {
  isWide: boolean;
  onOpenProfile: () => void;
  profile: BackendProfile;
}) {
  return (
    <View style={[styles.listPanel, !isWide && styles.mobilePanel]}>
      <PanelTitle title="Settings" actionIcon="create-outline" actionLabel="Edit profile" onAction={onOpenProfile} />
      <View style={styles.profileCard}>
        <Avatar name={profile.displayName} size={64} />
        <View style={styles.chatRowBody}>
          <Text style={styles.profileName}>{profile.displayName}</Text>
          <Text style={styles.chatPreview}>{profile.phone ?? "No phone on profile"}</Text>
          <Text style={styles.chatPreview}>{profile.about}</Text>
        </View>
      </View>
      {[
        ["key-outline", "Account", "Phone OTP session stored by Supabase Auth"],
        ["lock-closed-outline", "Privacy", "Profile and contact visibility enforced by RLS"],
        ["cloud-upload-outline", "Storage", "Media buckets are configured in Supabase"],
      ].map(([icon, title, copy]) => (
        <View key={title} style={styles.settingRow}>
          <Ionicons color={colors.primaryDark} name={icon as keyof typeof Ionicons.glyphMap} size={22} />
          <View style={styles.chatRowBody}>
            <Text style={styles.chatTitle}>{title}</Text>
            <Text style={styles.chatPreview}>{copy}</Text>
          </View>
        </View>
      ))}
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
  return (
    <View style={[styles.emptyState, compact && styles.emptyCompact]}>
      <View style={styles.emptyIcon}>
        <Ionicons color={colors.primaryDark} name={icon} size={28} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyCopy}>{copy}</Text>
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
  const [notice, setNotice] = useState("");

  async function addContact() {
    try {
      await messengerApi.addContactByPhone(phone);
      setPhone("");
      setNotice("Contact added.");
      await onContactAdded();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to add contact.");
    }
  }

  return (
    <KeyboardAwareModal onClose={onClose} visible={visible}>
          <Text style={styles.modalTitle}>New chat</Text>
          <View style={styles.inlineForm}>
            <TextInput
              keyboardType="phone-pad"
              onChangeText={setPhone}
              placeholder="+91 contact phone"
              placeholderTextColor={colors.faint}
              style={[styles.modalInput, styles.inlineInput]}
              value={phone}
            />
            <Pressable onPress={addContact} style={styles.primaryButton}>
              <Text style={styles.primaryText}>Add</Text>
            </Pressable>
          </View>
          {notice ? <Text style={styles.noticeText}>{notice}</Text> : null}
          <ScrollView style={styles.modalList}>
            {contacts.length ? contacts.map((contact) => (
              <Pressable key={contact.id} onPress={() => onOpenConversation(contact.id)} style={styles.modalRow}>
                <Avatar name={contact.displayName} />
                <View style={styles.chatRowBody}>
                  <Text style={styles.chatTitle}>{contact.displayName}</Text>
                  <Text style={styles.chatPreview}>{contact.phone}</Text>
                </View>
                <Ionicons color={colors.primaryDark} name="chatbubble-outline" size={21} />
              </Pressable>
            )) : <EmptyState compact icon="person-add-outline" title="No contacts" copy="Add a registered phone number first." />}
          </ScrollView>
          <ModalActions onCancel={onClose} />
    </KeyboardAwareModal>
  );
}

function KeyboardAwareModal({ children, onClose, visible }: { children: ReactNode; onClose: () => void; visible: boolean }) {
  const keyboardInset = useKeyboardClearance(visible);

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={[styles.modalBackdrop, keyboardInset ? { paddingBottom: keyboardInset } : null]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          enabled={Platform.OS !== "web"}
          keyboardVerticalOffset={KEYBOARD_SAFETY_GAP}
          style={styles.modalKeyboardFrame}
        >
          <View style={styles.modalCard}>{children}</View>
        </KeyboardAvoidingView>
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
          <Avatar name={contact.displayName} />
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
              <Avatar name={target.title} />
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
  loadingScreen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  loadingLabel: { color: colors.muted, fontSize: 14, fontWeight: "700" },
  logoFrame: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    shadowColor: colors.primaryDark,
    shadowOpacity: 0.32,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  logoCore: {
    position: "absolute",
    backgroundColor: "rgba(242,244,123,0.28)",
  },
  logoOrbit: {
    position: "absolute",
    borderWidth: 1.8,
    borderColor: "rgba(255,255,255,0.45)",
    borderTopColor: "#FFFFFF",
  },
  logoOrbitAlt: {
    position: "absolute",
    borderWidth: 1.4,
    borderColor: "rgba(242,244,123,0.55)",
    borderLeftColor: "rgba(255,255,255,0.78)",
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  brandTitle: { color: colors.ink, fontSize: 25, fontWeight: "900" },
  brandTitleCompact: { fontSize: 21 },
  brandTagline: { color: colors.muted, fontSize: 12, fontWeight: "700", marginTop: 1 },
  loadingErrorScreen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 },
  loginKeyboard: { flex: 1 },
  loginScroll: { flexGrow: 1, justifyContent: "center" },
  loginScreen: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: colors.page },
  loginGlow: {
    position: "absolute",
    width: 260,
    height: 260,
    right: -100,
    top: -48,
    borderRadius: 130,
    backgroundColor: "rgba(122,94,214,0.20)",
  },
  loginTitle: { color: colors.ink, fontSize: 32, fontWeight: "900", marginTop: 24 },
  loginCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 8, maxWidth: 420 },
  loginForm: {
    marginTop: 24,
    gap: 12,
    maxWidth: 440,
    padding: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(122,94,214,0.18)",
    backgroundColor: "rgba(255,255,255,0.78)",
  },
  loginInput: {
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 14,
    color: colors.ink,
    backgroundColor: colors.surface,
    fontSize: 16,
  },
  loginButton: {
    height: 52,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    backgroundColor: colors.primaryDark,
  },
  loginButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "900" },
  buttonDisabled: { opacity: 0.55 },
  noticeText: { color: colors.primaryDark, fontSize: 13, fontWeight: "700" },
  hintText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  appFrame: { flex: 1, flexDirection: "row", backgroundColor: colors.page },
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
  headerMobile: { minHeight: 62, paddingHorizontal: 16 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  errorBar: { color: colors.danger, backgroundColor: "#FFF3F3", paddingHorizontal: 14, paddingVertical: 8 },
  content: { flex: 1, flexDirection: "row", padding: 18, gap: 18 },
  contentMobile: { padding: 0, paddingBottom: 72, backgroundColor: colors.page },
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
  mobilePanel: { flex: 1, width: "100%", borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0, borderTopWidth: 0 },
  panelTitle: {
    minHeight: 72,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.primaryDark,
  },
  panelHeading: { color: "#FFFFFF", fontSize: 39, fontWeight: "900" },
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
  bottomTabs: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 66,
    paddingTop: 7,
    paddingHorizontal: 6,
    flexDirection: "row",
    justifyContent: "space-around",
    borderTopColor: colors.line,
    borderTopWidth: 1,
    backgroundColor: colors.surface,
  },
  bottomTab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3 },
  bottomTabLabel: { color: colors.muted, fontSize: 11, fontWeight: "800" },
  bottomTabLabelActive: { color: colors.primaryDark },
  listContent: { padding: 12, gap: 10 },
  skeletonBlock: { backgroundColor: "#DDD7EB" },
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
  chatRowActive: { backgroundColor: colors.accentSoft, borderColor: "rgba(122,94,214,0.20)" },
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
  avatar: { alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  avatarText: { color: "#FFFFFF", fontWeight: "900" },
  chatRowBody: { flex: 1, minWidth: 0 },
  chatListRowBody: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  chatListTextColumn: { flex: 1, minWidth: 0 },
  chatListMetaColumn: { width: 58, alignItems: "flex-end", justifyContent: "center", gap: 7, flexShrink: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  chatTitle: { color: colors.ink, fontSize: 16, fontWeight: "900", maxWidth: "100%" },
  chatTime: { color: colors.faint, fontSize: 12, fontWeight: "700", textAlign: "right" },
  chatPreview: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  chatPreviewUnread: { color: colors.ink, fontWeight: "800" },
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
  chatHeaderTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "900" },
  chatHeaderSub: { color: "rgba(255,255,255,0.76)", fontSize: 12 },
  messageList: { flexGrow: 1, padding: 18, gap: 12, backgroundColor: colors.page },
  messageWrap: { width: "78%", maxWidth: "78%", minWidth: 0, flexShrink: 1 },
  messageWrapAudio: { width: "90%", maxWidth: "90%" },
  messageMine: { alignSelf: "flex-end" },
  messageTheirs: { alignSelf: "flex-start" },
  senderName: { color: colors.primaryDark, fontSize: 12, fontWeight: "800", marginBottom: 4, marginLeft: 8 },
  bubble: { alignSelf: "flex-start", maxWidth: "100%", padding: 11, borderRadius: 14, gap: 6 },
  mineBubble: { alignSelf: "flex-end", backgroundColor: colors.bubbleMine, borderTopRightRadius: 4 },
  theirBubble: { backgroundColor: colors.bubbleTheirs, borderTopLeftRadius: 4, borderColor: "rgba(229,224,238,0.72)", borderWidth: 1 },
  forwardedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  forwardedText: { color: colors.primaryDark, fontSize: 11, fontWeight: "800" },
  forwardedTextMine: { color: "rgba(255,255,255,0.82)" },
  thinkingBubble: { flexDirection: "row", alignItems: "center", gap: 8 },
  thinkingText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  messageText: { flexShrink: 1, color: colors.ink, fontSize: 15, lineHeight: 21 },
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
  composerAccessoryButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1EDF9",
  },
  composerBody: { flex: 1, gap: 8 },
  composerInput: {
    minHeight: 42,
    maxHeight: 110,
    borderRadius: 21,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.ink,
    backgroundColor: "#F6F4FA",
  },
  composerInputWithAttachment: { minHeight: 40 },
  composerAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 16,
    backgroundColor: "#F6F4FA",
  },
  composerAttachmentImage: { width: 42, height: 42, borderRadius: 12, backgroundColor: "#E6E0F8" },
  composerAttachmentIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(101,81,196,0.12)",
  },
  composerAttachmentTitle: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  composerAttachmentMeta: { color: colors.muted, fontSize: 11, marginTop: 3 },
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
  statusComposer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceBlue,
  },
  statusCard: { padding: 14, borderRadius: radii.md, borderColor: colors.line, borderWidth: 1, backgroundColor: colors.surface, gap: 12 },
  statusText: { color: colors.ink, fontSize: 16, lineHeight: 23 },
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
  quickActionText: { color: colors.primaryDark, fontWeight: "900" },
  profileCard: { margin: 14, padding: 14, borderRadius: radii.md, flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: colors.surfaceBlue },
  profileName: { color: colors.ink, fontSize: 20, fontWeight: "900" },
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
  desktopEmpty: { flex: 1, borderRadius: radii.lg, borderColor: colors.line, borderWidth: 1, backgroundColor: colors.surface },
  emptyState: { alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingVertical: 42, gap: 8 },
  emptyCompact: { paddingVertical: 18 },
  emptyIcon: { width: 58, height: 58, borderRadius: 29, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceBlue },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "900", textAlign: "center" },
  emptyCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: "center" },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(16, 32, 51, 0.24)",
  },
  modalBackdrop: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.overlay, padding: 18 },
  modalKeyboardFrame: { width: "100%", maxWidth: 430, maxHeight: "100%" },
  modalCard: { width: "100%", maxWidth: 430, maxHeight: "86%", borderRadius: radii.lg, backgroundColor: colors.surface, padding: 18, gap: 14 },
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
  inlineForm: { flexDirection: "row", alignItems: "center", gap: 8 },
  inlineInput: { flex: 1 },
  statusInput: { minHeight: 130, textAlignVertical: "top", paddingTop: 12 },
  modalList: { maxHeight: 310 },
  modalRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
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
  primaryText: { color: "#FFFFFF", fontWeight: "900" },
});
