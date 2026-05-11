# Orbita Messenger

Orbita Messenger is an Expo React Native app for Android, iOS, and web with a WhatsApp-like messaging model, original branding, and a light blue theme.

## Stack

- Expo + Expo Router + TypeScript
- React Native Web for browser support
- Supabase Auth, Postgres, Realtime, Storage, Edge Functions, and RLS
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

The app includes local sample data so the UI works before Supabase is connected.

## Supabase

The initial schema and RLS policies live in `supabase/migrations/001_initial_schema.sql`.
The app backend is exposed through Supabase Edge Functions:

- `supabase/functions/messenger-api/index.ts` handles profile bootstrap/settings, contacts, 1:1 chats, groups, member adds, messages, and statuses.
- `supabase/functions/match-contacts/index.ts` is available for hashed bulk contact matching.

Frontend `.env` values:

```bash
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_ANON_KEY=
```

Supabase Edge Functions also need the standard Supabase runtime secrets, which are automatically present when deployed from a Supabase project:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Apply the migration and deploy the functions before using the app:

```bash
supabase db push
supabase functions deploy messenger-api
supabase functions deploy match-contacts
```
