export type BackendProfile = {
  id: string;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  about: string;
  isOnline: boolean;
  lastSeenAt: string | null;
};

export type BackendTaskmanagerMentionUser = {
  taskmanagerUserId: string;
  orbitaUserId: string | null;
  displayName: string;
  phone: string | null;
  avatarUrl: string | null;
  departmentIds: string[];
};

export type BackendTaskmanagerMentionDepartment = {
  departmentId: string;
  name: string;
  memberUserIds: string[];
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
    taskmanagerOrgName?: string | null;
    taskmanagerUserId: string;
    agentProfileId: string;
  } | null;
  taskThread?: {
    taskmanagerOrgId: string;
    taskmanagerOrgName?: string | null;
    taskmanagerTaskId: string;
    taskNumber: string;
    agentProfileId: string;
    sourceAgentConversationId: string | null;
    parentTaskId: string | null;
    rootTaskId: string;
    status: string;
    title: string;
    dueDate?: string | null;
    departmentIds?: string[];
    departmentNames?: string[];
    memberUserIds?: string[];
    pendingMemberUserIds?: string[];
    updatedAt?: string | null;
  } | null;
};

export type BackendAttachment = {
  id: string;
  kind: "image" | "video" | "document" | "audio" | "voice";
  mimeType: string;
  filename: string;
  sizeBytes: number;
  durationMs: number | null;
  url: string;
  waveformSamples?: number[] | null;
};

export type BackendReplyPreview = {
  messageId: string;
  senderId: string;
  body: string;
  kind: "text" | "image" | "video" | "document" | "audio" | "voice";
};

export type BackendMessageSystem = {
  kind?: string;
  event?: string;
  status?: string;
  taskmanagerOrgId?: string;
  taskmanagerTaskId?: string;
  taskNumber?: string;
  title?: string;
  parentTaskId?: string | null;
  rootTaskId?: string | null;
  taskThreadConversationId?: string | null;
  conversationId?: string | null;
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
  replyTo?: BackendReplyPreview | null;
  replyToMessageId?: string | null;
  system?: BackendMessageSystem | null;
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
