# Play Store Release

## One-time setup

1. Create a Google Play Developer account.
2. Create the app in Google Play Console using package name `com.orbita.messenger`.
3. Enroll the app in Play App Signing.
4. In Google Cloud/Play Console, create a service account with Play Console release permissions.
5. Download the service account JSON key locally. Do not commit it. This repo ignores common key names such as `play-store-service-account*.json`.
6. Connect the service account in Play Console under API access.
7. Deploy the Orbita backend (`backend/server.mjs`) to a public HTTPS host. The mobile app must not use `http://localhost:8787` in production.
8. Configure EAS production environment variables:

```bash
eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_URL --value "https://YOUR_PROJECT.supabase.co" --visibility plain
eas env:create --environment production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "YOUR_SUPABASE_ANON_KEY" --visibility plain
eas env:create --environment production --name EXPO_PUBLIC_ORBITA_API_URL --value "https://YOUR_ORBITA_BACKEND_URL" --visibility plain
eas env:create --environment production --name EXPO_PUBLIC_ENABLE_DEV_OTP --value "0" --visibility plain
```

Do not add `SUPABASE_SERVICE_ROLE_KEY` or other server secrets to Expo public environment variables.

## Build

```bash
npm run typecheck
npm run build:android:playstore
```

The production EAS profile builds an Android App Bundle (`.aab`) and auto-increments the Android version code.

## Submit

```bash
npm run submit:android:playstore
```

The submit profile targets the internal track as a draft. Promote the release from internal testing to closed/open/production inside Play Console after store listing, privacy, data safety, content rating, and target audience sections are complete.

## Store Listing Assets

- App name: `Orbita Messenger`
- Package: `com.orbita.messenger`
- Icon: `assets/icon.png`
- Feature graphic: create a 1024 x 500 image before production release.
- Screenshots: capture current Android phone screenshots for chat list, chat thread, task thread, contacts, and settings.

## Permission Notes

The Android config requests contacts, microphone, and notification permissions. The app uses contacts to discover chat contacts, microphone for voice notes, and notifications for chat alerts.
