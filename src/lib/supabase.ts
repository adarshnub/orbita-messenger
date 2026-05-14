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

export async function signInWithEmail(email: string, phone: string) {
  if (!supabase) {
    return { error: new Error("Supabase is not configured. Add .env credentials first.") };
  }

  return supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      data: {
        phone,
      },
    },
  });
}

export async function verifyEmailOtp(email: string, token: string, phone?: string) {
  if (!supabase) {
    return { error: new Error("Supabase is not configured. Add .env credentials first.") };
  }

  const result = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (!result.error && phone) {
    await supabase.auth.updateUser({
      data: {
        phone,
      },
    });
  }
  return result;
}

export async function signInWithDevOtpBypass(email: string, phone: string) {
  if (!supabase) {
    return { error: new Error("Supabase is not configured. Add .env credentials first.") };
  }

  return supabase.auth.signInAnonymously({
    options: {
      data: {
        email,
        phone,
      },
    },
  });
}
