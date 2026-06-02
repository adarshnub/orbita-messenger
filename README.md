# Orbita Messenger

Orbita Messenger is an Expo React Native app for Android, iOS, and web with a WhatsApp-like messaging model, original branding, and a light blue theme.

## Stack

- Expo + Expo Router + TypeScript
- React Native Web for browser support
- Supabase Auth, Postgres, Realtime, Storage, and RLS
- Required standalone Node backend for messenger and Task Manager integration APIs
- `npm` for package management

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and add Supabase credentials.

3. Start the app:

   ```bash
   npm run web
   ```

4. Start the standalone backend in a second terminal:

   ```bash
   npm run backend
   ```

The app includes local sample data so the UI works before Supabase is connected.

## Backend

The initial schema and RLS policies live in `supabase/migrations/001_initial_schema.sql`.
Orbita uses the standalone Node backend in `backend/server.mjs` for messenger and Task Manager integration APIs. Set `EXPO_PUBLIC_ORBITA_API_URL=http://localhost:8787` and run `npm run backend`. The backend verifies Supabase JWTs and uses Supabase as Auth/Postgres/Realtime.

The frontend only calls `EXPO_PUBLIC_ORBITA_API_URL`. If that value is missing, API calls fail fast instead of trying another backend path.

Frontend `.env` values:

```bash
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
EXPO_PUBLIC_ORBITA_API_URL=http://localhost:8787
```

The standalone backend needs server-side secrets:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TASK_MANAGER_ORBITA_WEBHOOK_URL=
TASK_MANAGER_ORBITA_SECRET=
```

## Task Manager integration

Orbita Messenger integrates with the Task Manager app in the same overall shape as the Meta WhatsApp integration:

- Task Manager sends outbound agent messages into Orbita through a signed server-to-server API call.
- Orbita forwards inbound employee replies from the agent conversation back into Task Manager through a signed webhook.
- Task Manager stores the resolved Orbita channel mapping on the employee record, similar to how it stores a WhatsApp channel mapping.

The key difference is transport:

- Meta WhatsApp uses Meta's webhook + WhatsApp delivery APIs.
- Orbita uses the standalone Orbita backend as the transport layer, with Supabase handling identity, conversations, realtime delivery, and push.

### Flow

1. Task Manager links an employee to Orbita by calling Orbita backend `POST /api/service` with action `link_taskmanager_user`.
2. Orbita normalizes the phone number, finds the matching Supabase `profiles` row, creates or reuses a direct conversation with the Task Manager agent, and stores the canonical mapping in `taskmanager_agent_links`.
3. Orbita returns `orbitaProfileId` and `conversationId`.
4. Task Manager saves those values into `users.channels.orbita.profile_id` and `users.channels.orbita.conversation_id`.
5. When Task Manager wants to send a task/agent message, it again calls Orbita backend `POST /api/service` with action `send_agent_message`.
6. When the employee replies inside Orbita, Orbita backend posts that inbound message to Task Manager using `TASK_MANAGER_ORBITA_WEBHOOK_URL`.

### Direction of calls

Task Manager -> Orbita:

- `link_taskmanager_user`
- `send_agent_message`

Orbita -> Task Manager:

- webhook POST for inbound agent-thread replies and relayed message metadata

### Signing

Both directions use the same shared-secret HMAC model as the Meta/WhatsApp integration layer:

- Task Manager signs requests to Orbita with header `x-orbita-signature`.
- Orbita verifies that signature on `/api/service`.
- Orbita signs webhook payloads back to Task Manager using the same shared secret.
- Task Manager verifies the webhook signature before accepting the message.

The secret used on both sides is:

```bash
TASK_MANAGER_ORBITA_SECRET=
```

Task Manager refers to the same shared secret as:

```bash
ORBITA_INTEGRATION_SECRET=
```

These values must match across both projects.

### Orbita backend routes

The standalone backend in `backend/server.mjs` exposes three route groups:

- `/api/messenger` and `/api/messenger-api`
  Authenticated app API used by the Orbita client.
- `/api/messenger/media` and `/api/messenger-api/media`
  Authenticated media upload endpoints.
- `/api/service`
  Signed server-to-server integration endpoint used by Task Manager.

### Required environment variables

Orbita Messenger backend:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TASK_MANAGER_ORBITA_WEBHOOK_URL=
TASK_MANAGER_ORBITA_SECRET=
```

Task Manager API:

```bash
ORBITA_MESSENGER_API_URL=http://localhost:8787/api/service
ORBITA_INTEGRATION_SECRET=
```

For local development, `ORBITA_MESSENGER_API_URL` can point to local Orbita backend. For deployed Task Manager environments, it should point to the deployed Orbita backend service URL.

### Data model

Orbita side:

- `profiles`
  Canonical Orbita user identity resolved by normalized phone number.
- `conversations`
  Direct chat between employee and Task Manager agent.
- `taskmanager_agent_links`
  Source of truth for `taskmanager_org_id`, `taskmanager_user_id`, `orbita_user_id`, `agent_profile_id`, and `conversation_id`.

Task Manager side:

- `users.channels.orbita.profile_id`
- `users.channels.orbita.conversation_id`
- `users.agent_channel = "orbita"`

### Notes

- The Orbita backend contains self-healing logic for common remove/re-add employee cases. If the employee is re-added with the same phone, Orbita can rebind the Task Manager link to the current Orbita profile/conversation instead of creating silent drift.
- If `users.channels.orbita` in Task Manager and `taskmanager_agent_links` in Orbita drift apart, agent chat delivery and open-agent-chat UX will break even though the Orbita account itself still exists.

Apply the Supabase migrations before using the app:

```bash
supabase db push
```

Realtime messaging is event-driven through Supabase Realtime. The app subscribes to the current user's membership/receipt rows, targeted `realtime_events`, and each active conversation's message/participant stream, then refreshes through the standalone backend; it does not poll. The `002_realtime_events.sql` migration is required for instant group-add and message notifications.
