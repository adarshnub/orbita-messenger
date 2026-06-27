import { BackendAttachment, BackendMessage } from "./backendTypes";

export function formatDurationMs(durationMs?: number | null) {
  const safeDurationMs = Number.isFinite(durationMs) ? durationMs ?? 0 : 0;
  const totalSeconds = Math.max(0, Math.round(safeDurationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatBytes(bytes?: number | null) {
  const value = Math.max(0, bytes ?? 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

export function messageAttachmentLabel(message: Pick<BackendMessage, "kind" | "attachments">) {
  const attachment = message.attachments?.[0];
  if (!attachment) return "";
  if (message.kind === "voice" || message.kind === "audio") return "Voice note";
  if (message.kind === "image") return "Photo";
  return attachment.filename ? `Document: ${attachment.filename}` : "Document";
}

export function messagePreviewText(message: Pick<BackendMessage, "body" | "kind" | "attachments"> | null) {
  if (!message) return "";
  const body = message.body.trim();
  return body || messageAttachmentLabel(message);
}

export function attachmentFromMessage(message: Pick<BackendMessage, "attachments"> | null): BackendAttachment | null {
  return message?.attachments?.[0] ?? null;
}
