import { createHmac, createHash, randomUUID, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

loadEnv();

const port = Number(process.env.ORBITA_API_PORT ?? process.env.PORT ?? 8787);
const host = process.env.ORBITA_API_HOST ?? "0.0.0.0";
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  const missing = [
    !supabaseUrl ? "SUPABASE_URL or EXPO_PUBLIC_SUPABASE_URL" : null,
    !serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
  ].filter(Boolean);
  console.error(`Missing ${missing.join(", ")}.`);
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    transport: WebSocket,
  },
});

const TASK_MANAGER_ORBITA_CHANNEL = "orbita";
const TASK_MANAGER_WEBHOOK_TIMEOUT_MS = 20_000;
const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const PUSH_DEBUG = process.env.ORBITA_PUSH_DEBUG === "1";
const TASK_ACK_SYSTEM_KIND = "task_acknowledgement";
const TASK_REQUEST_SYSTEM_KIND = "task_request";
const ACKNOWLEDGEMENT_PATTERNS = [
  /\b(?:ack|acknowledge|acknowledged|acknowledgement)\b/i,
  /\b(?:noted|understood|received|got it|will do|i'?ll do it|i will do it|on it)\b/i,
];
const TASK_REQUEST_PATTERNS = [
  /\b(?:task|tasks|assign|assigned|assignment)\b/i,
  /\b(?:please|kindly)\b.*\b(?:do|complete|finish|send|share|review|update|follow\s*up|call|meet)\b/i,
  /\b(?:asked|requested|wants|would\s+like|needs)\b.*\b(?:you|your)\b/i,
  /\b(?:prepare|complete|finish|send|share|review|update|follow\s*up|call|meet|get\s+it\s+ready)\b/i,
];

const TASK_MANAGER_ADMIN_SESSION_URL =
  process.env.TASK_MANAGER_ORBITA_ADMIN_SESSION_URL ||
  process.env.TASK_MANAGER_ADMIN_SESSION_URL ||
  deriveTaskManagerAdminSessionUrl(process.env.TASK_MANAGER_ORBITA_WEBHOOK_URL);
const TASK_MANAGER_ORBITA_SUBTASK_URL =
  process.env.TASK_MANAGER_ORBITA_SUBTASK_URL ||
  deriveTaskManagerSubtaskUrl(process.env.TASK_MANAGER_ORBITA_WEBHOOK_URL);
const TASK_MANAGER_ORBITA_TASK_SHELL_URL =
  process.env.TASK_MANAGER_ORBITA_TASK_SHELL_URL ||
  deriveTaskManagerTaskShellUrl(process.env.TASK_MANAGER_ORBITA_WEBHOOK_URL);
const TASK_MANAGER_ORBITA_TASK_THREAD_STATUS_URL =
  process.env.TASK_MANAGER_ORBITA_TASK_THREAD_STATUS_URL ||
  deriveTaskManagerTaskThreadStatusUrl(process.env.TASK_MANAGER_ORBITA_WEBHOOK_URL);

createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method === "OPTIONS") {
    sendNoContent(res, 204, req);
    return;
  }

  try {
    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "orbita-backend" }, req);
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed." }, req);
      return;
    }

    if (pathname === "/api/messenger/media") {
      const authHeader = String(req.headers.authorization ?? "");
      if (!authHeader) {
        sendJson(res, 401, { error: "Missing authorization." }, req);
        return;
      }

      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      const { data, error } = await supabase.auth.getUser(jwt);
      if (error || !data.user) {
        sendJson(res, 401, { error: "Invalid session." }, req);
        return;
      }

      const request = new Request(`http://localhost${req.url ?? "/api/messenger/media"}`, {
        method: "POST",
        headers: req.headers,
        body: req,
        duplex: "half",
      });
      const form = await request.formData();
      sendJson(res, 200, await uploadMediaAttachment(data.user.id, form), req);
      return;
    }

    if (pathname === "/api/messenger/avatar") {
      const authHeader = String(req.headers.authorization ?? "");
      if (!authHeader) {
        sendJson(res, 401, { error: "Missing authorization." }, req);
        return;
      }

      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      const { data, error } = await supabase.auth.getUser(jwt);
      if (error || !data.user) {
        sendJson(res, 401, { error: "Invalid session." }, req);
        return;
      }

      const request = new Request(`http://localhost${req.url ?? "/api/messenger/avatar"}`, {
        method: "POST",
        headers: req.headers,
        body: req,
        duplex: "half",
      });
      const form = await request.formData();
      sendJson(res, 200, await uploadProfileAvatar(data.user.id, form), req);
      return;
    }

    const rawBody = await readBody(req);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const action = requiredString(body, "action");
    const payload = isRecord(body.payload) ? body.payload : {};

    if (pathname === "/api/service") {
      const validSignature = verifyIntegrationSignature(
        rawBody,
        req.headers["x-orbita-signature"],
        process.env.TASK_MANAGER_ORBITA_SECRET,
      );
      if (!validSignature) {
        sendJson(res, 401, { error: "Invalid Orbita integration signature." }, req);
        return;
      }

      sendJson(res, 200, await handleServiceAction(action, payload), req);
      return;
    }

    if (pathname === "/api/messenger") {
      const authHeader = String(req.headers.authorization ?? "");
      if (!authHeader) {
        sendJson(res, 401, { error: "Missing authorization." }, req);
        return;
      }

      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      const { data, error } = await supabase.auth.getUser(jwt);
      if (error || !data.user) {
        sendJson(res, 401, { error: "Invalid session." }, req);
        return;
      }

      sendJson(res, 200, await handleAction(data.user, action, payload, req), req);
      return;
    }

    sendJson(res, 404, { error: "Route not found." }, req);
  } catch (error) {
    const message = errorMessage(error);
    console.error(message, error);
    sendJson(res, 400, { error: message }, req);
  }
}).listen(port, host, () => {
  console.log(`Orbita backend listening on http://${host}:${port}`);
});

function loadEnv() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const path of [resolve(root, ".env"), resolve(root, ".env.local")]) {
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index === -1) continue;
        const key = trimmed.slice(0, index).trim();
        const rawValue = trimmed.slice(index + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, "");
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch {
      // Optional local env files.
    }
  }
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function allowedCorsOrigin(req) {
  const origin = req.headers.origin;
  const configured = process.env.ORBITA_CORS_ORIGIN;
  if (!configured || configured === "*") return "*";
  const allowed = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return origin && allowed.includes(origin) ? origin : allowed[0] ?? "*";
}

function corsHeaders(req) {
  const headers = {
    "Access-Control-Allow-Origin": allowedCorsOrigin(req),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-orbita-signature",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
  };
  return headers;
}

function sendNoContent(res, status, req) {
  res.writeHead(status, corsHeaders(req));
  res.end();
}

function sendJson(res, status, body, req = null) {
  res.writeHead(status, {
    ...corsHeaders(req ?? { headers: {} }),
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function requiredString(payload, key) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

function optionalString(payload, key) {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeClientPlatform(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "web") return "web";
  if (["ios", "android", "native", "mobile"].includes(normalized)) return "mobile";
  return "";
}

function hasOrbitaMention(text) {
  return /(^|[\s([{"'`])@orbita\b/i.test(String(text ?? ""));
}

function stripOrbitaMention(text) {
  return String(text ?? "")
    .replace(/(^|[\s([{"'`])@orbita\b[:,]?\s*/gi, (match, prefix) => prefix || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function stringArray(payload, key) {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizePhone(phone, defaultCountryCode = "+91") {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  return `+${digits}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256(value, secret) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function deriveTaskManagerAdminSessionUrl(webhookUrl) {
  if (!webhookUrl) return "";
  return webhookUrl.replace(/\/webhooks\/orbita\/messages\/?$/i, "/orbita/admin/sessions");
}

function deriveTaskManagerSubtaskUrl(webhookUrl) {
  if (!webhookUrl) return "";
  return webhookUrl.replace(/\/webhooks\/orbita\/messages\/?$/i, "/webhooks/orbita/task-thread-subtasks");
}

function deriveTaskManagerTaskShellUrl(webhookUrl) {
  if (!webhookUrl) return "";
  return webhookUrl.replace(/\/webhooks\/orbita\/messages\/?$/i, "/webhooks/orbita/task-shells");
}

function deriveTaskManagerTaskThreadStatusUrl(webhookUrl) {
  if (!webhookUrl) return "";
  return webhookUrl.replace(/\/webhooks\/orbita\/messages\/?$/i, "/webhooks/orbita/task-thread-status");
}

function deriveTaskManagerApiBaseUrl(sessionUrl) {
  if (!sessionUrl) return "";
  return sessionUrl.replace(/\/orbita\/admin\/sessions\/?$/i, "");
}

function clientReachableTaskManagerApiBaseUrl(sessionUrl, req) {
  const baseUrl = deriveTaskManagerApiBaseUrl(sessionUrl);
  try {
    const url = new URL(baseUrl);
    if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname)) return baseUrl;
    const requestHost = String(req?.headers?.host ?? "").split(":")[0];
    if (!requestHost || ["localhost", "127.0.0.1", "0.0.0.0"].includes(requestHost)) return baseUrl;
    url.hostname = requestHost;
    return url.toString().replace(/\/$/, "");
  } catch {
    return baseUrl;
  }
}

function verifyIntegrationSignature(rawBody, signature, secret) {
  const signatureValue = Array.isArray(signature) ? signature[0] : signature;
  if (!signatureValue || !secret) return false;
  const expected = `sha256=${hmacSha256(rawBody, secret)}`;
  const actualBuffer = Buffer.from(signatureValue);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && nodeTimingSafeEqual(actualBuffer, expectedBuffer);
}

function isDefaultDisplayName(name) {
  const normalized = typeof name === "string" ? name.trim().toLowerCase() : "";
  return !normalized || normalized === "you" || normalized === "orbita user";
}

function profileDisplayName(row, viewerId = "") {
  const rawName = typeof row.display_name === "string" ? row.display_name.trim() : "";
  if (!isDefaultDisplayName(rawName)) return rawName;
  if (viewerId && row.id === viewerId) return "You";
  return row.phone || "Orbita user";
}

function mapProfile(row, viewerId = "") {
  const nickname = typeof row.nickname === "string" ? row.nickname.trim() : "";
  const displayName = nickname || profileDisplayName(row, viewerId);
  return {
    id: row.id,
    displayName,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    about: row.about,
    isOnline: row.is_online,
    lastSeenAt: row.last_seen_at,
  };
}

async function loadContactNicknames(userId) {
  const { data, error } = await supabase
    .from("contacts")
    .select("contact_user_id, nickname")
    .eq("owner_id", userId);
  if (error) throw error;
  return new Map(
    (data ?? [])
      .map((row) => [row.contact_user_id, typeof row.nickname === "string" ? row.nickname.trim() : ""])
      .filter(([, nickname]) => nickname),
  );
}

function messagePayload(row) {
  return isRecord(row.encrypted_payload) ? row.encrypted_payload : {};
}

function messageBody(row) {
  const payload = messagePayload(row);
  return typeof payload.body === "string" ? payload.body : "";
}

function parseForwardedFrom(payload) {
  if (!isRecord(payload.forwardedFrom)) return null;
  const forwarded = payload.forwardedFrom;
  const messageId = typeof forwarded.messageId === "string" ? forwarded.messageId : "";
  const senderName = typeof forwarded.senderName === "string" ? forwarded.senderName : "";
  const conversationTitle = typeof forwarded.conversationTitle === "string" ? forwarded.conversationTitle : "";
  if (!messageId || !senderName || !conversationTitle) return null;
  return { messageId, senderName, conversationTitle };
}

function parseReplyTo(payload) {
  if (!isRecord(payload.replyTo)) return null;
  const replyTo = payload.replyTo;
  const messageId = typeof replyTo.messageId === "string" ? replyTo.messageId : "";
  const senderId = typeof replyTo.senderId === "string" ? replyTo.senderId : "";
  const body = typeof replyTo.body === "string" ? replyTo.body : "";
  const kind = typeof replyTo.kind === "string" ? replyTo.kind : "text";
  if (!messageId || !senderId) return null;
  return { messageId, senderId, body, kind };
}

function clientReplyPreview(payload, fallbackMessageId = "") {
  if (!isRecord(payload.replyTo)) return null;
  const replyTo = payload.replyTo;
  const messageId =
    (typeof replyTo.messageId === "string" ? replyTo.messageId.trim() : "") ||
    fallbackMessageId.trim();
  const senderId = typeof replyTo.senderId === "string" ? replyTo.senderId.trim() : "";
  const body = typeof replyTo.body === "string" ? compactMessageText(replyTo.body) : "";
  const kind = typeof replyTo.kind === "string" ? replyTo.kind : "text";
  if (!messageId || !senderId) return null;
  return { messageId, senderId, body, kind };
}

function replyToPayloadFields(message) {
  const replyToMessageId = typeof message?.replyToMessageId === "string" ? message.replyToMessageId.trim() : "";
  const replyTo = isRecord(message?.replyTo) ? message.replyTo : null;
  const replyToPreviewId = typeof replyTo?.messageId === "string" ? replyTo.messageId.trim() : "";
  const messageId = replyToMessageId || replyToPreviewId;
  if (!messageId) return {};
  return {
    replyToMessageId: messageId,
    replyTo: replyTo
      ? {
          messageId,
          senderId: typeof replyTo.senderId === "string" ? replyTo.senderId : "",
          body: typeof replyTo.body === "string" ? replyTo.body : "",
          kind: typeof replyTo.kind === "string" ? replyTo.kind : "text",
        }
      : { messageId },
  };
}

function attachmentMetadata(row) {
  return isRecord(row.encrypted_metadata) ? row.encrypted_metadata : {};
}

function normalizeWaveformSamples(value, maxCount = 64) {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(source)) return null;
  const samples = source
    .map((sample) => Number(sample))
    .filter((sample) => Number.isFinite(sample))
    .map((sample) => Math.min(1, Math.max(0, sample)));
  if (!samples.length) return null;
  if (samples.length <= maxCount) {
    return samples.map((sample) => Math.min(1, Math.max(0.08, sample)));
  }

  const result = [];
  for (let index = 0; index < maxCount; index += 1) {
    const start = Math.floor((index / maxCount) * samples.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / maxCount) * samples.length));
    const bucket = samples.slice(start, end);
    const peak = bucket.reduce((max, sample) => Math.max(max, sample), 0);
    const average = bucket.reduce((sum, sample) => sum + sample, 0) / bucket.length;
    result.push(Math.min(1, Math.max(0.08, peak * 0.72 + average * 0.28)));
  }
  return result.length ? result : null;
}

async function postTaskmanagerWebhook(webhookUrl, raw, secret) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TASK_MANAGER_WEBHOOK_TIMEOUT_MS);
  try {
    return await fetch(webhookUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-orbita-signature": `sha256=${hmacSha256(raw, secret)}`,
      },
      body: raw,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ accepted: true, pending: true }),
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function attachmentLabel(messageKind, attachment) {
  if (!attachment) return "";
  if (messageKind === "voice" || messageKind === "audio") return "Voice note";
  if (messageKind === "image") return "Photo";
  const filename = typeof attachment.filename === "string" ? attachment.filename.trim() : "";
  return filename ? `Document: ${filename}` : "Document";
}

function previewTextForMessage(message) {
  const body = typeof message.body === "string" ? message.body.trim() : "";
  if (body) return body;
  return attachmentLabel(message.kind, message.attachments?.[0] ?? null);
}

function sanitizeFilename(name, fallback = "attachment") {
  const cleaned = String(name || fallback)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function messageKindFromAttachment(kind, mimeType = "") {
  const normalizedKind = String(kind || "").toLowerCase();
  if (normalizedKind === "voice" || normalizedKind === "audio") return normalizedKind;
  if (normalizedKind === "image") return "image";
  if (normalizedKind === "document") return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "voice";
  return "document";
}

function storageBucketForMessageKind(kind) {
  return kind === "voice" || kind === "audio" ? "voice-notes" : "chat-media";
}

function mapAttachment(row, signedUrl) {
  const metadata = attachmentMetadata(row);
  const kind = messageKindFromAttachment(metadata.kind, row.mime_type);
  return {
    id: row.id,
    kind,
    mimeType: row.mime_type,
    filename:
      typeof metadata.filename === "string" && metadata.filename.trim()
        ? metadata.filename.trim()
        : sanitizeFilename(row.object_path.split("/").pop() || kind, kind),
    sizeBytes: row.byte_size,
    durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : null,
    url: signedUrl,
    waveformSamples: normalizeWaveformSamples(metadata.waveformSamples),
  };
}

function mapMessage(row, attachments = []) {
  const payload = messagePayload(row);
  return {
    id: row.id,
    clientMessageId: row.client_message_id ?? null,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: messageBody(row),
    attachments,
    forwardedFrom: parseForwardedFrom(payload),
    replyTo: parseReplyTo(payload),
    replyToMessageId: row.reply_to_message_id ?? null,
    system: payload.system ?? null,
    createdAt: row.created_at,
    status: "sent",
  };
}

function compactMessageText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isAcknowledgementText(value) {
  const text = compactMessageText(value);
  if (!text) return false;
  return ACKNOWLEDGEMENT_PATTERNS.some((pattern) => pattern.test(text));
}

function isTaskRequestText(value) {
  const text = compactMessageText(value);
  if (!text) return false;
  return TASK_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function taskSummaryText(value, maxLength = 90) {
  const text = compactMessageText(value);
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeDisplayName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function extractRequesterNameFromRelayText(value) {
  const text = compactMessageText(value);
  if (!text) return "";
  const directMatch = text.match(/(?:^|[!?.]\s*)([a-z][a-z\s'.-]{1,60})\s+asked me to let you know\b/i);
  if (directMatch?.[1]) return directMatch[1].trim();
  const fallbackMatch = text.match(/\b([a-z][a-z\s'.-]{1,60})\s+asked me to\b/i);
  return fallbackMatch?.[1]?.trim() ?? "";
}

function parseTaskAckInfo(payload) {
  if (!isRecord(payload)) return null;
  const system = payload.system;
  if (!isRecord(system)) return null;
  if (system.kind !== TASK_ACK_SYSTEM_KIND) return null;
  const taskMessageId = typeof system.taskMessageId === "string" ? system.taskMessageId : "";
  return taskMessageId ? { taskMessageId } : null;
}

function parseTaskRequestInfo(payload) {
  if (!isRecord(payload)) return null;
  const system = payload.system;
  if (!isRecord(system)) return null;
  if (system.kind !== TASK_REQUEST_SYSTEM_KIND) return null;
  return {
    requesterConversationId:
      typeof system.requesterConversationId === "string" ? system.requesterConversationId : "",
    requesterOrbitaUserId:
      typeof system.requesterOrbitaUserId === "string" ? system.requesterOrbitaUserId : "",
    requesterTaskmanagerUserId:
      typeof system.requesterTaskmanagerUserId === "string" ? system.requesterTaskmanagerUserId : "",
    taskmanagerOrgId:
      typeof system.taskmanagerOrgId === "string" ? system.taskmanagerOrgId : "",
  };
}

function pushPreviewForMessage(kind, body) {
  const text = typeof body === "string" ? body.trim() : "";
  if (text) return text;
  if (kind === "image") return "Photo";
  if (kind === "voice" || kind === "audio") return "Voice note";
  if (kind === "document") return "Document";
  return "New message";
}

function notificationCopyForConversation(conversation, senderName, preview) {
  if (conversation.kind === "group") {
    const groupTitle =
      typeof conversation.title === "string" && conversation.title.trim()
        ? conversation.title.trim()
        : "Group";
    return {
      title: "Orbita",
      subtitle: groupTitle,
      body: `${senderName}: ${preview}`,
    };
  }

  return {
    title: "Orbita",
    subtitle: senderName,
    body: preview,
  };
}

function isExpoPushToken(value) {
  return typeof value === "string" && /^(Exponent|Expo)PushToken\[[^\]]+\]$/.test(value.trim());
}

function chunkArray(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function pushLog(event, payload) {
  console.log(JSON.stringify({ event, ...payload }));
}

function pushError(event, payload) {
  console.error(JSON.stringify({ event, ...payload }));
}

async function filterPushableRecipients(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("profiles")
    .select("id, about")
    .in("id", ids);
  if (error) throw error;

  const agentIds = new Set(
    (data ?? [])
      .filter((row) => typeof row.about === "string" && row.about.trim().toLowerCase() === "task manager agent")
      .map((row) => row.id),
  );
  return ids.filter((id) => !agentIds.has(id));
}

async function sendPushNotificationsForMessage({
  body,
  conversationId,
  kind,
  messageId,
  recipientUserIds,
  senderId,
  source = "message",
}) {
  const recipients = await filterPushableRecipients(recipientUserIds);
  if (!recipients.length) {
    pushLog("push.no_recipients", { conversationId, messageId, senderId, source });
    return;
  }

  const [senderRes, conversationRes, recipientRes] = await Promise.all([
    supabase.from("profiles").select("id, display_name").eq("id", senderId).single(),
    supabase.from("conversations").select("id, kind, title").eq("id", conversationId).single(),
    supabase.from("profiles").select("id, expo_push_token").in("id", recipients),
  ]);
  if (senderRes.error) throw senderRes.error;
  if (conversationRes.error) throw conversationRes.error;
  if (recipientRes.error) throw recipientRes.error;

  const senderName = profileDisplayName(senderRes.data, "");
  const conversation = conversationRes.data;
  const notificationBody = pushPreviewForMessage(kind, body);
  const copy = notificationCopyForConversation(conversation, senderName, notificationBody);
  const tokens = [...new Set((recipientRes.data ?? [])
    .map((row) => (typeof row.expo_push_token === "string" ? row.expo_push_token.trim() : ""))
    .filter(isExpoPushToken))];
  if (!tokens.length) {
    pushLog("push.no_tokens", { conversationId, messageId, recipients, source });
    return;
  }

  const accessToken = process.env.EXPO_PUSH_ACCESS_TOKEN?.trim();
  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "Content-Type": "application/json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };

  const messages = tokens.map((to) => ({
    to,
    title: copy.title,
    subtitle: copy.subtitle,
    body: copy.body,
    data: { conversationId, messageId, senderId },
    sound: "default",
    channelId: "messages",
    priority: "high",
  }));
  pushLog("push.sending", {
    conversationId,
    messageId,
    recipients: recipients.length,
    tokens: tokens.length,
    title: copy.title,
    subtitle: copy.subtitle,
    source,
  });

  for (const batch of chunkArray(messages, 100)) {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(batch),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      pushError("push.send_failed", { conversationId, messageId, status: response.status, payload, source });
      continue;
    }
    const resultData = Array.isArray(payload?.data) ? payload.data : [];
    const erroredTickets = resultData.filter((item) => item?.status === "error");
    if (erroredTickets.length) {
      pushError("push.ticket_errors", { conversationId, messageId, errors: erroredTickets, source });
    } else {
      pushLog("push.ticket_ok", {
        conversationId,
        messageId,
        ticketIds: resultData.map((item) => item?.id).filter(Boolean),
        source,
      });
    }
  }
}

async function createRealtimeEvents(targetUserIds, kind, conversationId, payload = {}) {
  const uniqueTargetIds = [...new Set(targetUserIds)].filter(Boolean);
  if (!uniqueTargetIds.length) return;

  const { error } = await supabase.from("realtime_events").insert(
    uniqueTargetIds.map((targetUserId) => ({
      target_user_id: targetUserId,
      conversation_id: conversationId,
      kind,
      payload,
    })),
  );
  if (error) throw error;
}

async function signedAttachmentUrl(row, expiresIn = 60 * 60) {
  const { data, error } = await supabase.storage.from(row.bucket).createSignedUrl(row.object_path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

async function loadAttachmentRowsForMessageIds(messageIds) {
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (!ids.length) return new Map();

  const { data, error } = await supabase
    .from("media_attachments")
    .select("*")
    .in("message_id", ids)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = data ?? [];
  const signedUrls = await Promise.all(rows.map((row) => signedAttachmentUrl(row)));
  const byMessageId = new Map();
  rows.forEach((row, index) => {
    const messageId = row.message_id;
    if (!messageId) return;
    const mapped = mapAttachment(row, signedUrls[index]);
    if (!byMessageId.has(messageId)) byMessageId.set(messageId, []);
    byMessageId.get(messageId).push(mapped);
  });
  return byMessageId;
}

async function getOwnedStagedAttachment(userId, attachmentId) {
  const { data, error } = await supabase
    .from("media_attachments")
    .select("*")
    .eq("id", attachmentId)
    .eq("owner_id", userId)
    .is("message_id", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Attachment is missing or no longer available.");
  return data;
}

async function linkAttachmentToMessage(attachmentRow, messageId) {
  const metadata = {
    ...attachmentMetadata(attachmentRow),
    status: "attached",
  };
  const { data, error } = await supabase
    .from("media_attachments")
    .update({
      message_id: messageId,
      encrypted_metadata: metadata,
    })
    .eq("id", attachmentRow.id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function cloneAttachmentForMessage(attachmentRow, ownerId, messageId) {
  const metadata = {
    ...attachmentMetadata(attachmentRow),
    status: "attached",
  };
  const { data, error } = await supabase
    .from("media_attachments")
    .insert({
      message_id: messageId,
      owner_id: ownerId,
      bucket: attachmentRow.bucket,
      object_path: attachmentRow.object_path,
      mime_type: attachmentRow.mime_type,
      byte_size: attachmentRow.byte_size,
      encrypted_metadata: metadata,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function uploadMediaAttachment(userId, form) {
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("file is required.");
  }

  const requestedKind = String(form.get("kind") ?? "").trim();
  const durationMs = Number(form.get("durationMs") ?? 0);
  const waveformSamples = normalizeWaveformSamples(form.get("waveformSamples"));
  const filename = sanitizeFilename(String(form.get("filename") ?? file.name ?? requestedKind ?? "attachment"));
  const mimeType = typeof file.type === "string" && file.type ? file.type : "application/octet-stream";
  const kind = messageKindFromAttachment(requestedKind || undefined, mimeType);
  const buffer = Buffer.from(await file.arrayBuffer());
  const bucket = storageBucketForMessageKind(kind);
  const objectPath = `${userId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${filename}`;

  console.info("[orbita-media-upload] received", {
    userId,
    requestedKind,
    kind,
    filename,
    mimeType,
    byteLength: buffer.byteLength,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    waveformSamples: waveformSamples?.length ?? 0,
  });

  const { error: uploadError } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from("media_attachments")
    .insert({
      owner_id: userId,
      bucket,
      object_path: objectPath,
      mime_type: mimeType,
      byte_size: buffer.byteLength,
      encrypted_metadata: {
        filename,
        durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
        waveformSamples,
        kind,
        status: "staged",
      },
    })
    .select("*")
    .single();
  if (error) {
    await supabase.storage.from(bucket).remove([objectPath]).catch(() => undefined);
    throw error;
  }

  console.info("[orbita-media-upload] staged", {
    userId,
    attachmentId: data.id,
    kind,
    bucket,
    byteLength: buffer.byteLength,
  });

  return {
    attachment: mapAttachment(data, await signedAttachmentUrl(data, 12 * 60 * 60)),
  };
}

async function createServiceAttachment(ownerId, input) {
  if (!isRecord(input)) return null;
  const dataBase64 = typeof input.dataBase64 === "string" ? input.dataBase64 : "";
  if (!dataBase64) return null;

  const mimeType =
    typeof input.mimeType === "string" && input.mimeType.trim()
      ? input.mimeType.trim()
      : "application/octet-stream";
  const requestedKind = typeof input.kind === "string" ? input.kind : "";
  const kind = messageKindFromAttachment(requestedKind, mimeType);
  const filename = sanitizeFilename(
    typeof input.filename === "string" && input.filename.trim()
      ? input.filename
      : `${kind}-${Date.now()}`,
  );
  const buffer = Buffer.from(dataBase64, "base64");
  if (!buffer.byteLength) throw new Error("Attachment body is empty.");

  const bucket = storageBucketForMessageKind(kind);
  const objectPath = `${ownerId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${filename}`;
  const { error: uploadError } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from("media_attachments")
    .insert({
      owner_id: ownerId,
      bucket,
      object_path: objectPath,
      mime_type: mimeType,
      byte_size: buffer.byteLength,
      encrypted_metadata: {
        filename,
        durationMs: typeof input.durationMs === "number" && input.durationMs > 0 ? Math.round(input.durationMs) : null,
        kind,
        source: "taskmanager",
        status: "staged",
      },
    })
    .select("*")
    .single();
  if (error) {
    await supabase.storage.from(bucket).remove([objectPath]).catch(() => undefined);
    throw error;
  }
  return data;
}

async function uploadProfileAvatar(userId, form) {
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("file is required.");
  }

  const mimeType = typeof file.type === "string" && file.type ? file.type : "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    throw new Error("Only image files are supported for profile avatars.");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const bucket = "profile-images";
  const filename = sanitizeFilename(String(form.get("filename") ?? file.name ?? "avatar.jpg"), "avatar.jpg");
  const objectPath = `${userId}/avatars/${Date.now()}-${filename}`;

  const { error: uploadError } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const publicUrl = supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
  if (!publicUrl) throw new Error("Unable to generate avatar URL.");

  const { data, error } = await supabase
    .from("profiles")
    .update({ avatar_url: publicUrl, updated_at: new Date().toISOString() })
    .eq("id", userId)
    .select()
    .single();
  if (error) throw error;

  return {
    profile: mapProfile(data, userId),
    avatar: {
      bucket,
      objectPath,
      url: publicUrl,
    },
  };
}

async function insertMessageWithReceipts(conversationId, senderId, kind, payload, options = {}) {
  const { data: message, error } = await supabase
    .from("messages")
    .insert({
      client_message_id: options.clientMessageId ?? null,
      conversation_id: conversationId,
      sender_id: senderId,
      kind,
      encrypted_payload: payload,
      reply_to_message_id: options.replyToMessageId ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  const { error: updateError } = await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (updateError) throw updateError;

  const { data: participants, error: participantError } = await supabase
    .from("conversation_participants")
    .select("user_id")
    .eq("conversation_id", conversationId)
    .neq("user_id", senderId);
  if (participantError) throw participantError;

  if (participants?.length) {
    const { error: receiptError } = await supabase.from("message_receipts").insert(
      participants.map((participant) => ({
        message_id: message.id,
        user_id: participant.user_id,
        status: "sent",
      })),
    );
    if (receiptError) throw receiptError;

    await createRealtimeEvents(
      participants.map((participant) => participant.user_id),
      "message_created",
      conversationId,
      { messageId: message.id, senderId },
    );

    const pushPromise = sendPushNotificationsForMessage({
      body: typeof payload?.body === "string" ? payload.body : "",
      conversationId,
      kind,
      messageId: message.id,
      recipientUserIds: participants.map((participant) => participant.user_id),
      senderId,
      source: options.pushSource ?? "message",
    }).catch((error) => {
      console.error(errorMessage(error), error);
    });
    if (options.awaitPush) {
      await pushPromise;
    }
  }

  return message;
}

async function buildReplyPreview(conversationId, replyToMessageId) {
  if (!replyToMessageId) return null;
  const { data: replyToMessage, error } = await supabase
    .from("messages")
    .select("*")
    .eq("id", replyToMessageId)
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!replyToMessage) throw new Error("Reply target was not found in this conversation.");

  const { data: attachments, error: attachmentError } = await supabase
    .from("media_attachments")
    .select("*")
    .eq("message_id", replyToMessage.id)
    .order("created_at", { ascending: true })
    .limit(1);
  if (attachmentError) throw attachmentError;

  const firstAttachment = attachments?.[0] ?? null;
  return {
    messageId: replyToMessage.id,
    senderId: replyToMessage.sender_id,
    body: compactMessageText(messageBody(replyToMessage)) || attachmentLabel(replyToMessage.kind, firstAttachment),
    kind: replyToMessage.kind,
  };
}

async function buildReplyInsertOptions(conversationId, payload) {
  const replyToMessageId =
    optionalString(payload, "replyToMessageId") ||
    optionalString(payload, "replyToTaskmanagerChatMessageId") ||
    optionalString(payload, "replyToChatMessageId");
  const replyTo = await buildReplyPreview(conversationId, replyToMessageId);
  return {
    replyTo,
    replyToMessageId: replyTo?.messageId ?? null,
  };
}

async function mapMessageWithAttachments(message) {
  const attachments = await loadAttachmentRowsForMessageIds([message.id]).then((map) => map.get(message.id) ?? []);
  return mapMessage(message, attachments);
}

async function maybeSendTaskAcknowledgementMessage(conversationId, acknowledgerId, acknowledgementBody) {
  if (!isAcknowledgementText(acknowledgementBody)) return null;

  const { data: recentIncoming, error: incomingError } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .neq("sender_id", acknowledgerId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(40);
  if (incomingError) throw incomingError;

  let taskMessage = null;
  for (const row of recentIncoming ?? []) {
    const payload = messagePayload(row);
    if (parseTaskAckInfo(payload)) continue;
    const body = messageBody(row);
    if (!parseTaskRequestInfo(payload) && !isTaskRequestText(body)) continue;
    taskMessage = row;
    break;
  }
  if (!taskMessage) return null;

  const { data: taskSenderProfile, error: taskSenderProfileError } = await supabase
    .from("profiles")
    .select("id, about")
    .eq("id", taskMessage.sender_id)
    .single();
  if (taskSenderProfileError) throw taskSenderProfileError;
  const senderAbout = typeof taskSenderProfile.about === "string" ? taskSenderProfile.about.trim().toLowerCase() : "";
  const taskRequestInfo = parseTaskRequestInfo(messagePayload(taskMessage));
  let acknowledgementConversationId = conversationId;
  let acknowledgementSenderId = acknowledgerId;
  let acknowledgementTargetId = taskMessage.sender_id;

  if (senderAbout === "task manager agent") {
    const missingTaskRequestMetadata =
      !taskRequestInfo?.requesterConversationId && !taskRequestInfo?.requesterTaskmanagerUserId;
    const inferredRequesterName = extractRequesterNameFromRelayText(messageBody(taskMessage));

    let requesterLink = null;
    if (taskRequestInfo?.requesterConversationId) {
      const { data, error } = await supabase
        .from("taskmanager_agent_links")
        .select("*")
        .eq("conversation_id", taskRequestInfo.requesterConversationId)
        .eq("enabled", true)
        .maybeSingle();
      if (error) throw error;
      requesterLink = data;
    }

    if (!requesterLink && taskRequestInfo?.requesterTaskmanagerUserId && taskRequestInfo?.taskmanagerOrgId) {
      const { data, error } = await supabase
        .from("taskmanager_agent_links")
        .select("*")
        .eq("taskmanager_org_id", taskRequestInfo.taskmanagerOrgId)
        .eq("taskmanager_user_id", taskRequestInfo.requesterTaskmanagerUserId)
        .eq("enabled", true)
        .maybeSingle();
      if (error) throw error;
      requesterLink = data;
    }

    let candidateLinks = null;
    let requesterNameByOrbitaId = new Map();
    const loadRequesterCandidates = async () => {
      if (candidateLinks) return;
      const { data: linksData, error: linksError } = await supabase
        .from("taskmanager_agent_links")
        .select("*")
        .eq("enabled", true)
        .eq("agent_profile_id", taskMessage.sender_id);
      if (linksError) throw linksError;
      candidateLinks = linksData ?? [];

      const requesterOrbitaIds = [...new Set(candidateLinks.map((row) => row.orbita_user_id).filter(Boolean))];
      if (!requesterOrbitaIds.length) return;
      const { data: requesterProfiles, error: requesterProfilesError } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", requesterOrbitaIds);
      if (requesterProfilesError) throw requesterProfilesError;
      requesterNameByOrbitaId = new Map(
        (requesterProfiles ?? []).map((profile) => [profile.id, normalizeDisplayName(profile.display_name)]),
      );
    };

    const findRequesterLinkByName = (name) => {
      const wanted = normalizeDisplayName(name);
      if (!wanted || !candidateLinks?.length) return null;
      return (
        candidateLinks.find((row) => requesterNameByOrbitaId.get(row.orbita_user_id) === wanted) ??
        candidateLinks.find((row) => {
          const displayName = requesterNameByOrbitaId.get(row.orbita_user_id) ?? "";
          return displayName.startsWith(wanted) || wanted.startsWith(displayName);
        }) ??
        null
      );
    };

    // Backward-compatibility path for older relayed messages that were stored
    // without system metadata. Infer requester by parsing "X asked me to let you know".
    if (!requesterLink && missingTaskRequestMetadata && inferredRequesterName) {
      await loadRequesterCandidates();
      requesterLink = findRequesterLinkByName(inferredRequesterName);
    }

    // Metadata may point to a stale/wrong requester. If relay text says a
    // specific requester name and we can map it, prefer the text match.
    if (requesterLink && inferredRequesterName) {
      await loadRequesterCandidates();
      const metadataName = requesterNameByOrbitaId.get(requesterLink.orbita_user_id) ?? "";
      const inferredName = normalizeDisplayName(inferredRequesterName);
      if (inferredName && metadataName && metadataName !== inferredName) {
        const textMatchedRequester = findRequesterLinkByName(inferredRequesterName);
        if (textMatchedRequester?.conversation_id && textMatchedRequester.id !== requesterLink.id) {
          if (PUSH_DEBUG) {
            console.log("[ack] requester overridden by relay text", {
              taskMessageId: taskMessage.id,
              metadataRequester: metadataName,
              inferredRequester: inferredName,
            });
          }
          requesterLink = textMatchedRequester;
        }
      }
    }

    if (!requesterLink?.conversation_id || !requesterLink?.agent_profile_id) {
      if (PUSH_DEBUG) {
        console.log("[ack] skip: requester link unresolved", {
          conversationId,
          taskMessageId: taskMessage.id,
          acknowledgerId,
          hasTaskRequestMetadata: !missingTaskRequestMetadata,
          inferredRequesterName: inferredRequesterName || null,
        });
      }
      return null;
    }

    acknowledgementConversationId = requesterLink.conversation_id;
    acknowledgementSenderId = requesterLink.agent_profile_id;
    acknowledgementTargetId = requesterLink.orbita_user_id;
  }

  const { data: ownRecentMessages, error: ownMessagesError } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", acknowledgementConversationId)
    .eq("sender_id", acknowledgementSenderId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(40);
  if (ownMessagesError) throw ownMessagesError;

  const alreadyNotified = (ownRecentMessages ?? []).some((row) => {
    const ackInfo = parseTaskAckInfo(messagePayload(row));
    return ackInfo?.taskMessageId === taskMessage.id;
  });
  if (alreadyNotified) return null;

  const { data: acknowledgerProfile, error: acknowledgerProfileError } = await supabase
    .from("profiles")
    .select("id, display_name, phone")
    .eq("id", acknowledgerId)
    .single();
  if (acknowledgerProfileError) throw acknowledgerProfileError;

  const acknowledgerName = profileDisplayName(acknowledgerProfile, "");
  const summary = taskSummaryText(messageBody(taskMessage));
  const acknowledgementText = taskSummaryText(acknowledgementBody, 80);
  const confirmationBody = summary
    ? `✅ ${acknowledgerName} acknowledged your task request: "${summary}"${acknowledgementText ? ` Reply: "${acknowledgementText}"` : ""}`
    : `✅ ${acknowledgerName} acknowledged your task request${acknowledgementText ? `: "${acknowledgementText}"` : "."}`;

  const message = await insertMessageWithReceipts(acknowledgementConversationId, acknowledgementSenderId, "text", {
    body: confirmationBody,
    system: {
      kind: TASK_ACK_SYSTEM_KIND,
      taskMessageId: taskMessage.id,
      acknowledgedBy: acknowledgerId,
      acknowledgedTo: acknowledgementTargetId,
    },
  });

  return {
    messageId: message.id,
    taskMessageId: taskMessage.id,
    conversationId: acknowledgementConversationId,
    acknowledgedTo: acknowledgementTargetId,
  };
}

async function ensureConversationParticipants(conversationId, participants) {
  const rows = participants
    .filter((participant) => participant?.user_id)
    .map((participant) => ({
      conversation_id: conversationId,
      user_id: participant.user_id,
      role: participant.role || "member",
    }));
  if (!rows.length) return;
  const { error } = await supabase
    .from("conversation_participants")
    .upsert(rows, { onConflict: "conversation_id,user_id", ignoreDuplicates: false });
  if (error) throw error;
}

async function ensureProfile(user) {
  const metadataPhone = typeof user.user_metadata?.phone === "string" ? user.user_metadata.phone : "";
  const phone = user.phone ? normalizePhone(user.phone) : metadataPhone ? normalizePhone(metadataPhone) : null;
  const phoneHash = phone ? sha256(phone) : null;
  const displayNameFromAuth =
    typeof user.user_metadata?.display_name === "string" && user.user_metadata.display_name.trim()
      ? user.user_metadata.display_name.trim()
      : "Orbita user";
  const now = new Date().toISOString();

  const { data: existing, error: selectError } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("id", user.id)
    .maybeSingle();
  if (selectError) throw selectError;

  if (phone) {
    const { data: phoneOwner, error: phoneOwnerError } = await supabase
      .from("profiles")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();
    if (phoneOwnerError) throw phoneOwnerError;
    if (phoneOwner && phoneOwner.id !== user.id) {
      throw new Error("This phone number is already linked to another Orbita login.");
    }
  }

  if (existing) {
    const profileUpdate = { phone, phone_hash: phoneHash, is_online: true, last_seen_at: now };
    if (isDefaultDisplayName(existing.display_name) && !isDefaultDisplayName(displayNameFromAuth)) {
      profileUpdate.display_name = displayNameFromAuth;
    }
    const { data, error } = await supabase
      .from("profiles")
      .update(profileUpdate)
      .eq("id", user.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("profiles")
    .insert({
      id: user.id,
      display_name: displayNameFromAuth,
      phone,
      phone_hash: phoneHash,
      is_online: true,
      last_seen_at: now,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getProfile(userId) {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (error) throw error;
  return data;
}

async function getConversation(userId, conversationId) {
  const { data: membership, error: membershipError } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error("You are not a member of this conversation.");

  const { data, error } = await supabase.from("conversations").select("*").eq("id", conversationId).single();
  if (error) throw error;
  return data;
}

async function isAdmin(userId, conversationId) {
  const { data, error } = await supabase
    .from("conversation_participants")
    .select("role")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.role === "owner" || data?.role === "admin";
}

async function loadContacts(userId) {
  const { data, error } = await supabase
    .from("contacts")
    .select("contact_user_id, nickname, profiles!contacts_contact_user_id_fkey(*)")
    .eq("owner_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const mappedContacts = (data ?? []).map((row) => mapProfile({ ...(row.profiles ?? {}), nickname: row.nickname }, userId));
  const byId = new Map(mappedContacts.map((profile) => [profile.id, profile]));

  // Ensure Task Manager agent is visible as a default contact for linked users.
  const { data: links, error: linksError } = await supabase
    .from("taskmanager_agent_links")
    .select("agent_profile_id")
    .eq("orbita_user_id", userId)
    .eq("enabled", true);
  if (linksError) throw linksError;

  const agentIds = [...new Set((links ?? []).map((row) => row.agent_profile_id).filter(Boolean))]
    .filter((id) => !byId.has(id));

  if (agentIds.length) {
    const { data: agentProfiles, error: agentProfilesError } = await supabase
      .from("profiles")
      .select("*")
      .in("id", agentIds);
    if (agentProfilesError) throw agentProfilesError;

    for (const row of agentProfiles ?? []) {
      const mapped = mapProfile(row, userId);
      byId.set(mapped.id, mapped);
    }
  }

  return [...byId.values()];
}

async function loadMessages(userId, conversationId, options = {}) {
  await getConversation(userId, conversationId);
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 100);
  let query = supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (typeof options.beforeCreatedAt === "string" && options.beforeCreatedAt) {
    query = query.lt("created_at", options.beforeCreatedAt);
  }
  const { data, error } = await query.limit(limit + 1);
  if (error) throw error;
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();
  const attachmentsByMessageId = await loadAttachmentRowsForMessageIds(messages.map((message) => message.id));
  return {
    hasMore,
    messages: messages.map((message) => mapMessage(message, attachmentsByMessageId.get(message.id) ?? [])),
  };
}

async function unreadCountForConversation(userId, conversationId) {
  const { data: messages, error: messageError } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .neq("sender_id", userId)
    .is("deleted_at", null);
  if (messageError) throw messageError;
  const messageIds = (messages ?? []).map((message) => message.id);
  if (!messageIds.length) return 0;

  const { count, error } = await supabase
    .from("message_receipts")
    .select("message_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("message_id", messageIds)
    .neq("status", "read");
  if (error) throw error;
  return count ?? 0;
}

async function markConversationRead(userId, conversationId) {
  await getConversation(userId, conversationId);
  const { data: messages, error: messageError } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .neq("sender_id", userId)
    .is("deleted_at", null);
  if (messageError) throw messageError;
  const messageIds = (messages ?? []).map((message) => message.id);
  if (!messageIds.length) return;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("message_receipts")
    .update({ status: "read", delivered_at: now, read_at: now })
    .eq("user_id", userId)
    .in("message_id", messageIds)
    .neq("status", "read");
  if (error) throw error;
}

async function loadConversations(userId) {
  const { data: memberships, error: membershipError } = await supabase
    .from("conversation_participants")
    .select("conversation_id")
    .eq("user_id", userId);
  if (membershipError) throw membershipError;
  const ids = [...new Set((memberships ?? []).map((row) => row.conversation_id))];
  if (!ids.length) return [];

  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("*")
    .in("id", ids)
    .order("updated_at", { ascending: false });
  if (error) throw error;

  const { data: linkedRows, error: linkedRowsError } = await supabase
    .from("taskmanager_agent_links")
    .select("*")
    .in("conversation_id", ids)
    .eq("enabled", true);
  if (linkedRowsError) throw linkedRowsError;
  const taskmanagerAgentByConversationId = new Map((linkedRows ?? []).map((row) => [row.conversation_id, row]));
  const { data: taskThreadRows, error: taskThreadRowsError } = await supabase
    .from("taskmanager_task_threads")
    .select("*")
    .in("conversation_id", ids);
  if (taskThreadRowsError) throw taskThreadRowsError;
  const taskThreadByConversationId = new Map((taskThreadRows ?? []).map((row) => [row.conversation_id, row]));
  const taskmanagerConversationIds = new Set([
    ...(linkedRows ?? []).map((row) => row.conversation_id),
    ...taskThreadByConversationId.keys(),
  ]);
  const contactNicknames = await loadContactNicknames(userId);
  const loaded = await Promise.all(
    (conversations ?? []).map(async (conversation) => {
      const isTaskmanagerConversation = taskmanagerConversationIds.has(conversation.id);
      const displayKind = isTaskmanagerConversation ? "taskmanager" : conversation.kind;
      const { data: participants, error: participantError } = await supabase
        .from("conversation_participants")
        .select("role, profiles(*)")
        .eq("conversation_id", conversation.id)
        .order("joined_at", { ascending: true });
      if (participantError) throw participantError;

      const { data: lastMessages, error: lastError } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversation.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (lastError) throw lastError;
      const lastMessageRow = lastMessages?.[0] ?? null;
      const attachmentsByMessageId = lastMessageRow
        ? await loadAttachmentRowsForMessageIds([lastMessageRow.id])
        : new Map();

      const mappedParticipants = (participants ?? []).map((row) => {
        const profileRow = row.profiles ?? {};
        return {
          ...mapProfile({ ...profileRow, nickname: contactNicknames.get(profileRow.id) }, userId),
          role: row.role,
        };
      });
      const directPeer = mappedParticipants.find((profile) => profile.id !== userId);
      const lastMessage = lastMessageRow
        ? mapMessage(lastMessageRow, attachmentsByMessageId.get(lastMessageRow.id) ?? [])
        : null;

      return {
        id: conversation.id,
        kind: displayKind,
        title:
          displayKind === "direct"
            ? directPeer?.displayName ?? "Direct chat"
            : conversation.title ?? (displayKind === "group" ? "Group" : directPeer?.displayName ?? "Task Manager"),
        avatarUrl: conversation.avatar_url,
        inviteCode: conversation.invite_code,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
        participants: mappedParticipants,
        lastMessage,
        unreadCount: await unreadCountForConversation(userId, conversation.id),
        taskManagerAgent: taskmanagerAgentByConversationId.has(conversation.id)
          ? {
              taskmanagerOrgId: taskmanagerAgentByConversationId.get(conversation.id).taskmanager_org_id,
              taskmanagerOrgName: taskmanagerAgentByConversationId.get(conversation.id).taskmanager_org_name ?? null,
              taskmanagerUserId: taskmanagerAgentByConversationId.get(conversation.id).taskmanager_user_id,
              agentProfileId: taskmanagerAgentByConversationId.get(conversation.id).agent_profile_id,
            }
          : null,
        taskThread: taskThreadByConversationId.has(conversation.id)
          ? {
              taskmanagerOrgId: taskThreadByConversationId.get(conversation.id).taskmanager_org_id,
              taskmanagerOrgName: taskThreadByConversationId.get(conversation.id).taskmanager_org_name ?? null,
              taskmanagerTaskId: taskThreadByConversationId.get(conversation.id).taskmanager_task_id,
              taskNumber: taskThreadByConversationId.get(conversation.id).task_number,
              agentProfileId: taskThreadByConversationId.get(conversation.id).agent_profile_id,
              sourceAgentConversationId: taskThreadByConversationId.get(conversation.id).source_agent_conversation_id ?? null,
              parentTaskId: taskThreadByConversationId.get(conversation.id).parent_task_id,
              rootTaskId: taskThreadByConversationId.get(conversation.id).root_task_id,
              status: taskThreadByConversationId.get(conversation.id).status,
              title: taskThreadByConversationId.get(conversation.id).title,
              dueDate: taskThreadByConversationId.get(conversation.id).due_date ?? null,
              departmentIds: taskThreadByConversationId.get(conversation.id).department_ids ?? [],
              departmentNames: taskThreadByConversationId.get(conversation.id).department_names ?? [],
            }
          : null,
      };
    }),
  );

  const bestDirectByPeer = new Map();
  return loaded.filter((conversation) => {
    if (conversation.kind !== "direct") return true;
    const peer = conversation.participants.find((participant) => participant.id !== userId);
    if (!peer) return true;
    const existing = bestDirectByPeer.get(peer.id);
    if (!existing) {
      bestDirectByPeer.set(peer.id, conversation);
      return true;
    }
    const conversationScore = (conversation.lastMessage ? 2 : 0) + (conversation.unreadCount > 0 ? 1 : 0);
    const existingScore = (existing.lastMessage ? 2 : 0) + (existing.unreadCount > 0 ? 1 : 0);
    if (
      conversationScore > existingScore ||
      (conversationScore === existingScore && Date.parse(conversation.updatedAt) > Date.parse(existing.updatedAt))
    ) {
      bestDirectByPeer.set(peer.id, conversation);
      return true;
    }
    return false;
  }).filter((conversation) => {
    if (conversation.kind !== "direct") return true;
    const peer = conversation.participants.find((participant) => participant.id !== userId);
    return !peer || bestDirectByPeer.get(peer.id)?.id === conversation.id;
  });
}

async function loadStatuses(userId) {
  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select("contact_user_id")
    .eq("owner_id", userId);
  if (contactsError) throw contactsError;

  const authorIds = [userId, ...(contacts ?? []).map((contact) => contact.contact_user_id)];
  const { data, error } = await supabase
    .from("status_posts")
    .select("*, profiles!status_posts_author_id_fkey(*), status_views(viewer_id)")
    .in("author_id", authorIds)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    author: mapProfile(row.profiles, userId),
    kind: row.kind,
    text: typeof row.encrypted_payload?.text === "string" ? row.encrypted_payload.text : "",
    mediaUrl: typeof row.encrypted_payload?.mediaUrl === "string" ? row.encrypted_payload.mediaUrl : null,
    visibility: row.visibility,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    viewCount: Array.isArray(row.status_views) ? row.status_views.length : 0,
  }));
}

async function createDirectConversation(userId, otherUserId) {
  if (userId === otherUserId) throw new Error("Choose another user.");

  const { data: shared, error: sharedError } = await supabase
    .from("conversation_participants")
    .select("conversation_id, conversations!inner(kind)")
    .eq("user_id", userId);
  if (sharedError) throw sharedError;

  let hasExistingDirect = false;
  for (const row of shared ?? []) {
    if (row.conversations?.kind !== "direct") continue;
    const { data: peer } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("conversation_id", row.conversation_id)
      .eq("user_id", otherUserId)
      .maybeSingle();
    if (peer) {
      hasExistingDirect = true;
      break;
    }
  }

  if (hasExistingDirect) {
    const existing = (await loadConversations(userId)).find(
      (conversation) =>
        conversation.kind === "direct" &&
        conversation.participants.some((participant) => participant.id === otherUserId),
      );
    if (!existing) throw new Error("Unable to load existing conversation.");
    return existing;
  }

  const { data: conversation, error } = await supabase
    .from("conversations")
    .insert({ kind: "direct", created_by: userId })
    .select()
    .single();
  if (error) throw error;

  const { error: participantError } = await supabase.from("conversation_participants").insert([
    { conversation_id: conversation.id, user_id: userId, role: "owner" },
    { conversation_id: conversation.id, user_id: otherUserId, role: "member" },
  ]);
  if (participantError) throw participantError;

  await createRealtimeEvents([otherUserId], "direct_conversation_created", conversation.id, { createdBy: userId });

  const created = (await loadConversations(userId)).find((item) => item.id === conversation.id);
  if (!created) throw new Error("Unable to load created conversation.");
  return created;
}

async function createTaskmanagerConversation(agentProfileId, orbitaUserId, title) {
  const cleanTitle = typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : "Task Manager";
  const { data: conversation, error } = await supabase
    .from("conversations")
    .insert({ kind: "taskmanager", created_by: agentProfileId, title: cleanTitle })
    .select()
    .single();
  if (error) throw error;

  const { error: participantError } = await supabase.from("conversation_participants").insert([
    { conversation_id: conversation.id, user_id: agentProfileId, role: "owner" },
    { conversation_id: conversation.id, user_id: orbitaUserId, role: "member" },
  ]);
  if (participantError) throw participantError;

  await createRealtimeEvents([orbitaUserId], "direct_conversation_created", conversation.id, {
    createdBy: agentProfileId,
  });

  const created = (await loadConversations(orbitaUserId)).find((item) => item.id === conversation.id);
  if (!created) throw new Error("Unable to load created Task Manager conversation.");
  return created;
}

async function createTaskmanagerTaskConversation(agentProfileId, title) {
  const cleanTitle = typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : "Task thread";
  const { data: conversation, error } = await supabase
    .from("conversations")
    .insert({ kind: "taskmanager", created_by: agentProfileId, title: cleanTitle })
    .select()
    .single();
  if (error) throw error;
  return conversation;
}

async function loadTaskmanagerLinksByUserIds(taskmanagerOrgId, taskmanagerUserIds) {
  const uniqueIds = [...new Set(taskmanagerUserIds.filter(Boolean))];
  if (!uniqueIds.length) return new Map();
  const { data, error } = await supabase
    .from("taskmanager_agent_links")
    .select("*")
    .eq("taskmanager_org_id", taskmanagerOrgId)
    .eq("enabled", true)
    .in("taskmanager_user_id", uniqueIds);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.taskmanager_user_id, row]));
}

async function materializePendingTaskThreadMemberships(taskmanagerOrgId, taskmanagerUserId, orbitaUserId) {
  const { data: pendingRows, error: pendingError } = await supabase
    .from("taskmanager_task_thread_members")
    .select("taskmanager_task_id, role")
    .eq("taskmanager_org_id", taskmanagerOrgId)
    .eq("taskmanager_user_id", taskmanagerUserId)
    .eq("status", "pending");
  if (pendingError) throw pendingError;
  if (!(pendingRows ?? []).length) return { updated: 0 };

  const taskIds = [...new Set(pendingRows.map((row) => row.taskmanager_task_id).filter(Boolean))];
  const { data: threads, error: threadError } = await supabase
    .from("taskmanager_task_threads")
    .select("taskmanager_task_id, conversation_id")
    .eq("taskmanager_org_id", taskmanagerOrgId)
    .in("taskmanager_task_id", taskIds);
  if (threadError) throw threadError;
  const conversationByTaskId = new Map((threads ?? []).map((row) => [row.taskmanager_task_id, row.conversation_id]));
  const now = new Date().toISOString();

  for (const row of pendingRows) {
    const conversationId = conversationByTaskId.get(row.taskmanager_task_id);
    if (!conversationId) continue;
    await ensureConversationParticipants(conversationId, [{ user_id: orbitaUserId, role: row.role || "member" }]);
    await createRealtimeEvents([orbitaUserId], "group_member_added", conversationId, {
      kind: "task_thread_member_added",
      taskmanagerOrgId,
      taskmanagerTaskId: row.taskmanager_task_id,
    });
  }

  const { error: updateError } = await supabase
    .from("taskmanager_task_thread_members")
    .update({ orbita_user_id: orbitaUserId, status: "linked", updated_at: now })
    .eq("taskmanager_org_id", taskmanagerOrgId)
    .eq("taskmanager_user_id", taskmanagerUserId)
    .eq("status", "pending");
  if (updateError) throw updateError;
  return { updated: pendingRows.length };
}

function formatTaskStatusLabel(status) {
  const normalized = String(status || "open").replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Open";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function progressLabelForTaskStatus(status, completedAt) {
  const normalized = String(status || "").toLowerCase();
  if (completedAt || ["done", "completed", "approved"].includes(normalized)) return "Completed";
  if (["in_progress", "in progress", "active"].includes(normalized)) return "In progress";
  if (["discarded", "cancelled", "canceled"].includes(normalized)) return "Closed";
  return "Not started";
}

function formatTaskDueDate(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function buildTaskThreadContextPayload(args) {
  const lines = [
    `${args.taskNumber} · ${args.title}`,
    `Status: ${formatTaskStatusLabel(args.status)}`,
    `Progress: ${progressLabelForTaskStatus(args.status, args.completedAt)}`,
  ];
  const dueDate = formatTaskDueDate(args.dueDate);
  if (dueDate) lines.push(`Due: ${dueDate}`);
  if (args.description) lines.push(`Details: ${args.description}`);
  if (args.completionNote) lines.push(`Completion note: ${args.completionNote}`);
  lines.push("This thread is linked to the task, so the agent already receives the task context.");
  return {
    body: lines.join("\n"),
    system: {
      kind: "task_thread_context",
      taskmanagerOrgId: args.taskmanagerOrgId,
      taskmanagerTaskId: args.taskmanagerTaskId,
      taskNumber: args.taskNumber,
      status: args.status,
    },
  };
}

async function ensureTaskThreadContextMessage(thread, payload) {
  const clientMessageId = `task-thread-context:${thread.taskmanager_org_id}:${thread.taskmanager_task_id}`;
  const { data: existing, error: existingError } = await supabase
    .from("messages")
    .select("id")
    .eq("sender_id", thread.agent_profile_id)
    .eq("client_message_id", clientMessageId)
    .maybeSingle();
  if (existingError) throw existingError;

  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("messages")
      .update({
        kind: "text",
        encrypted_payload: payload,
        deleted_at: null,
      })
      .eq("id", existing.id);
    if (updateError) throw updateError;
    return existing.id;
  }

  const message = await insertMessageWithReceipts(thread.conversation_id, thread.agent_profile_id, "text", payload, {
    clientMessageId,
    pushSource: "task_thread_context",
  });
  return message.id;
}

function sourceTaskStatusNotificationText(thread, status) {
  const normalized = String(status || "").trim().toLowerCase();
  const statusLabel = canonicalSourceTaskStatus(normalized) || formatTaskStatusLabel(status).toLowerCase();
  const taskRef = `${thread.task_number || "Task"}${thread.title ? ` - ${thread.title}` : ""}`;
  if (statusLabel === "closed") {
    return `${taskRef} was closed.`;
  }
  if (statusLabel === "completed") {
    return `${taskRef} was marked as completed.`;
  }
  return `${taskRef} status changed to ${statusLabel}.`;
}

function sourceTaskCreatedNotificationText(thread) {
  const taskRef = `${thread.task_number || "Task"}${thread.title ? ` - ${thread.title}` : ""}`;
  return `${thread.parent_task_id ? "Subtask" : "Task"} ${taskRef} was created.`;
}

function canonicalSourceTaskStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "discarded" || normalized === "closed") return "closed";
  if (normalized === "done" || normalized === "completed") return "completed";
  return "";
}

async function notifySourceAgentConversationForTaskStatus(userId, conversationId, status) {
  await getConversation(userId, conversationId);
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (!["done", "completed", "closed", "discarded"].includes(normalizedStatus)) {
    return { notified: false, reason: "Status does not need source conversation notification." };
  }

  const { data: thread, error: threadError } = await supabase
    .from("taskmanager_task_threads")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (threadError) throw threadError;
  if (!thread) throw new Error("Task thread not found.");
  if (!thread.agent_profile_id) {
    return { notified: false, reason: "Task thread has no agent profile." };
  }

  return notifySourceAgentConversationForThreadStatus(thread, normalizedStatus);
}

async function sourceAgentConversationIdsForThread(thread) {
  const directConversationId =
    typeof thread?.source_agent_conversation_id === "string" && thread.source_agent_conversation_id
      ? thread.source_agent_conversation_id
      : "";
  const conversationIds = directConversationId ? [directConversationId] : [];
  if (!thread?.taskmanager_org_id || !thread?.taskmanager_task_id || !thread?.agent_profile_id) {
    return conversationIds;
  }

  const { data: members, error: memberError } = await supabase
    .from("taskmanager_task_thread_members")
    .select("taskmanager_user_id, role, status")
    .eq("taskmanager_org_id", thread.taskmanager_org_id)
    .eq("taskmanager_task_id", thread.taskmanager_task_id)
    .eq("status", "linked")
    .order("role", { ascending: true });
  if (memberError) throw memberError;

  const taskmanagerUserIds = [...new Set((members ?? []).map((member) => member.taskmanager_user_id).filter(Boolean))];
  if (!taskmanagerUserIds.length) return [...new Set(conversationIds)];

  const { data: links, error: linkError } = await supabase
    .from("taskmanager_agent_links")
    .select("conversation_id, taskmanager_user_id")
    .eq("taskmanager_org_id", thread.taskmanager_org_id)
    .eq("agent_profile_id", thread.agent_profile_id)
    .eq("enabled", true)
    .in("taskmanager_user_id", taskmanagerUserIds);
  if (linkError) throw linkError;

  for (const userId of taskmanagerUserIds) {
    const link = (links ?? []).find((row) => row.taskmanager_user_id === userId && row.conversation_id);
    if (link?.conversation_id) conversationIds.push(link.conversation_id);
  }

  return [...new Set(conversationIds)];
}

async function notifySourceAgentConversationForThreadStatus(thread, status) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const canonicalStatus = canonicalSourceTaskStatus(normalizedStatus);
  if (!canonicalStatus) {
    return { notified: false, reason: "Status does not need source conversation notification." };
  }
  return notifySourceAgentConversationsForThreadEvent(thread, {
    event: "status",
    status: canonicalStatus,
    body: sourceTaskStatusNotificationText({ ...thread, status: canonicalStatus }, canonicalStatus),
    clientMessageIdPrefix: "task-thread-source-status",
    pushSource: "task_thread_source_status_changed",
    systemKind: "task_thread_source_status_changed",
  });
}

async function notifySourceAgentConversationForThreadCreated(thread) {
  return notifySourceAgentConversationsForThreadEvent(thread, {
    event: "created",
    status: thread.status || "open",
    body: sourceTaskCreatedNotificationText(thread),
    clientMessageIdPrefix: "task-thread-source-created",
    pushSource: "task_thread_source_created",
    systemKind: "task_thread_source_created",
  });
}

async function notifySourceAgentConversationsForThreadEvent(thread, notification) {
  const sourceConversationIds = await sourceAgentConversationIdsForThread(thread);
  if (!sourceConversationIds.length) {
    return { notified: false, reason: "Task thread is not linked to a source agent conversation." };
  }
  if (!thread?.agent_profile_id) {
    return { notified: false, reason: "Task thread has no agent profile." };
  }

  const messages = [];
  for (const sourceConversationId of sourceConversationIds) {
    await ensureConversationParticipants(sourceConversationId, [
      { user_id: thread.agent_profile_id, role: "owner" },
    ]);

    const clientMessageId = [
      notification.clientMessageIdPrefix,
      thread.taskmanager_org_id,
      thread.taskmanager_task_id,
      notification.status,
      sourceConversationId,
    ].join(":");
    const { data: existing, error: existingError } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", sourceConversationId)
      .eq("sender_id", thread.agent_profile_id)
      .eq("client_message_id", clientMessageId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      messages.push(await mapMessageWithAttachments(existing));
      continue;
    }

    const message = await insertMessageWithReceipts(
      sourceConversationId,
      thread.agent_profile_id,
      "text",
      {
        body: notification.body,
        system: {
          kind: notification.systemKind,
          taskmanagerOrgId: thread.taskmanager_org_id,
          taskmanagerTaskId: thread.taskmanager_task_id,
          taskNumber: thread.task_number,
          title: thread.title,
          parentTaskId: thread.parent_task_id,
          rootTaskId: thread.root_task_id,
          status: notification.status,
          taskThreadConversationId: thread.conversation_id,
          event: notification.event,
        },
      },
      {
        awaitPush: true,
        clientMessageId,
        pushSource: notification.pushSource,
      },
    );
    messages.push(await mapMessageWithAttachments(message));
  }

  return { notified: messages.length, message: messages[0] ?? null, messages };
}

async function ensureTaskmanagerTaskThread(payload) {
  const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
  const taskmanagerTaskId = requiredString(payload, "taskmanagerTaskId");
  const taskNumber = requiredString(payload, "taskNumber").slice(0, 80);
  const title = requiredString(payload, "title").slice(0, 500);
  const parentTaskId = optionalString(payload, "parentTaskId") || null;
  const rootTaskId = optionalString(payload, "rootTaskId") || taskmanagerTaskId;
  const creatorUserId = requiredString(payload, "creatorUserId");
  const assigneeUserId = requiredString(payload, "assigneeUserId");
  const memberUserIds = [
    ...new Set([creatorUserId, assigneeUserId, ...stringArray(payload, "memberUserIds")].filter(Boolean)),
  ];
  const agentDisplayName = normalizeTaskmanagerAgentDisplayName(optionalString(payload, "agentDisplayName"));
  const description = optionalString(payload, "description").slice(0, 1000);
  const dueDate = optionalString(payload, "dueDate");
  const completionNote = optionalString(payload, "completionNote").slice(0, 1000);
  const completedAt = optionalString(payload, "completedAt");
  const departmentIds = [...new Set(stringArray(payload, "departmentIds").map((item) => item.trim()).filter(Boolean))].slice(0, 12);
  const departmentNames = [...new Set(stringArray(payload, "departmentNames").map((item) => item.trim()).filter(Boolean))].slice(0, 12);
  const notifySourceCreated = payload.notifySourceCreated === true;
  const sourceAgentProfileId = optionalString(payload, "sourceAgentProfileId") || null;
  const sourceAgentConversationId = optionalString(payload, "sourceAgentConversationId") || null;
  const sourceAgentDisplayNameInput = optionalString(payload, "sourceAgentDisplayName");
  const sourceAgentDisplayName = sourceAgentDisplayNameInput
    ? normalizeTaskmanagerAgentDisplayName(sourceAgentDisplayNameInput)
    : "";
  const agentProfileId = sourceAgentProfileId || await ensureTaskmanagerAgentProfile(taskmanagerOrgId, agentDisplayName);
  if (sourceAgentProfileId && sourceAgentDisplayName) {
    await supabase
      .from("profiles")
      .update({
        display_name: sourceAgentDisplayName,
        about: "Task Manager agent",
        is_online: true,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", sourceAgentProfileId);
  }

  const { data: existingThread, error: existingError } = await supabase
    .from("taskmanager_task_threads")
    .select("*")
    .eq("taskmanager_org_id", taskmanagerOrgId)
    .eq("taskmanager_task_id", taskmanagerTaskId)
    .maybeSingle();
  if (existingError) throw existingError;

  const conversationTitle = taskThreadConversationTitle(taskNumber, title);
  const conversation = existingThread?.conversation_id
    ? { id: existingThread.conversation_id }
    : await createTaskmanagerTaskConversation(agentProfileId, conversationTitle);

  const now = new Date().toISOString();
  const threadPayload = {
    taskmanager_org_id: taskmanagerOrgId,
    taskmanager_task_id: taskmanagerTaskId,
    task_number: taskNumber,
    title,
    parent_task_id: parentTaskId,
    root_task_id: rootTaskId,
    status: optionalString(payload, "status") || "open",
    agent_profile_id: agentProfileId,
    conversation_id: conversation.id,
    source_agent_conversation_id: sourceAgentConversationId || existingThread?.source_agent_conversation_id || null,
    due_date: dueDate || null,
    department_ids: departmentIds,
    department_names: departmentNames,
    updated_at: now,
  };
  const upsertThread = (candidatePayload) => supabase
    .from("taskmanager_task_threads")
    .upsert(candidatePayload, { onConflict: "taskmanager_org_id,taskmanager_task_id" })
    .select()
    .single();
  let threadResult = await upsertThread(threadPayload);
  if (threadResult.error) {
    const missingColumnMessage = errorMessage(threadResult.error).toLowerCase();
    const fallbackThreadPayload = { ...threadPayload };
    let shouldRetry = false;
    if (missingColumnMessage.includes("source_agent_conversation_id")) {
      delete fallbackThreadPayload.source_agent_conversation_id;
      shouldRetry = true;
    }
    if (missingColumnMessage.includes("due_date")) {
      delete fallbackThreadPayload.due_date;
      shouldRetry = true;
    }
    if (missingColumnMessage.includes("department_ids")) {
      delete fallbackThreadPayload.department_ids;
      shouldRetry = true;
    }
    if (missingColumnMessage.includes("department_names")) {
      delete fallbackThreadPayload.department_names;
      shouldRetry = true;
    }
    if (shouldRetry) threadResult = await upsertThread(fallbackThreadPayload);
  }
  if (
    threadResult.error &&
    (
      errorMessage(threadResult.error).toLowerCase().includes("source_agent_conversation_id") ||
      errorMessage(threadResult.error).toLowerCase().includes("due_date") ||
      errorMessage(threadResult.error).toLowerCase().includes("department_ids") ||
      errorMessage(threadResult.error).toLowerCase().includes("department_names")
    )
  ) {
    const { due_date, source_agent_conversation_id, department_ids, department_names, ...fallbackThreadPayload } = threadPayload;
    threadResult = await upsertThread(fallbackThreadPayload);
  }
  const { data: thread, error: threadError } = threadResult;
  if (threadError) throw threadError;

  const { error: conversationUpdateError } = await supabase
    .from("conversations")
    .update({ title: conversationTitle, updated_at: now })
    .eq("id", thread.conversation_id);
  if (conversationUpdateError) throw conversationUpdateError;

  const linksByTaskmanagerUserId = await loadTaskmanagerLinksByUserIds(taskmanagerOrgId, memberUserIds);
  const linkedRows = [];
  const pendingRows = [];
  for (const taskmanagerUserId of memberUserIds) {
    const link = linksByTaskmanagerUserId.get(taskmanagerUserId);
    if (link?.orbita_user_id) {
      linkedRows.push({
        taskmanager_org_id: taskmanagerOrgId,
        taskmanager_task_id: taskmanagerTaskId,
        taskmanager_user_id: taskmanagerUserId,
        orbita_user_id: link.orbita_user_id,
        role: taskmanagerUserId === creatorUserId ? "admin" : "member",
        status: "linked",
        updated_at: now,
      });
    } else {
      pendingRows.push({
        taskmanager_org_id: taskmanagerOrgId,
        taskmanager_task_id: taskmanagerTaskId,
        taskmanager_user_id: taskmanagerUserId,
        orbita_user_id: null,
        role: taskmanagerUserId === creatorUserId ? "admin" : "member",
        status: "pending",
        updated_at: now,
      });
    }
  }

  const memberRows = [...linkedRows, ...pendingRows];
  if (memberRows.length) {
    const { error: memberError } = await supabase
      .from("taskmanager_task_thread_members")
      .upsert(memberRows, { onConflict: "taskmanager_org_id,taskmanager_task_id,taskmanager_user_id" });
    if (memberError) throw memberError;
  }

  await ensureConversationParticipants(thread.conversation_id, [
    { user_id: agentProfileId, role: "owner" },
    ...linkedRows.map((row) => ({ user_id: row.orbita_user_id, role: row.role })),
  ]);

  await ensureTaskThreadContextMessage(
    thread,
    buildTaskThreadContextPayload({
      taskmanagerOrgId,
      taskmanagerTaskId,
      taskNumber,
      title,
      status: thread.status,
      description,
      dueDate,
      completionNote,
      completedAt,
    }),
  );

  if (notifySourceCreated) {
    await notifySourceAgentConversationForThreadCreated(thread).catch((error) => {
      console.error("[taskmanager-thread] source creation notification failed", {
        taskmanagerOrgId,
        taskmanagerTaskId,
        status: thread.status,
        error: errorMessage(error),
      });
    });
  }

  const targetUserIds = linkedRows.map((row) => row.orbita_user_id).filter(Boolean);
  await createRealtimeEvents(targetUserIds, "group_member_added", thread.conversation_id, {
    kind: "task_thread_updated",
    taskmanagerOrgId,
    taskmanagerTaskId,
    taskNumber,
  });

  return {
    conversationId: thread.conversation_id,
    status: pendingRows.length ? "pending" : "ready",
    linkedMembers: linkedRows.length,
    pendingMembers: pendingRows.length,
  };
}

function normalizeTaskmanagerAgentDisplayName(displayName) {
  return typeof displayName === "string" && displayName.trim()
    ? displayName.trim().slice(0, 80)
    : "Task Manager Agent";
}

async function updateTaskmanagerAgentPresentation(taskmanagerOrgId, displayName) {
  const cleanTitle = normalizeTaskmanagerAgentDisplayName(displayName);
  const { data: links, error: linksError } = await supabase
    .from("taskmanager_agent_links")
    .select("agent_profile_id, conversation_id, orbita_user_id")
    .eq("taskmanager_org_id", taskmanagerOrgId);
  if (linksError) throw linksError;

  const agentProfileIds = [...new Set((links ?? []).map((link) => link.agent_profile_id).filter(Boolean))];
  const conversationIds = [...new Set((links ?? []).map((link) => link.conversation_id).filter(Boolean))];
  const now = new Date().toISOString();

  if (agentProfileIds.length) {
    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        display_name: cleanTitle,
        about: "Task Manager agent",
        is_online: true,
        last_seen_at: now,
        updated_at: now,
      })
      .in("id", agentProfileIds);
    if (profileError) throw profileError;
  }

  if (conversationIds.length) {
    const { error: conversationError } = await supabase
      .from("conversations")
      .update({ title: cleanTitle, updated_at: now })
      .in("id", conversationIds);
    if (conversationError) throw conversationError;
  }

  const eventRows = (links ?? [])
    .filter((link) => link.orbita_user_id && link.conversation_id)
    .map((link) => ({
      target_user_id: link.orbita_user_id,
      conversation_id: link.conversation_id,
      kind: "taskmanager_agent_updated",
      payload: { displayName: cleanTitle },
    }));
  if (eventRows.length) {
    const { error: eventError } = await supabase.from("realtime_events").insert(eventRows);
    if (eventError) throw eventError;
  }

  return {
    agentProfileIds,
    conversationIds,
    displayName: cleanTitle,
  };
}

async function loadConversationParticipants(conversationId) {
  const { data, error } = await supabase
    .from("conversation_participants")
    .select("role, user_id, profiles(*)")
    .eq("conversation_id", conversationId)
    .order("joined_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

function conversationTitleFromRows(conversation, participantRows, viewerId) {
  const participants = participantRows.map((row) => ({
    ...mapProfile(row.profiles, viewerId),
    role: row.role,
  }));
  if (conversation.kind === "group") return conversation.title ?? "Group";
  return participants.find((participant) => participant.id !== viewerId)?.displayName ?? "Direct chat";
}

async function buildForwardedFrom(sourceMessage, forwardingUserId) {
  const payload = messagePayload(sourceMessage);
  const existing = parseForwardedFrom(payload);
  if (existing) return existing;

  const [sourceConversation, participantRows, senderRow] = await Promise.all([
    supabase.from("conversations").select("*").eq("id", sourceMessage.conversation_id).single(),
    loadConversationParticipants(sourceMessage.conversation_id),
    supabase.from("profiles").select("*").eq("id", sourceMessage.sender_id).single(),
  ]);

  if (sourceConversation.error) throw sourceConversation.error;
  if (senderRow.error) throw senderRow.error;

  return {
    messageId: sourceMessage.id,
    senderName: profileDisplayName(senderRow.data, forwardingUserId),
    conversationTitle: conversationTitleFromRows(sourceConversation.data, participantRows, forwardingUserId),
  };
}

async function ensureTaskmanagerAgentProfile(taskmanagerOrgId, displayName) {
  const { data: existingLink, error: linkError } = await supabase
    .from("taskmanager_agent_links")
    .select("agent_profile_id")
    .eq("taskmanager_org_id", taskmanagerOrgId)
    .limit(1)
    .maybeSingle();
  if (linkError) throw linkError;
  if (existingLink?.agent_profile_id) {
    await updateTaskmanagerAgentPresentation(taskmanagerOrgId, displayName);
    return existingLink.agent_profile_id;
  }

  const safeOrg = taskmanagerOrgId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const email = `orbita-agent+${safeOrg}@taskmanager.local`;
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      display_name: displayName,
      taskmanager_org_id: taskmanagerOrgId,
      kind: "taskmanager_agent",
    },
  });
  let agentUser = created.user;
  if (createError || !agentUser) {
    const existingAgent = await findAuthUserByEmail(email);
    if (!existingAgent) throw createError ?? new Error("Unable to create Orbita agent user.");
    agentUser = existingAgent;
  }

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: agentUser.id,
    display_name: displayName,
    about: "Task Manager agent",
    is_online: true,
    last_seen_at: new Date().toISOString(),
  });
  if (profileError) throw profileError;

  return agentUser.id;
}

async function findAuthUserByEmail(email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const user = data.users.find((item) => item.email?.toLowerCase() === email.toLowerCase());
    if (user) return user;
    if (data.users.length < 100) return null;
  }
  return null;
}

async function loadTaskThreadForwardingContext(conversationId, senderId) {
  const { data: thread, error: threadError } = await supabase
    .from("taskmanager_task_threads")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (threadError) throw threadError;
  if (!thread) return null;
  if (thread.agent_profile_id === senderId) return { skip: true, reason: "Sender is the Task Manager agent." };

  const { data: member, error: memberError } = await supabase
    .from("taskmanager_task_thread_members")
    .select("*")
    .eq("taskmanager_org_id", thread.taskmanager_org_id)
    .eq("taskmanager_task_id", thread.taskmanager_task_id)
    .eq("orbita_user_id", senderId)
    .eq("status", "linked")
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member?.taskmanager_user_id) {
    return { skip: true, reason: "Sender is not a linked Task Manager member of this task thread." };
  }

  return {
    taskmanagerOrgId: thread.taskmanager_org_id,
    taskmanagerUserId: member.taskmanager_user_id,
    taskmanagerTaskId: thread.taskmanager_task_id,
    taskNumber: thread.task_number,
    taskTitle: thread.title,
    taskStatus: thread.status,
    agentProfileId: thread.agent_profile_id,
    conversationId: thread.conversation_id,
  };
}

async function loadDirectTaskmanagerLink(conversationId, senderId) {
  await getConversation(senderId, conversationId);
  const { data: link, error } = await supabase
    .from("taskmanager_agent_links")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("orbita_user_id", senderId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  if (!link) throw new Error("This chat is not linked to a Task Manager agent.");
  if (link.agent_profile_id === senderId) throw new Error("The Task Manager agent cannot create tasks.");
  return link;
}

function taskThreadConversationTitle(taskNumber, title) {
  const cleanNumber = typeof taskNumber === "string" ? taskNumber.trim() : "";
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (!cleanTitle || cleanTitle === cleanNumber) return cleanNumber || cleanTitle || "Task";
  return `${cleanNumber} ${cleanTitle}`.trim().slice(0, 120);
}

async function waitForTaskmanagerTaskThread(taskmanagerOrgId, taskmanagerTaskId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { data: thread, error } = await supabase
      .from("taskmanager_task_threads")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_task_id", taskmanagerTaskId)
      .maybeSingle();
    if (error) throw error;
    if (thread?.conversation_id) return thread;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Task thread was not created yet. Please try again.");
}

async function loadConversationKind(conversationId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("kind, title")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return {
    kind: typeof data?.kind === "string" ? data.kind : "",
    title: typeof data?.title === "string" ? data.title : "",
  };
}

async function forwardTaskmanagerInbound(
  conversationId,
  senderId,
  message,
  attachments = [],
  taskManagerTextOverride = "",
  clientPlatform = "",
  taskManagerMentioned = false,
) {
  const webhookUrl = process.env.TASK_MANAGER_ORBITA_WEBHOOK_URL;
  const secret = process.env.TASK_MANAGER_ORBITA_SECRET;
  if (!webhookUrl || !secret) {
    return { forwarded: false, reason: "Task Manager webhook is not configured." };
  }

  const taskThreadContext = await loadTaskThreadForwardingContext(conversationId, senderId);
  if (taskThreadContext?.skip) {
    return { forwarded: false, reason: taskThreadContext.reason };
  }
  if (taskThreadContext) {
    const outboundText = taskManagerTextOverride || message.body || "";
    const mentionTriggered = taskManagerMentioned || hasOrbitaMention(outboundText) || hasOrbitaMention(message.body);
    if (!mentionTriggered) {
      return { forwarded: false, reason: "Task thread message did not mention @orbita." };
    }
    const taskThreadText = hasOrbitaMention(outboundText)
      ? outboundText
      : hasOrbitaMention(message.body)
        ? message.body
        : outboundText;
    if (!stripOrbitaMention(taskThreadText) && !attachments.length) {
      if (!taskThreadContext.agentProfileId) {
        return { forwarded: false, reason: "Task thread has no agent profile." };
      }
      const greetingClientMessageId = `task-thread-orbita-greeting:${message.id}`;
      const { data: existingGreeting, error: existingGreetingError } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .eq("sender_id", taskThreadContext.agentProfileId)
        .eq("client_message_id", greetingClientMessageId)
        .maybeSingle();
      if (existingGreetingError) throw existingGreetingError;
      if (!existingGreeting) {
        await insertMessageWithReceipts(
          conversationId,
          taskThreadContext.agentProfileId,
          "text",
          {
            body: "Hi, what can I help you with on this task today?",
            system: {
              kind: "task_thread_orbita_greeting",
              taskmanagerOrgId: taskThreadContext.taskmanagerOrgId,
              taskmanagerTaskId: taskThreadContext.taskmanagerTaskId,
              taskNumber: taskThreadContext.taskNumber,
            },
          },
          {
            awaitPush: true,
            clientMessageId: greetingClientMessageId,
            pushSource: "task_thread_orbita_greeting",
          },
        );
      }
      return { forwarded: true, greeting: true };
    }
    const replyFields = replyToPayloadFields(message);
    console.info("[orbita-taskmanager-forward] task thread payload", {
      conversationId,
      messageId: message.id,
      taskmanagerTaskId: taskThreadContext.taskmanagerTaskId,
      mentionTriggered,
      taskManagerMentioned,
      outboundHasMention: hasOrbitaMention(outboundText),
      bodyHasMention: hasOrbitaMention(message.body),
      textPreview: taskThreadText.slice(0, 180),
      replyToMessageId: replyFields.replyToMessageId ?? null,
      replyToBody: typeof replyFields.replyTo?.body === "string" ? replyFields.replyTo.body.slice(0, 180) : null,
    });
    const raw = JSON.stringify({
      taskmanagerOrgId: taskThreadContext.taskmanagerOrgId,
      taskmanagerUserId: taskThreadContext.taskmanagerUserId,
      taskmanagerTaskId: taskThreadContext.taskmanagerTaskId,
      taskNumber: taskThreadContext.taskNumber,
      taskTitle: taskThreadContext.taskTitle,
      taskStatus: taskThreadContext.taskStatus,
      channel: TASK_MANAGER_ORBITA_CHANNEL,
      connection: TASK_MANAGER_ORBITA_CHANNEL,
      userConnection: TASK_MANAGER_ORBITA_CHANNEL,
      conversationId,
      orbitaUserId: senderId,
      clientPlatform,
      messageId: message.id,
      kind: message.kind,
      text: taskThreadText || undefined,
      taskManagerMentioned: true,
      ...replyFields,
      attachment: attachments[0] ?? null,
      attachments,
      sentAt: message.createdAt ?? new Date().toISOString(),
    });

    const response = await postTaskmanagerWebhook(webhookUrl, raw, secret);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const reason = `Task Manager Orbita webhook failed: ${response.status} ${text}`;
      console.error(reason);
      return { forwarded: false, reason };
    }

    const responseText = await response.text().catch(() => "");
    const responseJson = responseText ? safeJsonParse(responseText) : {};
    if (responseJson?.agent_dispatched === false) {
      return {
        forwarded: false,
        reason: responseJson.reason || "Task Manager did not dispatch the agent for this message.",
      };
    }

    return { forwarded: true };
  }

  const conversationKind = await loadConversationKind(conversationId);
  const isDirectAgentConversationKind = conversationKind.kind === "direct" || conversationKind.kind === "taskmanager";
  if (!isDirectAgentConversationKind) {
    console.info("[orbita-taskmanager-forward] skipped non-direct fallback", {
      conversationId,
      kind: conversationKind.kind,
      title: conversationKind.title,
      reason: "Only direct agent conversations can use direct-agent forwarding.",
    });
    return { forwarded: false, reason: "Only @orbita mentions in linked task threads are forwarded to the agent." };
  }

  const { data: link, error } = await supabase
    .from("taskmanager_agent_links")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  let activeLink = link;
  if (!activeLink) {
    // Self-heal stale agent-thread links after employee remove/re-add flows.
    // If this is a direct chat with the Task Manager agent, reuse the user's
    // enabled mapping and repoint it to this conversation.
    const participants = await loadConversationParticipants(conversationId);
    const senderParticipant = participants.find((row) => row.user_id === senderId);
    if (!senderParticipant) {
      return { forwarded: false, reason: "Conversation is not linked to Task Manager." };
    }

    const agentParticipant = participants.find((row) => {
      const about = typeof row.profiles?.about === "string" ? row.profiles.about.trim().toLowerCase() : "";
      return about === "task manager agent";
    });
    if (!agentParticipant?.user_id) {
      return { forwarded: false, reason: "Conversation is not linked to Task Manager." };
    }

    const { data: fallbackLinks, error: fallbackError } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("orbita_user_id", senderId)
      .eq("agent_profile_id", agentParticipant.user_id)
      .eq("enabled", true)
      .order("updated_at", { ascending: false })
      .limit(2);
    if (fallbackError) throw fallbackError;

    if (!(fallbackLinks ?? []).length) {
      return { forwarded: false, reason: "Conversation is not linked to Task Manager." };
    }
    if ((fallbackLinks ?? []).length > 1) {
      return {
        forwarded: false,
        reason: "Conversation is ambiguous because this Orbita user is linked to multiple Task Manager employees.",
      };
    }

    const [fallbackLink] = fallbackLinks;

    const { data: reboundLink, error: reboundError } = await supabase
      .from("taskmanager_agent_links")
      .update({
        conversation_id: conversationId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", fallbackLink.id)
      .select("*")
      .single();
    if (reboundError) throw reboundError;
    activeLink = reboundLink;
  }
  if (activeLink.agent_profile_id === senderId) return { forwarded: false, reason: "Sender is the Task Manager agent." };
  const { data: sourceAgentProfile, error: sourceAgentProfileError } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", activeLink.agent_profile_id)
    .maybeSingle();
  if (sourceAgentProfileError) throw sourceAgentProfileError;

  const replyFields = replyToPayloadFields(message);
  console.info("[orbita-taskmanager-forward] direct agent payload", {
    conversationId,
    messageId: message.id,
    taskmanagerUserId: activeLink.taskmanager_user_id,
    replyToMessageId: replyFields.replyToMessageId ?? null,
    replyToBody: typeof replyFields.replyTo?.body === "string" ? replyFields.replyTo.body.slice(0, 180) : null,
  });
  const raw = JSON.stringify({
    taskmanagerOrgId: activeLink.taskmanager_org_id,
    taskmanagerUserId: activeLink.taskmanager_user_id,
    sourceAgentProfileId: activeLink.agent_profile_id,
    sourceAgentConversationId: activeLink.conversation_id,
    sourceAgentDisplayName: sourceAgentProfile?.display_name ?? "",
    channel: TASK_MANAGER_ORBITA_CHANNEL,
    connection: TASK_MANAGER_ORBITA_CHANNEL,
    userConnection: TASK_MANAGER_ORBITA_CHANNEL,
    conversationId,
    orbitaUserId: senderId,
    clientPlatform,
    messageId: message.id,
    kind: message.kind,
    text: taskManagerTextOverride || message.body || undefined,
    ...replyFields,
    attachment: attachments[0] ?? null,
    attachments,
    sentAt: message.createdAt ?? new Date().toISOString(),
  });

  const response = await postTaskmanagerWebhook(webhookUrl, raw, secret);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const reason = `Task Manager Orbita webhook failed: ${response.status} ${text}`;
    console.error(reason);
    return { forwarded: false, reason };
  }

  return { forwarded: true };
}

async function handleServiceAction(action, payload) {
  if (action === "link_taskmanager_user") {
    const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
    const taskmanagerUserId = requiredString(payload, "taskmanagerUserId");
    const phone = normalizePhone(requiredString(payload, "phone"));
    const agentDisplayName = normalizeTaskmanagerAgentDisplayName(optionalString(payload, "agentDisplayName"));

    const { data: orbitaProfile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("phone", phone)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!orbitaProfile) throw new Error("No Orbita user found for that phone number.");

    const agentProfileId = await ensureTaskmanagerAgentProfile(taskmanagerOrgId, agentDisplayName);

    const { data: existing, error: existingError } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_user_id", taskmanagerUserId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing?.enabled && existing.orbita_user_id === orbitaProfile.id && existing.agent_profile_id === agentProfileId) {
      await materializePendingTaskThreadMemberships(taskmanagerOrgId, taskmanagerUserId, orbitaProfile.id);
      return {
        orbitaProfileId: existing.orbita_user_id,
        conversationId: existing.conversation_id,
        channel: TASK_MANAGER_ORBITA_CHANNEL,
        connection: TASK_MANAGER_ORBITA_CHANNEL,
        userConnection: TASK_MANAGER_ORBITA_CHANNEL,
      };
    }

    const conversation = await createTaskmanagerConversation(agentProfileId, orbitaProfile.id, agentDisplayName);

    const { data: link, error: linkError } = await supabase
      .from("taskmanager_agent_links")
      .upsert(
        {
          taskmanager_org_id: taskmanagerOrgId,
          taskmanager_user_id: taskmanagerUserId,
          orbita_user_id: orbitaProfile.id,
          agent_profile_id: agentProfileId,
          conversation_id: conversation.id,
          enabled: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "taskmanager_org_id,taskmanager_user_id" },
      )
      .select()
      .single();
    if (linkError) throw linkError;
    await materializePendingTaskThreadMemberships(taskmanagerOrgId, taskmanagerUserId, orbitaProfile.id);

    return {
      orbitaProfileId: link.orbita_user_id,
      conversationId: link.conversation_id,
      channel: TASK_MANAGER_ORBITA_CHANNEL,
      connection: TASK_MANAGER_ORBITA_CHANNEL,
      userConnection: TASK_MANAGER_ORBITA_CHANNEL,
    };
  }

  if (action === "ensure_task_thread") {
    return ensureTaskmanagerTaskThread(payload);
  }

  if (action === "notify_task_thread_status_changed") {
    const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
    const taskmanagerTaskId = requiredString(payload, "taskmanagerTaskId");
    const status = requiredString(payload, "status");
    const { data: thread, error: threadError } = await supabase
      .from("taskmanager_task_threads")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_task_id", taskmanagerTaskId)
      .maybeSingle();
    if (threadError) throw threadError;
    if (!thread) {
      return { notified: false, reason: "Task thread not found." };
    }
    return notifySourceAgentConversationForThreadStatus(thread, status);
  }

  if (action === "update_taskmanager_agent_name") {
    const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
    const agentDisplayName = normalizeTaskmanagerAgentDisplayName(requiredString(payload, "agentDisplayName"));
    const result = await updateTaskmanagerAgentPresentation(taskmanagerOrgId, agentDisplayName);
    return {
      displayName: result.displayName,
      updatedAgentProfiles: result.agentProfileIds.length,
      updatedConversations: result.conversationIds.length,
    };
  }

  if (action === "send_agent_message") {
    const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
    const taskmanagerUserId = requiredString(payload, "taskmanagerUserId");
    const conversationId = requiredString(payload, "conversationId");
    const body = requiredString(payload, "body").slice(0, 5000);
    const attachmentInput = isRecord(payload.attachment) ? payload.attachment : null;
    const requesterTaskmanagerUserId = optionalString(payload, "requesterTaskmanagerUserId");

    const { data: exactLink, error: exactLinkError } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_user_id", taskmanagerUserId)
      .eq("conversation_id", conversationId)
      .eq("enabled", true)
      .maybeSingle();
    if (exactLinkError) throw exactLinkError;

    let link = exactLink;
    if (!link) {
      const { data: fallbackLinks, error: fallbackLinkError } = await supabase
        .from("taskmanager_agent_links")
        .select("*")
        .eq("taskmanager_org_id", taskmanagerOrgId)
        .eq("taskmanager_user_id", taskmanagerUserId)
        .eq("enabled", true)
        .order("updated_at", { ascending: false })
        .limit(2);
      if (fallbackLinkError) throw fallbackLinkError;
      if (!(fallbackLinks ?? []).length) {
        throw new Error("Recipient is not linked to Orbita for this Task Manager organization.");
      }
      if ((fallbackLinks ?? []).length > 1) {
        throw new Error("Recipient has multiple active Orbita links. Ask admin to relink the employee.");
      }
      link = fallbackLinks[0];
      pushLog("service.send_agent_message_recovered_stale_link", {
        requestedConversationId: conversationId,
        recoveredConversationId: link.conversation_id,
        taskmanagerOrgId,
        taskmanagerUserId,
      });
    }
    const deliveryConversationId = link.conversation_id || conversationId;

    // Some older links may point to conversations missing one side due to
    // partial setup from previous flows. Heal membership before inserting
    // so delivery and push recipient resolution stay valid.
    await ensureConversationParticipants(deliveryConversationId, [
      { user_id: link.agent_profile_id, role: "owner" },
      { user_id: link.orbita_user_id, role: "member" },
    ]);

    let requesterLink = null;
    if (requesterTaskmanagerUserId && requesterTaskmanagerUserId !== taskmanagerUserId) {
      const { data, error: requesterError } = await supabase
        .from("taskmanager_agent_links")
        .select("*")
        .eq("taskmanager_org_id", taskmanagerOrgId)
        .eq("taskmanager_user_id", requesterTaskmanagerUserId)
        .eq("enabled", true)
        .maybeSingle();
      if (requesterError) throw requesterError;
      requesterLink = data;
    }

    const hasExternalRequester =
      requesterTaskmanagerUserId && requesterTaskmanagerUserId !== taskmanagerUserId;
    const replyInsert = await buildReplyInsertOptions(deliveryConversationId, payload);
    const messagePayload = {
      body,
      ...(replyInsert.replyTo ? { replyTo: replyInsert.replyTo } : {}),
      ...(hasExternalRequester
        ? {
            system: {
              kind: TASK_REQUEST_SYSTEM_KIND,
              taskmanagerOrgId,
              taskmanagerUserId,
              requesterTaskmanagerUserId,
              requesterConversationId: requesterLink?.conversation_id ?? "",
              requesterOrbitaUserId: requesterLink?.orbita_user_id ?? "",
            },
          }
        : {}),
    };

    pushLog("service.send_agent_message", {
      conversationId,
      taskmanagerOrgId,
      taskmanagerUserId,
      requesterTaskmanagerUserId: requesterTaskmanagerUserId || null,
    });

    const attachmentRow = attachmentInput ? await createServiceAttachment(link.agent_profile_id, attachmentInput) : null;
    const kind = attachmentRow
      ? messageKindFromAttachment(attachmentMetadata(attachmentRow).kind, attachmentRow.mime_type)
      : "text";
    const message = await insertMessageWithReceipts(deliveryConversationId, link.agent_profile_id, kind, messagePayload, {
      awaitPush: true,
      pushSource: "send_agent_message",
      replyToMessageId: replyInsert.replyToMessageId,
    });
    const linkedAttachment = attachmentRow ? await linkAttachmentToMessage(attachmentRow, message.id) : null;
    const mappedAttachments = linkedAttachment
      ? [mapAttachment(linkedAttachment, await signedAttachmentUrl(linkedAttachment, 12 * 60 * 60))]
      : [];
    pushLog("service.send_agent_message_inserted", {
      conversationId: deliveryConversationId,
      messageId: message.id,
      taskmanagerUserId,
    });
    return { message: mapMessage(message, mappedAttachments) };
  }

  if (action === "send_task_thread_agent_message") {
    const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
    const taskmanagerUserId = requiredString(payload, "taskmanagerUserId");
    const taskmanagerTaskId = requiredString(payload, "taskmanagerTaskId");
    const body = requiredString(payload, "body").slice(0, 5000);
    const attachmentInput = isRecord(payload.attachment) ? payload.attachment : null;
    const requesterTaskmanagerUserId = optionalString(payload, "requesterTaskmanagerUserId");

    const { data: thread, error: threadError } = await supabase
      .from("taskmanager_task_threads")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_task_id", taskmanagerTaskId)
      .maybeSingle();
    if (threadError) throw threadError;
    if (!thread?.conversation_id || !thread?.agent_profile_id) {
      throw new Error("Task thread is not available in Orbita yet.");
    }

    const { data: member, error: memberError } = await supabase
      .from("taskmanager_task_thread_members")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_task_id", taskmanagerTaskId)
      .eq("taskmanager_user_id", taskmanagerUserId)
      .eq("status", "linked")
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member?.orbita_user_id) {
      throw new Error("Recipient is not linked to Orbita for this task thread.");
    }

    await ensureConversationParticipants(thread.conversation_id, [
      { user_id: thread.agent_profile_id, role: "owner" },
      { user_id: member.orbita_user_id, role: member.role || "member" },
    ]);

    const replyInsert = await buildReplyInsertOptions(thread.conversation_id, payload);
    const messagePayload = {
      body,
      ...(replyInsert.replyTo ? { replyTo: replyInsert.replyTo } : {}),
      system: {
        kind: "task_thread_agent_message",
        taskmanagerOrgId,
        taskmanagerUserId,
        taskmanagerTaskId,
        taskNumber: thread.task_number,
        requesterTaskmanagerUserId: requesterTaskmanagerUserId || "",
      },
    };

    pushLog("service.send_task_thread_agent_message", {
      conversationId: thread.conversation_id,
      taskmanagerOrgId,
      taskmanagerUserId,
      taskmanagerTaskId,
    });

    const attachmentRow = attachmentInput ? await createServiceAttachment(thread.agent_profile_id, attachmentInput) : null;
    const kind = attachmentRow
      ? messageKindFromAttachment(attachmentMetadata(attachmentRow).kind, attachmentRow.mime_type)
      : "text";
    const message = await insertMessageWithReceipts(thread.conversation_id, thread.agent_profile_id, kind, messagePayload, {
      awaitPush: true,
      pushSource: "send_task_thread_agent_message",
      replyToMessageId: replyInsert.replyToMessageId,
    });
    const linkedAttachment = attachmentRow ? await linkAttachmentToMessage(attachmentRow, message.id) : null;
    const mappedAttachments = linkedAttachment
      ? [mapAttachment(linkedAttachment, await signedAttachmentUrl(linkedAttachment, 12 * 60 * 60))]
      : [];
    return { message: mapMessage(message, mappedAttachments) };
  }

  if (action === "taskmanager_admin_status_changed") {
    const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
    const taskmanagerUserId = requiredString(payload, "taskmanagerUserId");
    const role = optionalString(payload, "role") || "member";
    const isActive = payload.isActive !== false;

    const { data: links, error } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_user_id", taskmanagerUserId)
      .eq("enabled", true);
    if (error) throw error;

    const targetUserIds = [...new Set((links ?? []).map((link) => link.orbita_user_id).filter(Boolean))];
    if (!targetUserIds.length) {
      return { notified: 0 };
    }

    const primaryConversationId =
      typeof links?.[0]?.conversation_id === "string" ? links[0].conversation_id : null;
    await createRealtimeEvents(targetUserIds, "taskmanager_admin_status_changed", primaryConversationId, {
      taskmanagerOrgId,
      taskmanagerUserId,
      role,
      isActive,
      isAdmin: isActive && role === "admin",
    });

    return { notified: targetUserIds.length };
  }

  throw new Error(`Unknown service action: ${action}`);
}

async function handleAction(user, action, payload, req) {
  await ensureProfile(user);

  if (action === "create_taskmanager_admin_session") {
    const secret = process.env.TASK_MANAGER_ORBITA_SECRET;
    if (!TASK_MANAGER_ADMIN_SESSION_URL || !secret) {
      return { available: false, reason: "Task Manager admin mode is not configured." };
    }

    const conversationId = optionalString(payload, "conversationId");
    let query = supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("orbita_user_id", user.id)
      .eq("enabled", true)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (conversationId) query = query.eq("conversation_id", conversationId);

    const { data: links, error } = await query;
    if (error) throw error;
    const link = links?.[0];
    if (!link?.taskmanager_org_id || !link?.taskmanager_user_id || !link?.conversation_id) {
      return { available: false, reason: "This Orbita account is not linked to Task Manager." };
    }

    const raw = JSON.stringify({
      taskmanagerOrgId: link.taskmanager_org_id,
      taskmanagerUserId: link.taskmanager_user_id,
      orbitaUserId: user.id,
      conversationId: link.conversation_id,
    });

    const response = await fetch(TASK_MANAGER_ADMIN_SESSION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-orbita-signature": `sha256=${hmacSha256(raw, secret)}`,
      },
      body: raw,
    });
    const data = await response.json().catch(() => null);
    if (response.status === 403) {
      return { available: false, reason: apiErrorMessage(data) || "Task Manager admin mode is not enabled for this user." };
    }
    if (!response.ok) {
      throw new Error(apiErrorMessage(data) || `Task Manager admin session failed: ${response.status}`);
    }

    return {
      available: true,
      apiBaseUrl: clientReachableTaskManagerApiBaseUrl(TASK_MANAGER_ADMIN_SESSION_URL, req),
      session: data,
    };
  }

  if (action === "bootstrap") {
    return {
      profile: mapProfile(await getProfile(user.id), user.id),
      contacts: await loadContacts(user.id),
      conversations: await loadConversations(user.id),
      statuses: await loadStatuses(user.id),
    };
  }

  if (action === "update_profile") {
    const displayName = requiredString(payload, "displayName").slice(0, 80);
    const about = (optionalString(payload, "about") || "Available").slice(0, 140);
    const { data, error } = await supabase
      .from("profiles")
      .update({ display_name: displayName, about, updated_at: new Date().toISOString() })
      .eq("id", user.id)
      .select()
      .single();
    if (error) throw error;
    return { profile: mapProfile(data, user.id) };
  }

  if (action === "search_users") {
    const query = requiredString(payload, "query");
    const normalized = normalizePhone(query);
    const { data: byPhone, error: phoneError } = await supabase
      .from("profiles")
      .select("*")
      .eq("phone", normalized)
      .neq("id", user.id)
      .limit(20);
    if (phoneError) throw phoneError;

    const { data: byName, error: nameError } = await supabase
      .from("profiles")
      .select("*")
      .ilike("display_name", `%${query.replaceAll("%", "\\%")}%`)
      .neq("id", user.id)
      .limit(20);
    if (nameError) throw nameError;

    const users = new Map();
    [...(byPhone ?? []), ...(byName ?? [])].forEach((profile) => users.set(profile.id, profile));
    return { users: [...users.values()].map(mapProfile) };
  }

  if (action === "add_contact_by_phone") {
    const phone = normalizePhone(requiredString(payload, "phone"));
    const hasNickname = typeof payload.nickname === "string";
    const nickname = hasNickname ? optionalString(payload, "nickname").slice(0, 80) : "";
    const { data: contact, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("phone", phone)
      .neq("id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!contact) throw new Error("No Orbita user found for that phone number.");

    const contactRow = { owner_id: user.id, contact_user_id: contact.id };
    if (hasNickname) contactRow.nickname = nickname || null;
    const { error: insertError } = await supabase
      .from("contacts")
      .upsert(contactRow, { onConflict: "owner_id,contact_user_id" });
    if (insertError) throw insertError;
    return { contact: mapProfile({ ...contact, nickname }, user.id) };
  }

  if (action === "create_direct_conversation") {
    return { conversation: await createDirectConversation(user.id, requiredString(payload, "otherUserId")) };
  }

  if (action === "create_group") {
    const title = requiredString(payload, "title").slice(0, 100);
    const memberIds = [...new Set(stringArray(payload, "memberIds").filter((id) => id !== user.id))];
    const { data: conversation, error } = await supabase
      .from("conversations")
      .insert({
        kind: "group",
        title,
        created_by: user.id,
        invite_code: randomUUID().slice(0, 8).toUpperCase(),
      })
      .select()
      .single();
    if (error) throw error;

    const participants = [
      { conversation_id: conversation.id, user_id: user.id, role: "owner" },
      ...memberIds.map((memberId) => ({ conversation_id: conversation.id, user_id: memberId, role: "member" })),
    ];
    const { error: participantError } = await supabase.from("conversation_participants").insert(participants);
    if (participantError) throw participantError;

    await createRealtimeEvents(memberIds, "group_created", conversation.id, { title, createdBy: user.id });
    const created = (await loadConversations(user.id)).find((item) => item.id === conversation.id);
    if (!created) throw new Error("Unable to load created group.");
    return { conversation: created };
  }

  if (action === "add_group_members") {
    const conversationId = requiredString(payload, "conversationId");
    const memberIds = [...new Set(stringArray(payload, "memberIds").filter((id) => id !== user.id))];
    const conversation = await getConversation(user.id, conversationId);
    if (conversation.kind !== "group") throw new Error("Members can only be added to groups.");
    if (!(await isAdmin(user.id, conversationId))) throw new Error("Only group admins can add members.");

    const { error } = await supabase.from("conversation_participants").upsert(
      memberIds.map((memberId) => ({ conversation_id: conversationId, user_id: memberId, role: "member" })),
      { onConflict: "conversation_id,user_id" },
    );
    if (error) throw error;

    await createRealtimeEvents(memberIds, "group_member_added", conversationId, { addedBy: user.id });
    const updated = (await loadConversations(user.id)).find((item) => item.id === conversationId);
    if (!updated) throw new Error("Unable to load updated group.");
    return { conversation: updated };
  }

  if (action === "add_task_thread_members") {
    const conversationId = requiredString(payload, "conversationId");
    const memberIds = [...new Set(stringArray(payload, "memberIds").filter((id) => id !== user.id))];
    if (!memberIds.length) throw new Error("Choose at least one member.");
    await getConversation(user.id, conversationId);

    const { data: thread, error: threadError } = await supabase
      .from("taskmanager_task_threads")
      .select("*")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (threadError) throw threadError;
    if (!thread) throw new Error("Task thread not found.");

    await ensureConversationParticipants(
      conversationId,
      memberIds.map((memberId) => ({ user_id: memberId, role: "member" })),
    );

    const { data: links, error: linkError } = await supabase
      .from("taskmanager_agent_links")
      .select("taskmanager_user_id, orbita_user_id")
      .eq("taskmanager_org_id", thread.taskmanager_org_id)
      .eq("enabled", true)
      .in("orbita_user_id", memberIds);
    if (linkError) throw linkError;

    const now = new Date().toISOString();
    const linkedRows = (links ?? [])
      .filter((link) => link.taskmanager_user_id && link.orbita_user_id)
      .map((link) => ({
        taskmanager_org_id: thread.taskmanager_org_id,
        taskmanager_task_id: thread.taskmanager_task_id,
        taskmanager_user_id: link.taskmanager_user_id,
        orbita_user_id: link.orbita_user_id,
        role: "member",
        status: "linked",
        updated_at: now,
      }));

    if (linkedRows.length) {
      const { error: memberError } = await supabase
        .from("taskmanager_task_thread_members")
        .upsert(linkedRows, { onConflict: "taskmanager_org_id,taskmanager_task_id,taskmanager_user_id" });
      if (memberError) throw memberError;
    }

    await createRealtimeEvents(memberIds, "group_member_added", conversationId, {
      addedBy: user.id,
      kind: "task_thread_member_added",
      taskmanagerOrgId: thread.taskmanager_org_id,
      taskmanagerTaskId: thread.taskmanager_task_id,
    });
    const updated = (await loadConversations(user.id)).find((item) => item.id === conversationId);
    if (!updated) throw new Error("Unable to load updated task thread.");
    return { conversation: updated };
  }

  if (action === "create_taskmanager_task_shell") {
    const conversationId = requiredString(payload, "conversationId");
    const title = requiredString(payload, "title").slice(0, 500);
    const clientPlatform = normalizeClientPlatform(optionalString(payload, "clientPlatform"));
    const secret = process.env.TASK_MANAGER_ORBITA_SECRET;
    if (!TASK_MANAGER_ORBITA_TASK_SHELL_URL || !secret) {
      throw new Error("Task Manager task creation is not configured.");
    }

    const link = await loadDirectTaskmanagerLink(conversationId, user.id);
    const { data: sourceAgentProfile, error: sourceAgentProfileError } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", link.agent_profile_id)
      .maybeSingle();
    if (sourceAgentProfileError) throw sourceAgentProfileError;

    const raw = JSON.stringify({
      taskmanagerOrgId: link.taskmanager_org_id,
      taskmanagerUserId: link.taskmanager_user_id,
      orbitaUserId: user.id,
      title,
      conversationId,
      sourceAgentProfileId: link.agent_profile_id,
      sourceAgentConversationId: link.conversation_id,
      sourceAgentDisplayName: sourceAgentProfile?.display_name ?? "",
    });
    const response = await postTaskmanagerWebhook(TASK_MANAGER_ORBITA_TASK_SHELL_URL, raw, secret);
    const responseText = await response.text().catch(() => "");
    const responseJson = responseText ? safeJsonParse(responseText) : {};
    if (!response.ok || responseJson?.error) {
      throw new Error(responseJson?.error || responseText || `Task Manager task creation failed: ${response.status}`);
    }

    const task = responseJson;
    const taskId = typeof task?._id === "string" ? task._id : "";
    if (!taskId) throw new Error("Task Manager did not return a task id.");
    const thread = await waitForTaskmanagerTaskThread(link.taskmanager_org_id, taskId);

    await ensureConversationParticipants(thread.conversation_id, [
      { user_id: thread.agent_profile_id, role: "owner" },
      { user_id: user.id, role: "admin" },
    ]);

    const taskNumber = typeof task?.display_number === "string" ? task.display_number : thread.task_number;
    const displayBody = `Task title: ${title}`;
    const taskManagerPrompt =
      `@orbita Task ${taskNumber || ""} was just created from the main agent chat with title "${title}". ` +
      "Do not create another task or subtask. Use this current task thread and ask one question only: who should this task be assigned to? " +
      "When the user replies with the assignee, find the matching employee and update this current task with task.update. " +
      "The due date is already set to today at 6 PM by default, so do not ask for a deadline while creating this task.";
    const message = await insertMessageWithReceipts(thread.conversation_id, user.id, "text", { body: displayBody }, {
      pushSource: "create_taskmanager_task_shell",
    });
    const mappedMessage = await mapMessageWithAttachments(message);
    const taskManagerForward = await forwardTaskmanagerInbound(
      thread.conversation_id,
      user.id,
      mappedMessage,
      [],
      taskManagerPrompt,
      clientPlatform,
      true,
    ).catch((error) => {
      console.error("[create-task-shell] follow-up forward failed", {
        conversationId: thread.conversation_id,
        taskmanagerTaskId: taskId,
        error: errorMessage(error),
      });
      return { forwarded: false, reason: errorMessage(error) };
    });

    const conversation = (await loadConversations(user.id)).find((item) => item.id === thread.conversation_id);
    if (!conversation) throw new Error("Unable to load created task thread.");

    return {
      conversation,
      message: mappedMessage,
      task,
      taskManagerForward,
    };
  }

  if (action === "list_taskmanager_org_members") {
    const conversationId = requiredString(payload, "conversationId");
    await getConversation(user.id, conversationId);
    const taskThreadContext = await loadTaskThreadForwardingContext(conversationId, user.id);
    let taskmanagerOrgId = taskThreadContext && !taskThreadContext.skip ? taskThreadContext.taskmanagerOrgId : "";
    if (!taskmanagerOrgId) {
      const { data: directLink, error: directLinkError } = await supabase
        .from("taskmanager_agent_links")
        .select("taskmanager_org_id")
        .eq("conversation_id", conversationId)
        .eq("orbita_user_id", user.id)
        .eq("enabled", true)
        .maybeSingle();
      if (directLinkError) throw directLinkError;
      taskmanagerOrgId = directLink?.taskmanager_org_id ?? "";
    }
    if (!taskmanagerOrgId) {
      const { data: userLink, error: userLinkError } = await supabase
        .from("taskmanager_agent_links")
        .select("taskmanager_org_id")
        .eq("orbita_user_id", user.id)
        .eq("enabled", true)
        .limit(1)
        .maybeSingle();
      if (userLinkError) throw userLinkError;
      taskmanagerOrgId = userLink?.taskmanager_org_id ?? "";
    }
    if (!taskmanagerOrgId) {
      throw new Error("This account is not linked to a Task Manager organization.");
    }

    const { data: links, error: linkError } = await supabase
      .from("taskmanager_agent_links")
      .select("orbita_user_id")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("enabled", true);
    if (linkError) throw linkError;

    const profileIds = [...new Set((links ?? []).map((link) => link.orbita_user_id).filter(Boolean))];
    if (!profileIds.length) return { members: [] };

    const { data: profiles, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .in("id", profileIds);
    if (profileError) throw profileError;

    const contactNicknames = await loadContactNicknames(user.id);
    return {
      members: (profiles ?? [])
        .map((profile) => mapProfile({ ...profile, nickname: contactNicknames.get(profile.id) }, user.id))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }

  if (action === "create_task_thread_subtask") {
    const conversationId = requiredString(payload, "conversationId");
    const title = requiredString(payload, "title").slice(0, 500);
    const description = optionalString(payload, "description").slice(0, 5000);
    const dueDate = optionalString(payload, "dueDate");
    const assigneeOrbitaUserId = requiredString(payload, "assigneeOrbitaUserId");
    const memberOrbitaUserIds = [...new Set(stringArray(payload, "memberOrbitaUserIds"))];
    if (!TASK_MANAGER_ORBITA_SUBTASK_URL || !process.env.TASK_MANAGER_ORBITA_SECRET) {
      throw new Error("Task Manager subtask creation is not configured.");
    }

    await getConversation(user.id, conversationId);
    const taskThreadContext = await loadTaskThreadForwardingContext(conversationId, user.id);
    if (!taskThreadContext || taskThreadContext.skip) {
      throw new Error(taskThreadContext?.reason || "Only task thread members can create subtasks.");
    }

    const requestedOrbitaUserIds = [...new Set([assigneeOrbitaUserId, ...memberOrbitaUserIds])];
    const { data: links, error: linkError } = await supabase
      .from("taskmanager_agent_links")
      .select("taskmanager_user_id, orbita_user_id")
      .eq("taskmanager_org_id", taskThreadContext.taskmanagerOrgId)
      .eq("enabled", true)
      .in("orbita_user_id", requestedOrbitaUserIds);
    if (linkError) throw linkError;
    const taskmanagerUserIdByOrbitaId = new Map(
      (links ?? [])
        .filter((link) => link.orbita_user_id && link.taskmanager_user_id)
        .map((link) => [link.orbita_user_id, link.taskmanager_user_id]),
    );
    const assigneeId = taskmanagerUserIdByOrbitaId.get(assigneeOrbitaUserId);
    if (!assigneeId) throw new Error("Selected assignee is not linked to Task Manager.");
    const threadMemberIds = memberOrbitaUserIds
      .map((orbitaUserId) => taskmanagerUserIdByOrbitaId.get(orbitaUserId))
      .filter(Boolean);

    const raw = JSON.stringify({
      taskmanagerOrgId: taskThreadContext.taskmanagerOrgId,
      taskmanagerUserId: taskThreadContext.taskmanagerUserId,
      orbitaUserId: user.id,
      conversationId,
      parentTaskId: taskThreadContext.taskmanagerTaskId,
      assigneeId,
      title,
      ...(description ? { description } : {}),
      ...(dueDate ? { dueDate } : {}),
      threadMemberIds,
    });
    const response = await fetch(TASK_MANAGER_ORBITA_SUBTASK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-orbita-signature": `sha256=${hmacSha256(raw, process.env.TASK_MANAGER_ORBITA_SECRET)}`,
      },
      body: raw,
    });
    const responseText = await response.text().catch(() => "");
    const data = responseText ? safeJsonParse(responseText) : null;
    if (!response.ok) {
      throw new Error(apiErrorMessage(data) || `Task Manager subtask creation failed: ${response.status}`);
    }

    const createdTaskId = typeof data?._id === "string" ? data._id : "";
    const createdTaskNumber = typeof data?.display_number === "string" ? data.display_number : "Subtask";
    const createdTitle = typeof data?.title === "string" && data.title.trim() ? data.title.trim() : title;
    const createdThread = createdTaskId
      ? await waitForTaskmanagerTaskThread(taskThreadContext.taskmanagerOrgId, createdTaskId).catch((error) => {
          console.error("[task-thread-subtask] created thread lookup failed", {
            conversationId: taskThreadContext.conversationId,
            createdTaskId,
            error: errorMessage(error),
          });
          return null;
        })
      : null;
    if (taskThreadContext.agentProfileId && taskThreadContext.conversationId) {
      await insertMessageWithReceipts(
        taskThreadContext.conversationId,
        taskThreadContext.agentProfileId,
        "text",
        {
          body: `Created ${createdTaskNumber} "${createdTitle}".`,
          system: {
            kind: "task_thread_subtask_created",
            taskmanagerOrgId: taskThreadContext.taskmanagerOrgId,
            taskmanagerTaskId: createdTaskId,
            parentTaskId: taskThreadContext.taskmanagerTaskId,
            taskNumber: createdTaskNumber,
            title: createdTitle,
            taskThreadConversationId: createdThread?.conversation_id ?? null,
            event: "created",
          },
        },
        {
          awaitPush: true,
          clientMessageId: createdTaskId
            ? `task-thread-subtask-created:${createdTaskId}`
            : `task-thread-subtask-created:${taskThreadContext.taskmanagerTaskId}:${Date.now()}`,
          pushSource: "task_thread_subtask_created",
        },
      ).catch((error) => {
        console.error("[task-thread-subtask] parent acknowledgement failed", {
          conversationId: taskThreadContext.conversationId,
          parentTaskId: taskThreadContext.taskmanagerTaskId,
          createdTaskId,
          error: errorMessage(error),
        });
      });
    }

    const conversations = await loadConversations(user.id);
    return {
      task: data,
      conversation:
        (createdThread?.conversation_id ? conversations.find((item) => item.id === createdThread.conversation_id) : null) ??
        conversations.find((item) => item.taskThread?.taskmanagerTaskId === data?._id) ??
        conversations.find((item) => item.id === conversationId) ??
        null,
    };
  }

  if (action === "update_task_thread_status") {
    const conversationId = requiredString(payload, "conversationId");
    const status = requiredString(payload, "status");
    if (!["open", "in_progress", "done", "discarded"].includes(status)) {
      throw new Error("Task status is invalid.");
    }
    if (!TASK_MANAGER_ORBITA_TASK_THREAD_STATUS_URL || !process.env.TASK_MANAGER_ORBITA_SECRET) {
      throw new Error("Task Manager task status updates are not configured.");
    }

    await getConversation(user.id, conversationId);
    const taskThreadContext = await loadTaskThreadForwardingContext(conversationId, user.id);
    if (!taskThreadContext || taskThreadContext.skip) {
      throw new Error(taskThreadContext?.reason || "Only task thread members can change task status.");
    }

    const raw = JSON.stringify({
      taskmanagerOrgId: taskThreadContext.taskmanagerOrgId,
      taskmanagerUserId: taskThreadContext.taskmanagerUserId,
      orbitaUserId: user.id,
      conversationId,
      taskId: taskThreadContext.taskmanagerTaskId,
      status,
    });
    const response = await fetch(TASK_MANAGER_ORBITA_TASK_THREAD_STATUS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-orbita-signature": `sha256=${hmacSha256(raw, process.env.TASK_MANAGER_ORBITA_SECRET)}`,
      },
      body: raw,
    });
    const responseText = await response.text().catch(() => "");
    const data = responseText ? safeJsonParse(responseText) : null;
    if (!response.ok) {
      throw new Error(apiErrorMessage(data) || `Task Manager task status update failed: ${response.status}`);
    }

    const { error: updateError } = await supabase
      .from("taskmanager_task_threads")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .eq("taskmanager_task_id", taskThreadContext.taskmanagerTaskId);
    if (updateError) throw updateError;

    const conversations = await loadConversations(user.id);
    return {
      task: data,
      conversation: conversations.find((item) => item.id === conversationId) ?? null,
    };
  }

  if (action === "notify_task_thread_status_changed") {
    return notifySourceAgentConversationForTaskStatus(
      user.id,
      requiredString(payload, "conversationId"),
      requiredString(payload, "status"),
    );
  }

  if (action === "list_messages") {
    return await loadMessages(user.id, requiredString(payload, "conversationId"), {
      beforeCreatedAt: optionalString(payload, "beforeCreatedAt"),
      limit: typeof payload.limit === "number" ? payload.limit : undefined,
    });
  }

  if (action === "mark_conversation_read") {
    await markConversationRead(user.id, requiredString(payload, "conversationId"));
    return { ok: true };
  }

  if (
    action === "register_push_token" ||
    action === "register_fcm_token" ||
    action === "register_expo_push_token"
  ) {
    const pushToken = optionalString(payload, "pushToken");
    const token = pushToken && isExpoPushToken(pushToken) ? pushToken : null;
    const { error } = await supabase
      .from("profiles")
      .update({ expo_push_token: token, updated_at: new Date().toISOString() })
      .eq("id", user.id);
    if (error) throw error;
    if (PUSH_DEBUG) {
      console.log("[push] token updated", {
        userId: user.id,
        hasToken: Boolean(token),
        tokenPreview: token ? `${token.slice(0, 20)}...` : null,
      });
    }
    return { ok: true };
  }

  if (action === "send_message") {
    const conversationId = requiredString(payload, "conversationId");
    const body = optionalString(payload, "body").slice(0, 5000);
    const clientMessageId = optionalString(payload, "clientMessageId").slice(0, 128);
    const taskManagerText = optionalString(payload, "taskManagerText").slice(0, 5000);
    const taskManagerMentioned = payload.taskManagerMentioned === true;
    const clientPlatform = normalizeClientPlatform(optionalString(payload, "clientPlatform"));
    const attachmentId = optionalString(payload, "attachmentId");
    const replyToMessageId = optionalString(payload, "replyToMessageId");
    await getConversation(user.id, conversationId);
    if (clientMessageId) {
      const { data: existingMessage, error: existingMessageError } = await supabase
        .from("messages")
        .select("*")
        .eq("sender_id", user.id)
        .eq("client_message_id", clientMessageId)
        .maybeSingle();
      if (existingMessageError) throw existingMessageError;
      if (existingMessage) {
        return {
          message: await mapMessageWithAttachments(existingMessage),
          taskManagerForward: { forwarded: true },
        };
      }
    }
    const attachmentRow = attachmentId ? await getOwnedStagedAttachment(user.id, attachmentId) : null;
    const kind = attachmentRow
      ? messageKindFromAttachment(attachmentMetadata(attachmentRow).kind, attachmentRow.mime_type)
      : optionalString(payload, "kind") || "text";
    if (!body && !attachmentRow) throw new Error("Message body or attachment is required.");

    let replyTo = null;
    let replyToStorageMessageId = null;
    let replyToLookupError = null;
    if (replyToMessageId) {
      try {
        replyTo = await buildReplyPreview(conversationId, replyToMessageId);
        replyToStorageMessageId = replyTo.messageId;
      } catch (error) {
        replyToLookupError = errorMessage(error);
      }
    }
    if (!replyTo) {
      replyTo = clientReplyPreview(payload, replyToMessageId);
    }
    console.info("[orbita-send-message] reply target", {
      conversationId,
      senderId: user.id,
      clientMessageId,
      bodyPreview: body.slice(0, 180),
      taskManagerTextPreview: taskManagerText.slice(0, 180),
      taskManagerMentioned,
      bodyHasMention: hasOrbitaMention(body),
      taskManagerTextHasMention: hasOrbitaMention(taskManagerText),
      replyToMessageId: replyToMessageId || null,
      resolvedReplyToMessageId: replyTo?.messageId ?? null,
      storedReplyToMessageId: replyToStorageMessageId,
      replyToBody: replyTo?.body?.slice(0, 180) ?? null,
      replyToLookupError,
      usedClientReplyPreview: Boolean(replyTo && !replyToStorageMessageId),
    });
    const messagePayload = replyTo ? { body, replyTo } : { body };
    const message = await insertMessageWithReceipts(conversationId, user.id, kind, messagePayload, {
      clientMessageId,
      replyToMessageId: replyToStorageMessageId,
    });
    if (attachmentRow) {
      await linkAttachmentToMessage(attachmentRow, message.id);
    }
    const attachments = attachmentRow
      ? await loadAttachmentRowsForMessageIds([message.id]).then((map) => map.get(message.id) ?? [])
      : [];
    const mappedMessage = mapMessage(message, attachments);
    const runTaskmanagerPostSend = async () => {
      const taskManagerForward = await forwardTaskmanagerInbound(
        conversationId,
        user.id,
        mappedMessage,
        attachments,
        taskManagerText,
        clientPlatform,
        taskManagerMentioned,
      ).catch((error) => {
        const reason = errorMessage(error);
        console.error(reason, error);
        return { forwarded: false, reason };
      });
      const taskAcknowledgement = await maybeSendTaskAcknowledgementMessage(conversationId, user.id, body).catch((error) => {
        const reason = errorMessage(error);
        console.error(reason, error);
        return { error: reason };
      });
      return { taskAcknowledgement, taskManagerForward };
    };

    void runTaskmanagerPostSend().then((result) => {
      console.info("[orbita-send-message] async post-send completed", {
        conversationId,
        messageId: mappedMessage.id,
        kind,
        taskManagerForwarded: result.taskManagerForward?.forwarded ?? null,
        taskAcknowledged: Boolean(result.taskAcknowledgement?.message),
      });
    }).catch((error) => {
      console.error("[orbita-send-message] async post-send failed", {
        conversationId,
        messageId: mappedMessage.id,
        kind,
        error: errorMessage(error),
      });
    });

    return {
      message: mappedMessage,
      taskManagerForward: { forwarded: true, pending: true },
      taskAcknowledgement: { pending: true },
    };
  }

  if (action === "forward_messages") {
    const messageId = requiredString(payload, "messageId");
    const destinationConversationIds = [...new Set(stringArray(payload, "destinationConversationIds"))];
    if (!destinationConversationIds.length) throw new Error("Choose at least one destination.");

    const { data: sourceMessage, error: sourceError } = await supabase
      .from("messages")
      .select("*")
      .eq("id", messageId)
      .is("deleted_at", null)
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!sourceMessage) throw new Error("Message not found.");
    await getConversation(user.id, sourceMessage.conversation_id);

    const forwardedFrom = await buildForwardedFrom(sourceMessage, user.id);
    const sourceAttachmentsByMessageId = await loadAttachmentRowsForMessageIds([sourceMessage.id]);
    const sourceAttachments = sourceAttachmentsByMessageId.get(sourceMessage.id) ?? [];
    const { data: sourceAttachmentRows, error: attachmentError } = await supabase
      .from("media_attachments")
      .select("*")
      .eq("message_id", sourceMessage.id)
      .order("created_at", { ascending: true });
    if (attachmentError) throw attachmentError;

    const forwardedMessages = [];
    for (const destinationConversationId of destinationConversationIds) {
      await getConversation(user.id, destinationConversationId);
      const forwardedRow = await insertMessageWithReceipts(destinationConversationId, user.id, sourceMessage.kind, {
        body: messageBody(sourceMessage),
        forwardedFrom,
      });

      if ((sourceAttachmentRows ?? []).length) {
        for (const sourceAttachmentRow of sourceAttachmentRows) {
          await cloneAttachmentForMessage(sourceAttachmentRow, user.id, forwardedRow.id);
        }
      }

      const attachments = (await loadAttachmentRowsForMessageIds([forwardedRow.id])).get(forwardedRow.id) ?? [];
      const mappedMessage = mapMessage(forwardedRow, attachments);
      forwardedMessages.push(mappedMessage);
      void forwardTaskmanagerInbound(destinationConversationId, user.id, mappedMessage, attachments).catch((error) => {
        console.error(errorMessage(error), error);
      });
    }

    return { messages: forwardedMessages, sourceAttachments };
  }

  if (action === "create_status") {
    const text = requiredString(payload, "text").slice(0, 700);
    const visibility = optionalString(payload, "visibility") || "contacts";
    const { data, error } = await supabase
      .from("status_posts")
      .insert({ author_id: user.id, kind: "text", encrypted_payload: { text }, visibility })
      .select("*, profiles!status_posts_author_id_fkey(*), status_views(viewer_id)")
      .single();
    if (error) throw error;

    const created = (await loadStatuses(user.id)).find((status) => status.id === data.id);
    if (!created) throw new Error("Unable to load created status.");
    return { status: created };
  }

  if (action === "list_statuses") {
    return { statuses: await loadStatuses(user.id) };
  }

  throw new Error(`Unknown action: ${action}`);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = error.message ?? error.error_description ?? error.details ?? error.hint;
    if (typeof message === "string" && message.trim()) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return "Unexpected server error.";
    }
  }
  return "Unexpected server error.";
}

function apiErrorMessage(data) {
  if (!data || typeof data !== "object") return "";
  const message = data.message;
  if (typeof message === "string" && message.trim()) return message;
  const error = data.error;
  return typeof error === "string" ? error : "";
}
