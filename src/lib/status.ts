import { StatusPost } from "@/features/chats/types";

export function isStatusActive(status: StatusPost, now = new Date()) {
  return new Date(status.expiresAt).getTime() > now.getTime();
}

export function statusExpiresAt(createdAt = new Date()) {
  return new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
}
