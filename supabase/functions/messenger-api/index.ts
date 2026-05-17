import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient, User } from "https://esm.sh/@supabase/supabase-js@2";

type ApiRequest = {
  action: string;
  payload?: Record<string, unknown>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-orbita-signature",
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

function requiredString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

function optionalString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizePhone(phone: string, defaultCountryCode = "+91") {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  return `+${digits}`;
}

async function sha256(value: string) {
  const input = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index++) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

async function verifyIntegrationSignature(rawBody: string, signature: string | null, secret: string | undefined) {
  if (!signature || !secret) return false;
  const expected = `sha256=${await hmacSha256(rawBody, secret)}`;
  return timingSafeEqual(signature, expected);
}

function isDefaultDisplayName(name: unknown) {
  const normalized = typeof name === "string" ? name.trim().toLowerCase() : "";
  return !normalized || normalized === "you" || normalized === "orbita user";
}

function profileDisplayName(row: Record<string, unknown>, viewerId = "") {
  const rawName = typeof row.display_name === "string" ? row.display_name.trim() : "";
  if (!isDefaultDisplayName(rawName)) return rawName;
  if (viewerId && row.id === viewerId) return "You";
  return typeof row.phone === "string" && row.phone ? row.phone : "Orbita user";
}

function mapProfile(row: Record<string, unknown>, viewerId = "") {
  return {
    id: row.id,
    displayName: profileDisplayName(row, viewerId),
    phone: row.phone,
    avatarUrl: row.avatar_url,
    about: row.about,
    isOnline: row.is_online,
    lastSeenAt: row.last_seen_at,
  };
}

function messagePayload(row: Record<string, unknown>) {
  return typeof row.encrypted_payload === "object" && row.encrypted_payload ? row.encrypted_payload as Record<string, unknown> : {};
}

function messageBody(row: Record<string, unknown>) {
  const payload = messagePayload(row);
  return typeof payload.body === "string" ? payload.body : "";
}

function parseForwardedFrom(payload: Record<string, unknown>) {
  const forwarded = payload.forwardedFrom;
  if (!forwarded || typeof forwarded !== "object") return null;
  const record = forwarded as Record<string, unknown>;
  const messageId = typeof record.messageId === "string" ? record.messageId : "";
  const senderName = typeof record.senderName === "string" ? record.senderName : "";
  const conversationTitle = typeof record.conversationTitle === "string" ? record.conversationTitle : "";
  if (!messageId || !senderName || !conversationTitle) return null;
  return { messageId, senderName, conversationTitle };
}

function attachmentMetadata(row: Record<string, unknown>) {
  return typeof row.encrypted_metadata === "object" && row.encrypted_metadata ? row.encrypted_metadata as Record<string, unknown> : {};
}

function sanitizeFilename(name: string, fallback = "attachment") {
  const cleaned = String(name || fallback)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function messageKindFromAttachment(kind: unknown, mimeType = "") {
  const normalizedKind = typeof kind === "string" ? kind.toLowerCase() : "";
  if (normalizedKind === "voice" || normalizedKind === "audio") return normalizedKind;
  if (normalizedKind === "image") return "image";
  if (normalizedKind === "document") return "document";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "voice";
  return "document";
}

function storageBucketForMessageKind(kind: string) {
  return kind === "voice" || kind === "audio" ? "voice-notes" : "chat-media";
}

function mapAttachment(row: Record<string, unknown>, signedUrl: string) {
  const metadata = attachmentMetadata(row);
  const kind = messageKindFromAttachment(metadata.kind, String(row.mime_type ?? ""));
  return {
    id: row.id,
    kind,
    mimeType: row.mime_type,
    filename:
      typeof metadata.filename === "string" && metadata.filename.trim()
        ? metadata.filename.trim()
        : sanitizeFilename(String(row.object_path ?? "").split("/").pop() || kind, kind),
    sizeBytes: row.byte_size,
    durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : null,
    url: signedUrl,
  };
}

function mapMessage(row: Record<string, unknown>, attachments: Record<string, unknown>[] = []) {
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

async function signedAttachmentUrl(supabase: SupabaseClient, row: Record<string, unknown>, expiresIn = 60 * 60) {
  const { data, error } = await supabase.storage
    .from(String(row.bucket))
    .createSignedUrl(String(row.object_path), expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

async function loadAttachmentRowsForMessageIds(supabase: SupabaseClient, messageIds: string[]) {
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (!ids.length) return new Map<string, Record<string, unknown>[]>();

  const { data, error } = await supabase
    .from("media_attachments")
    .select("*")
    .in("message_id", ids)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = data ?? [];
  const signedUrls = await Promise.all(rows.map((row) => signedAttachmentUrl(supabase, row)));
  const byMessageId = new Map<string, Record<string, unknown>[]>();
  rows.forEach((row, index) => {
    const messageId = row.message_id as string | null;
    if (!messageId) return;
    const current = byMessageId.get(messageId) ?? [];
    current.push(mapAttachment(row, signedUrls[index]) as unknown as Record<string, unknown>);
    byMessageId.set(messageId, current);
  });
  return byMessageId;
}

async function getOwnedStagedAttachment(supabase: SupabaseClient, userId: string, attachmentId: string) {
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

async function linkAttachmentToMessage(supabase: SupabaseClient, attachmentRow: Record<string, unknown>, messageId: string) {
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
    .eq("id", String(attachmentRow.id))
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function cloneAttachmentForMessage(
  supabase: SupabaseClient,
  attachmentRow: Record<string, unknown>,
  ownerId: string,
  messageId: string,
) {
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

async function uploadMediaAttachment(supabase: SupabaseClient, userId: string, form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("file is required.");

  const requestedKind = String(form.get("kind") ?? "").trim();
  const durationMs = Number(form.get("durationMs") ?? 0);
  const filename = sanitizeFilename(String(form.get("filename") ?? file.name ?? requestedKind ?? "attachment"));
  const mimeType = file.type || "application/octet-stream";
  const kind = messageKindFromAttachment(requestedKind || undefined, mimeType);
  const bucket = storageBucketForMessageKind(kind);
  const objectPath = `${userId}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${filename}`;
  const body = await file.arrayBuffer();

  const { error: uploadError } = await supabase.storage.from(bucket).upload(objectPath, body, {
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
      byte_size: file.size,
      encrypted_metadata: {
        filename,
        durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
        kind,
        status: "staged",
      },
    })
    .select("*")
    .single();
  if (error) throw error;

  return { attachment: mapAttachment(data, await signedAttachmentUrl(supabase, data, 12 * 60 * 60)) };
}

async function insertMessageWithReceipts(
  supabase: SupabaseClient,
  conversationId: string,
  senderId: string,
  kind: string,
  payload: Record<string, unknown>,
) {
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

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  const { data: participants } = await supabase
    .from("conversation_participants")
    .select("user_id")
    .eq("conversation_id", conversationId)
    .neq("user_id", senderId);

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
      supabase,
      participants.map((participant) => participant.user_id),
      "message_created",
      conversationId,
      {
        messageId: message.id,
        senderId,
      },
    );
  }

  return message;
}

async function createRealtimeEvents(
  supabase: SupabaseClient,
  targetUserIds: string[],
  kind: string,
  conversationId: string | null,
  payload: Record<string, unknown> = {},
) {
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

async function ensureProfile(supabase: SupabaseClient, user: User) {
  const metadataPhone = typeof user.user_metadata?.phone === "string" ? user.user_metadata.phone : "";
  const phone = user.phone ? normalizePhone(user.phone) : metadataPhone ? normalizePhone(metadataPhone) : null;
  const phoneHash = phone ? await sha256(phone) : null;
  const displayNameFromAuth =
    typeof user.user_metadata?.display_name === "string" && user.user_metadata.display_name.trim()
      ? user.user_metadata.display_name.trim()
      : "Orbita user";

  const now = new Date().toISOString();

  const { data: existing, error: selectError } = await supabase
    .from("profiles")
    .select("id")
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
      throw new Error(
        "This phone number is already linked to another Orbita login. Use the original email for this phone, or remove the old profile before signing in with a new account.",
      );
    }
  }

  if (existing) {
    const { data, error } = await supabase
      .from("profiles")
      .update({
        phone,
        phone_hash: phoneHash,
        is_online: true,
        last_seen_at: now,
      })
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

async function getProfile(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (error) throw error;
  return data;
}

async function getConversation(supabase: SupabaseClient, userId: string, conversationId: string) {
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

async function isAdmin(supabase: SupabaseClient, userId: string, conversationId: string) {
  const { data, error } = await supabase
    .from("conversation_participants")
    .select("role")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.role === "owner" || data?.role === "admin";
}

async function loadContacts(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from("contacts")
    .select("contact_user_id, profiles!contacts_contact_user_id_fkey(*)")
    .eq("owner_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => mapProfile(row.profiles, userId));
}

async function loadMessages(supabase: SupabaseClient, userId: string, conversationId: string) {
  await getConversation(supabase, userId, conversationId);
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  const messages = [...(data ?? [])].reverse();
  const attachmentsByMessageId = await loadAttachmentRowsForMessageIds(supabase, messages.map((message) => String(message.id)));
  return messages.map((message) => mapMessage(message, attachmentsByMessageId.get(String(message.id)) ?? []));
}

async function unreadCountForConversation(supabase: SupabaseClient, userId: string, conversationId: string) {
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

async function markConversationRead(supabase: SupabaseClient, userId: string, conversationId: string) {
  await getConversation(supabase, userId, conversationId);

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

async function loadConversations(supabase: SupabaseClient, userId: string) {
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
        ? await loadAttachmentRowsForMessageIds(supabase, [String(lastMessageRow.id)])
        : new Map<string, Record<string, unknown>[]>();
      const mappedParticipants = (participants ?? []).map((row) => ({
        ...mapProfile(row.profiles, userId),
        role: row.role,
      }));
      const directPeer = mappedParticipants.find((profile) => profile.id !== userId);
      const lastMessage = lastMessageRow
        ? mapMessage(lastMessageRow, attachmentsByMessageId.get(String(lastMessageRow.id)) ?? [])
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
        unreadCount: await unreadCountForConversation(supabase, userId, conversation.id),
      };
    }),
  );

  const bestDirectByPeer = new Map<string, typeof loaded[number]>();
  return loaded.filter((conversation) => {
    if (conversation.kind !== "direct") return true;
    const peer = conversation.participants.find((participant) => participant.id !== userId);
    if (!peer) return true;
    const existing = bestDirectByPeer.get(String(peer.id));
    if (!existing) {
      bestDirectByPeer.set(String(peer.id), conversation);
      return true;
    }
    const conversationScore = (conversation.lastMessage ? 2 : 0) + (conversation.unreadCount > 0 ? 1 : 0);
    const existingScore = (existing.lastMessage ? 2 : 0) + (existing.unreadCount > 0 ? 1 : 0);
    if (
      conversationScore > existingScore ||
      (conversationScore === existingScore && Date.parse(String(conversation.updatedAt)) > Date.parse(String(existing.updatedAt)))
    ) {
      bestDirectByPeer.set(String(peer.id), conversation);
      return true;
    }
    return false;
  }).filter((conversation) => {
    if (conversation.kind !== "direct") return true;
    const peer = conversation.participants.find((participant) => participant.id !== userId);
    return !peer || bestDirectByPeer.get(String(peer.id))?.id === conversation.id;
  });
}

async function loadStatuses(supabase: SupabaseClient, userId: string) {
  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select("contact_user_id")
    .eq("owner_id", userId);

  if (contactsError) throw contactsError;

  const authorIds = [userId, ...((contacts ?? []).map((contact) => contact.contact_user_id))];
  if (!authorIds.length) return [];

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

async function createDirectConversation(supabase: SupabaseClient, userId: string, otherUserId: string) {
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
    const existing = (await loadConversations(supabase, userId)).find(
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

  await createRealtimeEvents(supabase, [otherUserId], "direct_conversation_created", conversation.id, {
    createdBy: userId,
  });

  const created = (await loadConversations(supabase, userId)).find((item) => item.id === conversation.id);
  if (!created) throw new Error("Unable to load created conversation.");
  return created;
}

async function loadConversationParticipants(supabase: SupabaseClient, conversationId: string) {
  const { data, error } = await supabase
    .from("conversation_participants")
    .select("role, profiles(*)")
    .eq("conversation_id", conversationId)
    .order("joined_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

function conversationTitleFromRows(
  conversation: Record<string, unknown>,
  participantRows: Record<string, unknown>[],
  viewerId: string,
) {
  const participants = participantRows.map((row) => ({
    ...mapProfile(row.profiles as Record<string, unknown>, viewerId),
    role: row.role,
  }));
  if (conversation.kind === "group") return String(conversation.title ?? "Group");
  return participants.find((participant) => participant.id !== viewerId)?.displayName ?? "Direct chat";
}

async function buildForwardedFrom(
  supabase: SupabaseClient,
  sourceMessage: Record<string, unknown>,
  forwardingUserId: string,
) {
  const payload = messagePayload(sourceMessage);
  const existing = parseForwardedFrom(payload);
  if (existing) return existing;

  const [sourceConversation, participantRows, senderRow] = await Promise.all([
    supabase.from("conversations").select("*").eq("id", sourceMessage.conversation_id).single(),
    loadConversationParticipants(supabase, String(sourceMessage.conversation_id)),
    supabase.from("profiles").select("*").eq("id", sourceMessage.sender_id).single(),
  ]);
  if (sourceConversation.error) throw sourceConversation.error;
  if (senderRow.error) throw senderRow.error;

  return {
    messageId: String(sourceMessage.id),
    senderName: profileDisplayName(senderRow.data as Record<string, unknown>, forwardingUserId),
    conversationTitle: conversationTitleFromRows(
      sourceConversation.data as Record<string, unknown>,
      participantRows as Record<string, unknown>[],
      forwardingUserId,
    ),
  };
}

async function ensureTaskmanagerAgentProfile(
  supabase: SupabaseClient,
  taskmanagerOrgId: string,
  displayName: string,
) {
  const { data: existingLink, error: linkError } = await supabase
    .from("taskmanager_agent_links")
    .select("agent_profile_id")
    .eq("taskmanager_org_id", taskmanagerOrgId)
    .limit(1)
    .maybeSingle();
  if (linkError) throw linkError;
  if (existingLink?.agent_profile_id) return existingLink.agent_profile_id as string;

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
    const existingAgent = await findAuthUserByEmail(supabase, email);
    if (!existingAgent) {
      throw createError ?? new Error("Unable to create Orbita agent user.");
    }
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

async function findAuthUserByEmail(supabase: SupabaseClient, email: string) {
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
  supabase: SupabaseClient,
  conversationId: string,
  senderId: string,
  message: Record<string, unknown>,
  attachments: Record<string, unknown>[] = [],
): Promise<{ forwarded: boolean; reason?: string }> {
  const webhookUrl = Deno.env.get("TASK_MANAGER_ORBITA_WEBHOOK_URL");
  const secret = Deno.env.get("TASK_MANAGER_ORBITA_SECRET");
  if (!webhookUrl || !secret) {
    return { forwarded: false, reason: "TASK_MANAGER_ORBITA_WEBHOOK_URL or TASK_MANAGER_ORBITA_SECRET is not set." };
  }

  const { data: link, error } = await supabase
    .from("taskmanager_agent_links")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  if (!link) return { forwarded: false, reason: "Conversation is not linked to Task Manager." };
  if (link.agent_profile_id === senderId) return { forwarded: false, reason: "Sender is the Task Manager agent." };

  const raw = JSON.stringify({
    taskmanagerOrgId: link.taskmanager_org_id,
    taskmanagerUserId: link.taskmanager_user_id,
    conversationId,
    orbitaUserId: senderId,
    messageId: message.id,
    kind: message.kind,
    text: message.body || undefined,
    attachment: attachments[0] ?? null,
    attachments,
    sentAt: message.createdAt ?? new Date().toISOString(),
  });

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-orbita-signature": `sha256=${await hmacSha256(raw, secret)}`,
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

async function handleServiceAction(
  supabase: SupabaseClient,
  action: string,
  payload: Record<string, unknown>,
) {
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

    const { data: existing, error: existingError } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_user_id", taskmanagerUserId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing?.enabled) {
      return {
        orbitaProfileId: existing.orbita_user_id,
        conversationId: existing.conversation_id,
      };
    }

    const agentProfileId = await ensureTaskmanagerAgentProfile(supabase, taskmanagerOrgId, agentDisplayName);
    const conversation = await createDirectConversation(supabase, agentProfileId, orbitaProfile.id as string);

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
    };
  }

  if (action === "send_agent_message") {
    const taskmanagerOrgId = requiredString(payload, "taskmanagerOrgId");
    const taskmanagerUserId = requiredString(payload, "taskmanagerUserId");
    const conversationId = requiredString(payload, "conversationId");
    const body = requiredString(payload, "body").slice(0, 5000);

    const { data: link, error } = await supabase
      .from("taskmanager_agent_links")
      .select("*")
      .eq("taskmanager_org_id", taskmanagerOrgId)
      .eq("taskmanager_user_id", taskmanagerUserId)
      .eq("conversation_id", conversationId)
      .eq("enabled", true)
      .single();
    if (error) throw error;

    const message = await insertMessageWithReceipts(
      supabase,
      conversationId,
      link.agent_profile_id as string,
      "text",
      { body },
    );
    return { message: mapMessage(message, []) };
  }

  throw new Error(`Unknown service action: ${action}`);
}

async function handleAction(supabase: SupabaseClient, user: User, action: string, payload: Record<string, unknown>) {
  await ensureProfile(supabase, user);

  if (action === "bootstrap") {
    return {
      profile: mapProfile(await getProfile(supabase, user.id), user.id),
      contacts: await loadContacts(supabase, user.id),
      conversations: await loadConversations(supabase, user.id),
      statuses: await loadStatuses(supabase, user.id),
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

    const users = new Map<string, Record<string, unknown>>();
    [...(byPhone ?? []), ...(byName ?? [])].forEach((profile) => users.set(profile.id, profile));
    return { users: [...users.values()].map(mapProfile) };
  }

  if (action === "add_contact_by_phone") {
    const phone = normalizePhone(requiredString(payload, "phone"));
    const { data: contact, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("phone", phone)
      .neq("id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!contact) throw new Error("No Orbita user found for that phone number.");
    const { error: insertError } = await supabase
      .from("contacts")
      .upsert({ owner_id: user.id, contact_user_id: contact.id }, { onConflict: "owner_id,contact_user_id" });
    if (insertError) throw insertError;
    return { contact: mapProfile(contact, user.id) };
  }

  if (action === "create_direct_conversation") {
    const otherUserId = requiredString(payload, "otherUserId");
    const conversation = await createDirectConversation(supabase, user.id, otherUserId);
    return { conversation };
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
        invite_code: crypto.randomUUID().slice(0, 8).toUpperCase(),
      })
      .select()
      .single();
    if (error) throw error;

    const participants = [
      { conversation_id: conversation.id, user_id: user.id, role: "owner" },
      ...memberIds.map((memberId) => ({
        conversation_id: conversation.id,
        user_id: memberId,
        role: "member",
      })),
    ];
    const { error: participantError } = await supabase.from("conversation_participants").insert(participants);
    if (participantError) throw participantError;

    await createRealtimeEvents(supabase, memberIds, "group_created", conversation.id, {
      title,
      createdBy: user.id,
    });

    const created = (await loadConversations(supabase, user.id)).find((item) => item.id === conversation.id);
    if (!created) throw new Error("Unable to load created group.");
    return { conversation: created };
  }

  if (action === "add_group_members") {
    const conversationId = requiredString(payload, "conversationId");
    const memberIds = [...new Set(stringArray(payload, "memberIds").filter((id) => id !== user.id))];
    const conversation = await getConversation(supabase, user.id, conversationId);
    if (conversation.kind !== "group") throw new Error("Members can only be added to groups.");
    if (!(await isAdmin(supabase, user.id, conversationId))) throw new Error("Only group admins can add members.");
    const { error } = await supabase.from("conversation_participants").upsert(
      memberIds.map((memberId) => ({
        conversation_id: conversationId,
        user_id: memberId,
        role: "member",
      })),
      { onConflict: "conversation_id,user_id" },
    );
    if (error) throw error;

    await createRealtimeEvents(supabase, memberIds, "group_member_added", conversationId, {
      addedBy: user.id,
    });

    const updated = (await loadConversations(supabase, user.id)).find((item) => item.id === conversationId);
    if (!updated) throw new Error("Unable to load updated group.");
    return { conversation: updated };
  }

  if (action === "list_messages") {
    return { messages: await loadMessages(supabase, user.id, requiredString(payload, "conversationId")) };
  }

  if (action === "mark_conversation_read") {
    await markConversationRead(supabase, user.id, requiredString(payload, "conversationId"));
    return { ok: true };
  }

  if (action === "send_message") {
    const conversationId = requiredString(payload, "conversationId");
    const body = optionalString(payload, "body").slice(0, 5000);
    const attachmentId = optionalString(payload, "attachmentId");
    await getConversation(supabase, user.id, conversationId);
    const attachmentRow = attachmentId ? await getOwnedStagedAttachment(supabase, user.id, attachmentId) : null;
    const kind = attachmentRow
      ? messageKindFromAttachment(attachmentMetadata(attachmentRow).kind, String(attachmentRow.mime_type ?? ""))
      : (optionalString(payload, "kind") || "text");
    if (!body && !attachmentRow) throw new Error("Message body or attachment is required.");

    const message = await insertMessageWithReceipts(supabase, conversationId, user.id, kind, { body });
    if (attachmentRow) {
      await linkAttachmentToMessage(supabase, attachmentRow, String(message.id));
    }
    const attachments = attachmentRow
      ? (await loadAttachmentRowsForMessageIds(supabase, [String(message.id)])).get(String(message.id)) ?? []
      : [];
    const mappedMessage = mapMessage(message, attachments);
    const taskManagerForward = await forwardTaskmanagerInbound(
      supabase,
      conversationId,
      user.id,
      mappedMessage as unknown as Record<string, unknown>,
      attachments,
    ).catch((error) => {
      const reason = errorMessage(error);
      console.error(reason, error);
      return { forwarded: false, reason };
    });

    return { message: mappedMessage, taskManagerForward };
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
    await getConversation(supabase, user.id, String(sourceMessage.conversation_id));

    const forwardedFrom = await buildForwardedFrom(supabase, sourceMessage, user.id);
    const { data: sourceAttachmentRows, error: attachmentError } = await supabase
      .from("media_attachments")
      .select("*")
      .eq("message_id", sourceMessage.id)
      .order("created_at", { ascending: true });
    if (attachmentError) throw attachmentError;

    const forwardedMessages = [];
    for (const destinationConversationId of destinationConversationIds) {
      await getConversation(supabase, user.id, destinationConversationId);
      const forwardedRow = await insertMessageWithReceipts(
        supabase,
        destinationConversationId,
        user.id,
        String(sourceMessage.kind),
        { body: messageBody(sourceMessage), forwardedFrom },
      );

      for (const sourceAttachmentRow of sourceAttachmentRows ?? []) {
        await cloneAttachmentForMessage(supabase, sourceAttachmentRow, user.id, String(forwardedRow.id));
      }

      const attachments = (await loadAttachmentRowsForMessageIds(supabase, [String(forwardedRow.id)])).get(String(forwardedRow.id)) ?? [];
      const mappedMessage = mapMessage(forwardedRow, attachments);
      forwardedMessages.push(mappedMessage);
      void forwardTaskmanagerInbound(
        supabase,
        destinationConversationId,
        user.id,
        mappedMessage as unknown as Record<string, unknown>,
        attachments,
      ).catch((error) => console.error(errorMessage(error), error));
    }

    return { messages: forwardedMessages };
  }

  if (action === "create_status") {
    const text = requiredString(payload, "text").slice(0, 700);
    const visibility = (optionalString(payload, "visibility") || "contacts") as string;
    const { data, error } = await supabase
      .from("status_posts")
      .insert({
        author_id: user.id,
        kind: "text",
        encrypted_payload: { text },
        visibility,
      })
      .select("*, profiles!status_posts_author_id_fkey(*), status_views(viewer_id)")
      .single();
    if (error) throw error;
    const created = (await loadStatuses(supabase, user.id)).find((status) => status.id === data.id);
    if (!created) throw new Error("Unable to load created status.");
    return { status: created };
  }

  if (action === "list_statuses") {
    return { statuses: await loadStatuses(supabase, user.id) };
  }

  throw new Error(`Unknown action: ${action}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: "Missing Supabase function environment." }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const pathname = new URL(req.url).pathname;

    if (pathname.endsWith("/media")) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) return json({ error: "Missing authorization." }, 401);
      const jwt = authHeader.replace("Bearer ", "");
      const { data, error } = await supabase.auth.getUser(jwt);
      if (error || !data.user) return json({ error: "Invalid session." }, 401);
      const form = await req.formData();
      return json(await uploadMediaAttachment(supabase, data.user.id, form));
    }

    const rawBody = await req.text();
    const body = JSON.parse(rawBody) as ApiRequest;
    const serviceActions = new Set(["link_taskmanager_user", "send_agent_message"]);

    if (serviceActions.has(body.action)) {
      const validSignature = await verifyIntegrationSignature(
        rawBody,
        req.headers.get("x-orbita-signature"),
        Deno.env.get("TASK_MANAGER_ORBITA_SECRET"),
      );
      if (!validSignature) return json({ error: "Invalid Orbita integration signature." }, 401);
      const result = await handleServiceAction(supabase, body.action, body.payload ?? {});
      return json(result);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization." }, 401);

    const jwt = authHeader.replace("Bearer ", "");
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data.user) return json({ error: "Invalid session." }, 401);
    const result = await handleAction(supabase, data.user, body.action, body.payload ?? {});
    return json(result);
  } catch (error) {
    const message = errorMessage(error);
    console.error(message, error);
    return json({ error: message }, 400);
  }
});

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.error_description ?? record.details ?? record.hint;
    if (typeof message === "string" && message.trim()) return message;
    try {
      return JSON.stringify(record);
    } catch {
      return "Unexpected server error.";
    }
  }
  return "Unexpected server error.";
}
