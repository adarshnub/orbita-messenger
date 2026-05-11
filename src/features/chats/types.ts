export type UserProfile = {
  id: string;
  displayName: string;
  phone: string;
  avatarColor: string;
  about: string;
  lastSeen: string;
  isOnline?: boolean;
};

export type MessageKind = "text" | "image" | "video" | "document" | "audio" | "voice";
export type MessageStatus = "sending" | "sent" | "delivered" | "read";

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  kind: MessageKind;
  body: string;
  createdAt: string;
  status: MessageStatus;
  replyToId?: string;
  reactions?: Record<string, string>;
  encryptedPayload?: string;
};

export type Conversation = {
  id: string;
  title: string;
  kind: "direct" | "group";
  participantIds: string[];
  adminIds?: string[];
  avatarColor: string;
  muted?: boolean;
  pinned?: boolean;
  archived?: boolean;
  inviteCode?: string;
};

export type StatusPost = {
  id: string;
  authorId: string;
  kind: "text" | "image" | "video";
  text: string;
  mediaUrl?: string;
  createdAt: string;
  expiresAt: string;
  viewedBy: string[];
  visibility: "contacts" | "selected" | "excluded";
};
