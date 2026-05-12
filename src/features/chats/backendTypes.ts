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
  kind: "direct" | "group";
  title: string;
  avatarUrl: string | null;
  inviteCode: string | null;
  createdAt: string;
  updatedAt: string;
  participants: Array<BackendProfile & { role: "owner" | "admin" | "member" }>;
  lastMessage: BackendMessage | null;
  unreadCount: number;
};

export type BackendMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  kind: "text" | "image" | "video" | "document" | "audio" | "voice";
  body: string;
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
