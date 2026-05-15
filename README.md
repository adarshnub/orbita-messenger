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

Apply the Supabase migrations before using the app:

```bash
supabase db push
```

Realtime messaging is event-driven through Supabase Realtime. The app subscribes to the current user's membership/receipt rows, targeted `realtime_events`, and each active conversation's message/participant stream, then refreshes through the standalone backend; it does not poll. The `002_realtime_events.sql` migration is required for instant group-add and message notifications.
