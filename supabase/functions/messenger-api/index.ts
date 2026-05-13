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

function mapProfile(row: Record<string, unknown>) {
  return {
    id: row.id,
    displayName: row.display_name,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    about: row.about,
    isOnline: row.is_online,
    lastSeenAt: row.last_seen_at,
  };
}

function messageBody(row: Record<string, unknown>) {
  const payload = row.encrypted_payload as Record<string, unknown> | null;
  return typeof payload?.body === "string" ? payload.body : "";
}

function mapMessage(row: Record<string, unknown>) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: messageBody(row),
    createdAt: row.created_at,
    status: "sent",
  };
}

async function insertMessageWithReceipts(
  supabase: SupabaseClient,
  conversationId: string,
  senderId: string,
  kind: string,
  body: string,
) {
  const { data: message, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      kind,
      encrypted_payload: { body },
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
      : "You";

  const now = new Date().toISOString();

  const { data: existing, error: selectError } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (selectError) throw selectError;

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
  return (data ?? []).map((row) => mapProfile(row.profiles));
}

async function loadMessages(supabase: SupabaseClient, userId: string, conversationId: string) {
  await getConversation(supabase, userId, conversationId);
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) throw error;
  return (data ?? []).map(mapMessage);
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

  return Promise.all(
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

      const mappedParticipants = (participants ?? []).map((row) => ({
        ...mapProfile(row.profiles),
        role: row.role,
      }));
      const directPeer = mappedParticipants.find((profile) => profile.id !== userId);

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
        lastMessage: lastMessages?.[0] ? mapMessage(lastMessages[0]) : null,
        unreadCount: await unreadCountForConversation(supabase, userId, conversation.id),
      };
    }),
  );
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
      author: mapProfile(row.profiles),
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

  for (const row of shared ?? []) {
    if (row.conversations?.kind !== "direct") continue;
    const { data: peer } = await supabase
      .from("conversation_participants")
      .select("conversation_id")
      .eq("conversation_id", row.conversation_id)
      .eq("user_id", otherUserId)
      .maybeSingle();
    if (peer) {
      const existing = (await loadConversations(supabase, userId)).find((conversation) => conversation.id === peer.conversation_id);
      if (!existing) throw new Error("Unable to load existing conversation.");
      return existing;
    }
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
  if (createError || !created.user) {
    throw createError ?? new Error("Unable to create Orbita agent user.");
  }

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: created.user.id,
    display_name: displayName,
    about: "Task Manager agent",
    is_online: true,
    last_seen_at: new Date().toISOString(),
  });
  if (profileError) throw profileError;

  return created.user.id;
}

async function forwardTaskmanagerInbound(
  supabase: SupabaseClient,
  conversationId: string,
  senderId: string,
  messageId: string,
  body: string,
) {
  const webhookUrl = Deno.env.get("TASK_MANAGER_ORBITA_WEBHOOK_URL");
  const secret = Deno.env.get("TASK_MANAGER_ORBITA_SECRET");
  if (!webhookUrl || !secret) return;

  const { data: link, error } = await supabase
    .from("taskmanager_agent_links")
    .select("*")
    .eq("conversation_id", conversationId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  if (!link || link.agent_profile_id === senderId) return;

  const raw = JSON.stringify({
    taskmanagerOrgId: link.taskmanager_org_id,
    taskmanagerUserId: link.taskmanager_user_id,
    conversationId,
    orbitaUserId: senderId,
    messageId,
    text: body,
    sentAt: new Date().toISOString(),
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
    console.error(`Task Manager Orbita webhook failed: ${response.status} ${text}`);
  }
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
      body,
    );
    return { message: mapMessage(message) };
  }

  throw new Error(`Unknown service action: ${action}`);
}

async function handleAction(supabase: SupabaseClient, user: User, action: string, payload: Record<string, unknown>) {
  await ensureProfile(supabase, user);

  if (action === "bootstrap") {
    return {
      profile: mapProfile(await getProfile(supabase, user.id)),
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
    return { profile: mapProfile(data) };
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
    return { contact: mapProfile(contact) };
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
    const body = requiredString(payload, "body").slice(0, 5000);
    const kind = (optionalString(payload, "kind") || "text") as string;
    await getConversation(supabase, user.id, conversationId);

    const message = await insertMessageWithReceipts(supabase, conversationId, user.id, kind, body);
    await forwardTaskmanagerInbound(supabase, conversationId, user.id, message.id as string, body).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
    });

    return { message: mapMessage(message) };
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
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return json({ error: message }, 400);
  }
});
