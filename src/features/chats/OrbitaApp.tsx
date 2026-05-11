import { Ionicons } from "@expo/vector-icons";
import { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  BackendConversation,
  BackendMessage,
  BackendProfile,
  BackendStatus,
} from "@/features/chats/backendTypes";
import { messengerApi } from "@/lib/messengerApi";
import { normalizePhone } from "@/lib/phone";
import {
  hasSupabaseConfig,
  signInWithDevOtpBypass,
  signInWithEmail,
  supabase,
  verifyEmailOtp,
} from "@/lib/supabase";
import { colors, radii, shadow } from "@/theme/colors";

type Tab = "chats" | "status" | "contacts" | "calls" | "settings";

const tabs: Array<{ id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }> = [
  { id: "chats", label: "Chats", icon: "chatbubbles-outline" },
  { id: "status", label: "Status", icon: "aperture-outline" },
  { id: "contacts", label: "Contacts", icon: "people-outline" },
  { id: "calls", label: "Calls", icon: "call-outline" },
  { id: "settings", label: "Settings", icon: "settings-outline" },
];

const DEV_BYPASS_OTP = "123456";
const DEV_OTP_ENABLED = __DEV__;

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

function Avatar({ name, size = 46 }: { name: string; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarText, { fontSize: size > 52 ? 20 : 15 }]}>{initials(name || "U")}</Text>
    </View>
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
        <ActivityIndicator color={colors.primaryDark} />
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
      : await verifyEmailOtp(normalizedEmail, otp.trim());
    setLoading(false);

    if (result.error) {
      setNotice(result.error.message);
      return;
    }

    onSignedIn(result.data.session);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.loginScreen}>
        <View style={styles.loginMark}>
          <Ionicons color="#FFFFFF" name="planet-outline" size={34} />
        </View>
        <Text style={styles.loginTitle}>Orbita Messenger</Text>
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
    </SafeAreaView>
  );
}

function MessengerShell({ session }: { session: Session }) {
  const { width } = useWindowDimensions();
  const isWide = width >= 840;
  const [activeTab, setActiveTab] = useState<Tab>("chats");
  const [profile, setProfile] = useState<BackendProfile | null>(null);
  const [contacts, setContacts] = useState<BackendProfile[]>([]);
  const [conversations, setConversations] = useState<BackendConversation[]>([]);
  const [statuses, setStatuses] = useState<BackendStatus[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedMessages, setSelectedMessages] = useState<BackendMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;

  const loadBootstrap = useCallback(async () => {
    if (!supabase) return;
    try {
      const data = await messengerApi.bootstrap();
      setProfile(data.profile);
      setContacts(data.contacts);
      setConversations(data.conversations);
      setStatuses(data.statuses);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load backend data.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const data = await messengerApi.listMessages(conversationId);
      setSelectedMessages(data.messages);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load messages.");
    }
  }, []);

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedMessages([]);
      return;
    }
    loadMessages(selectedId);
  }, [loadMessages, selectedId]);

  useEffect(() => {
    if (!supabase) return undefined;
    const client = supabase;
    const channel = client
      .channel(`messenger-refresh:${session.user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
        loadBootstrap();
        if (selectedId) loadMessages(selectedId);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, loadBootstrap)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_participants" }, loadBootstrap)
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts" }, loadBootstrap)
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, loadBootstrap)
      .on("postgres_changes", { event: "*", schema: "public", table: "status_posts" }, loadBootstrap)
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, [loadBootstrap, loadMessages, selectedId, session.user.id]);

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

  async function sendMessage(kind: BackendMessage["kind"] = "text", body = draft.trim()) {
    if (!selected || !body) return;
    await run(async () => {
      const result = await messengerApi.sendMessage({ conversationId: selected.id, kind, body });
      setSelectedMessages((current) => [...current, result.message]);
      setDraft("");
      await loadBootstrap();
    });
  }

  function changeTab(tab: Tab) {
    setActiveTab(tab);
    if (tab !== "chats") setSelectedId("");
  }

  if (loading || !profile) {
    return <FullScreenLoader />;
  }

  const showPanel = isWide || activeTab !== "chats" || !selected;

  return (
    <SafeAreaView style={styles.safe}>
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
          <View style={[styles.content, !isWide && styles.contentMobile]}>
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
                conversation={selected}
                currentUserId={profile.id}
                draft={draft}
                isWide={isWide}
                messages={selectedMessages}
                onAddMembers={() => setMembersOpen(true)}
                onBack={() => setSelectedId("")}
                onSend={() => sendMessage()}
                setDraft={setDraft}
              />
            ) : isWide && activeTab === "chats" ? (
              <DesktopEmpty />
            ) : null}
          </View>
        </View>
      </View>
      {!isWide ? <BottomTabs activeTab={activeTab} onChange={changeTab} /> : null}
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
      <Text style={styles.appName}>Orbita</Text>
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
            <Ionicons color={activeTab === tab.id ? colors.primaryDark : colors.muted} name={tab.icon} size={22} />
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

function BottomTabs({ activeTab, onChange }: { activeTab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <View style={styles.bottomTabs}>
      {tabs.map((tab) => (
        <Pressable accessibilityLabel={tab.label} key={tab.id} onPress={() => onChange(tab.id)} style={styles.bottomTab}>
          <Ionicons color={activeTab === tab.id ? colors.primaryDark : colors.muted} name={tab.icon} size={24} />
          <Text style={[styles.bottomTabLabel, activeTab === tab.id && styles.bottomTabLabelActive]}>{tab.label}</Text>
        </Pressable>
      ))}
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
              <View style={styles.chatRowBody}>
                <View style={styles.rowBetween}>
                  <Text numberOfLines={1} style={styles.chatTitle}>{conversation.title}</Text>
                  <Text style={styles.chatTime}>
                    {conversation.lastMessage ? formatTime(conversation.lastMessage.createdAt) : ""}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.chatPreview}>
                  {conversation.lastMessage?.body ?? `${conversation.participants.length} member${conversation.participants.length === 1 ? "" : "s"}`}
                </Text>
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
  conversation,
  currentUserId,
  messages,
  draft,
  setDraft,
  onSend,
  onBack,
  onAddMembers,
  isWide,
}: {
  conversation: BackendConversation;
  currentUserId: string;
  messages: BackendMessage[];
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  onBack: () => void;
  onAddMembers: () => void;
  isWide: boolean;
}) {
  return (
    <View style={[styles.chatPane, !isWide && styles.chatPaneMobile]}>
      <View style={styles.chatHeader}>
        <View style={styles.row}>
          {!isWide ? <IconButton icon="arrow-back" label="Back to chats" onPress={onBack} /> : null}
          <Avatar name={conversation.title} />
          <View style={styles.chatRowBody}>
            <Text numberOfLines={1} style={styles.chatHeaderTitle}>{conversation.title}</Text>
            <Text style={styles.chatHeaderSub}>
              {conversation.kind === "group" ? `${conversation.participants.length} members` : "1:1 conversation"}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {conversation.kind === "group" ? <IconButton icon="person-add-outline" label="Add members" onPress={onAddMembers} /> : null}
          <IconButton icon="call-outline" label="Voice call" />
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.messageList}>
        {messages.length ? (
          messages.map((message) => {
            const mine = message.senderId === currentUserId;
            const sender = conversation.participants.find((participant) => participant.id === message.senderId);
            return (
              <View key={message.id} style={[styles.messageWrap, mine ? styles.messageMine : styles.messageTheirs]}>
                {!mine && conversation.kind === "group" ? (
                  <Text style={styles.senderName}>{sender?.displayName ?? "Member"}</Text>
                ) : null}
                <View style={[styles.bubble, mine ? styles.mineBubble : styles.theirBubble]}>
                  <Text style={styles.messageText}>{message.body}</Text>
                  <View style={styles.messageMeta}>
                    <Text style={styles.metaText}>{formatTime(message.createdAt)}</Text>
                    {mine ? <Ionicons color={colors.faint} name="checkmark-done" size={15} /> : null}
                  </View>
                </View>
              </View>
            );
          })
        ) : (
          <EmptyState icon="lock-closed-outline" title="No messages" copy="Send the first message in this conversation." compact />
        )}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          multiline
          onChangeText={setDraft}
          onSubmitEditing={onSend}
          placeholder="Message"
          placeholderTextColor={colors.faint}
          style={styles.composerInput}
          value={draft}
        />
        <Pressable
          accessibilityLabel="Send message"
          disabled={!draft.trim()}
          onPress={onSend}
          style={[styles.sendButton, !draft.trim() && styles.buttonDisabled]}
        >
          <Ionicons color="#FFFFFF" name="send" size={20} />
        </Pressable>
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
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
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
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Create group</Text>
          <TextInput onChangeText={setTitle} placeholder="Group name" placeholderTextColor={colors.faint} style={styles.modalInput} value={title} />
          <ContactPicker contacts={contacts} selected={selected} toggle={toggle} />
          <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Create" disabled={!title.trim()} />
        </View>
      </View>
    </Modal>
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
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Add members</Text>
          <ContactPicker contacts={available} selected={selected} toggle={toggle} />
          <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Add" disabled={!selected.length} />
        </View>
      </View>
    </Modal>
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
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>New status</Text>
          <TextInput multiline onChangeText={setText} placeholder="Share a quick update" placeholderTextColor={colors.faint} style={[styles.modalInput, styles.statusInput]} value={text} />
          <ModalActions onCancel={onClose} onSubmit={submit} submitLabel="Post" disabled={!text.trim()} />
        </View>
      </View>
    </Modal>
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
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Profile</Text>
          <TextInput onChangeText={setDisplayName} placeholder="Display name" placeholderTextColor={colors.faint} style={styles.modalInput} value={displayName} />
          <TextInput onChangeText={setAbout} placeholder="About" placeholderTextColor={colors.faint} style={styles.modalInput} value={about} />
          <ModalActions onCancel={onClose} onSubmit={() => onSave(displayName, about)} submitLabel="Save" disabled={!displayName.trim()} />
        </View>
      </View>
    </Modal>
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
        <Pressable onPress={onSubmit} style={[styles.primaryButton, disabled && styles.buttonDisabled]}>
          <Text style={styles.primaryText}>{submitLabel ?? "Save"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.page },
  loadingScreen: { flex: 1, alignItems: "center", justifyContent: "center" },
  loginScreen: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: colors.page },
  loginMark: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
    ...shadow,
  },
  loginTitle: { color: colors.ink, fontSize: 30, fontWeight: "900", marginTop: 22 },
  loginCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 8, maxWidth: 420 },
  loginForm: { marginTop: 28, gap: 12, maxWidth: 440 },
  loginInput: {
    height: 52,
    borderRadius: radii.md,
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
    backgroundColor: "#EEF8FF",
    borderRightColor: colors.line,
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
    backgroundColor: colors.primary,
    ...shadow,
  },
  navStack: { flex: 1, width: "100%", gap: 8 },
  navItem: { minHeight: 62, alignItems: "center", justifyContent: "center", borderRadius: radii.md, gap: 4 },
  navItemActive: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1 },
  navLabel: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  navLabelActive: { color: colors.primaryDark },
  composeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primaryDark,
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
    backgroundColor: colors.surface,
  },
  headerMobile: { minHeight: 62, paddingHorizontal: 16 },
  appName: { color: colors.ink, fontSize: 24, fontWeight: "900", letterSpacing: 0 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  errorBar: { color: colors.danger, backgroundColor: "#FFF0F0", paddingHorizontal: 14, paddingVertical: 8 },
  content: { flex: 1, flexDirection: "row", padding: 18, gap: 18 },
  contentMobile: { padding: 0, paddingBottom: 72 },
  listPanel: {
    width: Platform.select({ web: 390, default: 330 }),
    maxWidth: "100%",
    borderRadius: radii.lg,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  mobilePanel: { flex: 1, width: "100%", borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0, borderTopWidth: 0 },
  panelTitle: {
    minHeight: 72,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  panelHeading: { color: colors.ink, fontSize: 24, fontWeight: "900" },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceBlue,
  },
  bottomTabs: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: 72,
    paddingTop: 8,
    paddingBottom: Platform.select({ ios: 18, default: 10 }),
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
  chatRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radii.md },
  chatRowActive: { backgroundColor: colors.surfaceBlue },
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
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  chatTitle: { color: colors.ink, fontSize: 15, fontWeight: "800" },
  chatTime: { color: colors.faint, fontSize: 11 },
  chatPreview: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  chatPane: {
    flex: 1,
    minWidth: 0,
    borderRadius: radii.lg,
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: "#F8FCFF",
    overflow: "hidden",
  },
  chatPaneMobile: { borderRadius: 0, borderWidth: 0 },
  chatHeader: {
    minHeight: 74,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    backgroundColor: colors.surface,
    gap: 10,
  },
  chatHeaderTitle: { color: colors.ink, fontSize: 17, fontWeight: "900" },
  chatHeaderSub: { color: colors.muted, fontSize: 12 },
  messageList: { flexGrow: 1, padding: 18, gap: 12 },
  messageWrap: { maxWidth: "78%" },
  messageMine: { alignSelf: "flex-end" },
  messageTheirs: { alignSelf: "flex-start" },
  senderName: { color: colors.primaryDark, fontSize: 12, fontWeight: "800", marginBottom: 4, marginLeft: 8 },
  bubble: { padding: 11, borderRadius: 14, gap: 6 },
  mineBubble: { backgroundColor: colors.bubbleMine, borderTopRightRadius: 4 },
  theirBubble: { backgroundColor: colors.bubbleTheirs, borderTopLeftRadius: 4, borderColor: colors.line, borderWidth: 1 },
  messageText: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  messageMeta: { alignSelf: "flex-end", flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { color: colors.faint, fontSize: 10 },
  composer: {
    padding: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    backgroundColor: colors.surface,
  },
  composerInput: {
    flex: 1,
    minHeight: 42,
    maxHeight: 110,
    borderRadius: 21,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.ink,
    backgroundColor: colors.page,
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
