export type BackendProfile = {
  id: string;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  about: string;
  isOnline: boolean;
  lastSeenAt: string | null;
};

export type BackendConversation = {
  id: string;
  kind: "direct" | "group" | "taskmanager";
  title: string;
  avatarUrl: string | null;
  inviteCode: string | null;
  createdAt: string;
  updatedAt: string;
  participants: Array<BackendProfile & { role: "owner" | "admin" | "member" }>;
  lastMessage: BackendMessage | null;
  unreadCount: number;
  taskManagerAgent?: {
    taskmanagerOrgId: string;
    taskmanagerUserId: string;
    agentProfileId: string;
  } | null;
  taskThread?: {
    taskmanagerOrgId: string;
    taskmanagerTaskId: string;
    taskNumber: string;
    agentProfileId: string;
    sourceAgentConversationId: string | null;
    parentTaskId: string | null;
    rootTaskId: string;
    status: string;
    title: string;
  } | null;
};

export type BackendAttachment = {
  id: string;
  kind: "image" | "document" | "audio" | "voice";
  mimeType: string;
  filename: string;
  sizeBytes: number;
  durationMs: number | null;
  url: string;
  waveformSamples?: number[] | null;
};

export type BackendMessage = {
  id: string;
  clientMessageId?: string | null;
  conversationId: string;
  senderId: string;
  kind: "text" | "image" | "video" | "document" | "audio" | "voice";
  body: string;
  attachments: BackendAttachment[];
  forwardedFrom?: {
    messageId: string;
    senderName: string;
    conversationTitle: string;
  } | null;
  createdAt: string;
  status: "sent" | "delivered" | "read";
};

export type BackendStatus = {
  id: string;
  author: BackendProfile;
  kind: "text" | "image" | "video";
  text: string;
  mediaUrl: string | null;
  visibility: "contacts" | "selected" | "excluded";
  createdAt: string;
  expiresAt: string;
  viewCount: number;
};

export type BootstrapPayload = {
  profile: BackendProfile;
  contacts: BackendProfile[];
  conversations: BackendConversation[];
  statuses: BackendStatus[];
};
