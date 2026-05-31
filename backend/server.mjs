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

    if (pathname === "/api/messenger/media" || pathname === "/api/messenger-api/media") {
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

    if (pathname === "/api/messenger/avatar" || pathname === "/api/messenger-api/avatar") {
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

    if (pathname === "/api/messenger" || pathname === "/api/messenger-api") {
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

      sendJson(res, 200, await handleAction(data.user, action, payload), req);
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

function attachmentMetadata(row) {
  return isRecord(row.encrypted_metadata) ? row.encrypted_metadata : {};
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
  };
}

function mapMessage(row, attachments = []) {
  const payload = messagePayload(row);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: messageBody(row),
    attachments,
    forwardedFrom: parseForwardedFrom(payload),
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
  const filename = sanitizeFilename(String(form.get("filename") ?? file.name ?? requestedKind ?? "attachment"));
  const mimeType = typeof file.type === "string" && file.type ? file.type : "application/octet-stream";
  const kind = messageKindFromAttachment(requestedKind || undefined, mimeType);
  const buffer = Buffer.from(await file.arrayBuffer());
  const bucket = storageBucketForMessageKind(kind);
  const objectPath = `${userId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${filename}`;

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

  return {
    attachment: mapAttachment(data, await signedAttachmentUrl(data, 12 * 60 * 60)),
  };
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
      conversation_id: conversationId,
      sender_id: senderId,
      kind,
      encrypted_payload: payload,
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

  const contactNicknames = await loadContactNicknames(userId);
  const loaded = await Promise.all(
    (conversations ?? []).map(async (conversation) => {
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
        kind: conversation.kind,
        title:
          conversation.kind === "direct"
            ? directPeer?.displayName ?? "Direct chat"
            : conversation.title ?? "Group",
        avatarUrl: conversation.avatar_url,
        inviteCode: conversation.invite_code,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
        participants: mappedParticipants,
        lastMessage,
        unreadCount: await unreadCountForConversation(userId, conversation.id),
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
  if (existingLink?.agent_profile_id) return existingLink.agent_profile_id;

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

async function forwardTaskmanagerInbound(
  conversationId,
  senderId,
  message,
  attachments = [],
  taskManagerTextOverride = "",
) {
  const webhookUrl = process.env.TASK_MANAGER_ORBITA_WEBHOOK_URL;
  const secret = process.env.TASK_MANAGER_ORBITA_SECRET;
  if (!webhookUrl || !secret) {
    return { forwarded: false, reason: "Task Manager webhook is not configured." };
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

    const { data: fallbackLink, error: fallbackError } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("orbita_user_id", senderId)
      .eq("agent_profile_id", agentParticipant.user_id)
      .eq("enabled", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fallbackError) throw fallbackError;

    if (!fallbackLink) {
      return { forwarded: false, reason: "Conversation is not linked to Task Manager." };
    }

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

  const raw = JSON.stringify({
    taskmanagerOrgId: activeLink.taskmanager_org_id,
    taskmanagerUserId: activeLink.taskmanager_user_id,
    channel: TASK_MANAGER_ORBITA_CHANNEL,
    connection: TASK_MANAGER_ORBITA_CHANNEL,
    userConnection: TASK_MANAGER_ORBITA_CHANNEL,
    conversationId,
    orbitaUserId: senderId,
    messageId: message.id,
    kind: message.kind,
    text: taskManagerTextOverride || message.body || undefined,
    attachment: attachments[0] ?? null,
    attachments,
    sentAt: message.createdAt ?? new Date().toISOString(),
  });

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-orbita-signature": `sha256=${hmacSha256(raw, secret)}`,
    },
    body: raw,
  });
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
    const agentDisplayName = (optionalString(payload, "agentDisplayName") || "Task Manager Agent").slice(0, 80);

    const { data: orbitaProfile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("phone", phone)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!orbitaProfile) throw new Error("No Orbita user found for that phone number.");

    const agentProfileId = await ensureTaskmanagerAgentProfile(taskmanagerOrgId, agentDisplayName);

    // Prefer a single canonical link for the same Org + Orbita profile + Agent profile.
    // This prevents duplicate direct conversations from drifting over time.
    const { data: siblingLinks, error: siblingLinksError } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("orbita_user_id", orbitaProfile.id)
      .eq("agent_profile_id", agentProfileId)
      .order("updated_at", { ascending: false });
    if (siblingLinksError) throw siblingLinksError;

    if ((siblingLinks ?? []).length) {
      const links = siblingLinks ?? [];
      const primaryLink =
        links.find((row) => row.enabled && row.taskmanager_user_id === taskmanagerUserId) ??
        links.find((row) => row.enabled) ??
        links[0];

      const { data: normalizedLink, error: normalizeError } = await supabase
        .from("taskmanager_agent_links")
        .update({
          taskmanager_user_id: taskmanagerUserId,
          enabled: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", primaryLink.id)
        .select("*")
        .single();
      if (normalizeError) throw normalizeError;

      const duplicateIds = links.map((row) => row.id).filter((id) => id !== primaryLink.id);
      if (duplicateIds.length) {
        const { error: disableError } = await supabase
          .from("taskmanager_agent_links")
          .update({
            enabled: false,
            updated_at: new Date().toISOString(),
          })
          .in("id", duplicateIds);
        if (disableError) throw disableError;
      }

      await ensureConversationParticipants(normalizedLink.conversation_id, [
        { user_id: agentProfileId, role: "owner" },
        { user_id: orbitaProfile.id, role: "member" },
      ]);

      return {
        orbitaProfileId: normalizedLink.orbita_user_id,
        conversationId: normalizedLink.conversation_id,
        channel: TASK_MANAGER_ORBITA_CHANNEL,
        connection: TASK_MANAGER_ORBITA_CHANNEL,
        userConnection: TASK_MANAGER_ORBITA_CHANNEL,
      };
    }

    const { data: existing, error: existingError } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_user_id", taskmanagerUserId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing?.enabled && existing.orbita_user_id === orbitaProfile.id && existing.agent_profile_id === agentProfileId) {
      return {
        orbitaProfileId: existing.orbita_user_id,
        conversationId: existing.conversation_id,
        channel: TASK_MANAGER_ORBITA_CHANNEL,
        connection: TASK_MANAGER_ORBITA_CHANNEL,
        userConnection: TASK_MANAGER_ORBITA_CHANNEL,
      };
    }

    const conversation = await createDirectConversation(agentProfileId, orbitaProfile.id);

    const { data: conversationLink, error: conversationLinkError } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("conversation_id", conversation.id)
      .maybeSingle();
    if (conversationLinkError) throw conversationLinkError;
    if (conversationLink) {
      const belongsToSameOrbitaUser =
        conversationLink.taskmanager_org_id === taskmanagerOrgId &&
        conversationLink.orbita_user_id === orbitaProfile.id &&
        conversationLink.agent_profile_id === agentProfileId;
      if (!belongsToSameOrbitaUser) {
        throw new Error("This Orbita conversation is already linked to another Task Manager employee.");
      }

      const { data: reassignedLink, error: reassignError } = await supabase
        .from("taskmanager_agent_links")
        .update({
          taskmanager_user_id: taskmanagerUserId,
          enabled: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversationLink.id)
        .select()
        .single();
      if (reassignError) throw reassignError;

      return {
        orbitaProfileId: reassignedLink.orbita_user_id,
        conversationId: reassignedLink.conversation_id,
        channel: TASK_MANAGER_ORBITA_CHANNEL,
        connection: TASK_MANAGER_ORBITA_CHANNEL,
        userConnection: TASK_MANAGER_ORBITA_CHANNEL,
      };
    }

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

    return {
      orbitaProfileId: link.orbita_user_id,
      conversationId: link.conversation_id,
      channel: TASK_MANAGER_ORBITA_CHANNEL,
      connection: TASK_MANAGER_ORBITA_CHANNEL,
      userConnection: TASK_MANAGER_ORBITA_CHANNEL,
    };
  }

  if (action === "send_agent_message") {
    const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
    const taskmanagerUserId = requiredString(payload, "taskmanagerUserId");
    const conversationId = requiredString(payload, "conversationId");
    const body = requiredString(payload, "body").slice(0, 5000);
    const requesterTaskmanagerUserId = optionalString(payload, "requesterTaskmanagerUserId");

    const { data: link, error } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_user_id", taskmanagerUserId)
      .eq("conversation_id", conversationId)
      .eq("enabled", true)
      .single();
    if (error) throw error;

    // Some older links may point to conversations missing one side due to
    // partial setup from previous flows. Heal membership before inserting
    // so delivery and push recipient resolution stay valid.
    await ensureConversationParticipants(conversationId, [
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
    const messagePayload = {
      body,
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

    const message = await insertMessageWithReceipts(conversationId, link.agent_profile_id, "text", messagePayload, {
      awaitPush: true,
      pushSource: "send_agent_message",
    });
    pushLog("service.send_agent_message_inserted", {
      conversationId,
      messageId: message.id,
      taskmanagerUserId,
    });
    return { message: mapMessage(message, []) };
  }

  throw new Error(`Unknown service action: ${action}`);
}

async function handleAction(user, action, payload) {
  await ensureProfile(user);

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
    const taskManagerText = optionalString(payload, "taskManagerText").slice(0, 5000);
    const attachmentId = optionalString(payload, "attachmentId");
    await getConversation(user.id, conversationId);
    const attachmentRow = attachmentId ? await getOwnedStagedAttachment(user.id, attachmentId) : null;
    const kind = attachmentRow
      ? messageKindFromAttachment(attachmentMetadata(attachmentRow).kind, attachmentRow.mime_type)
      : optionalString(payload, "kind") || "text";
    if (!body && !attachmentRow) throw new Error("Message body or attachment is required.");

    const message = await insertMessageWithReceipts(conversationId, user.id, kind, { body });
    if (attachmentRow) {
      await linkAttachmentToMessage(attachmentRow, message.id);
    }
    const attachments = attachmentRow
      ? await loadAttachmentRowsForMessageIds([message.id]).then((map) => map.get(message.id) ?? [])
      : [];
    const mappedMessage = mapMessage(message, attachments);
    const taskManagerForward = await forwardTaskmanagerInbound(
      conversationId,
      user.id,
      mappedMessage,
      attachments,
      taskManagerText,
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

    return { message: mappedMessage, taskManagerForward, taskAcknowledgement };
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
