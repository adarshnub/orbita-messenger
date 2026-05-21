import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
      realtime: {
        params: {
          eventsPerSecond: 12,
        },
      },
    })
  : null;

export async function signInWithPhone(
  phone: string,
  options: { displayName?: string; shouldCreateUser?: boolean } = {},
) {
  if (!supabase) {
    return { error: new Error("Supabase is not configured. Add .env credentials first.") };
  }

  return supabase.auth.signInWithOtp({
    phone,
    options: {
      shouldCreateUser: options.shouldCreateUser ?? true,
      data: {
        display_name: options.displayName,
      },
    },
  });
}

export async function verifyPhoneOtp(phone: string, token: string, displayName?: string) {
  if (!supabase) {
    return { error: new Error("Supabase is not configured. Add .env credentials first.") };
  }

  const result = await supabase.auth.verifyOtp({ phone, token, type: "sms" });
  if (!result.error && displayName) {
    await supabase.auth.updateUser({
      data: {
        display_name: displayName,
      },
    });
  }
  return result;
}

export async function signInWithDevOtpBypass(phone: string, displayName?: string) {
  if (!supabase) {
    return { error: new Error("Supabase is not configured. Add .env credentials first.") };
  }

  return supabase.auth.signInAnonymously({
    options: {
      data: {
        display_name: displayName,
        phone,
      },
    },
  });
}
