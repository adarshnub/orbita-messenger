import * as Haptics from "expo-haptics";
import { Platform, Vibration } from "react-native";
import { playInAppCueSound } from "./notifications";

async function runHaptic(effect: () => Promise<void>) {
  if (Platform.OS === "web") return;
  try {
    await effect();
  } catch {
    // Haptics are optional and unavailable on some devices/simulators.
  }
}

function runVibration(pattern: number | number[]) {
  if (Platform.OS === "web") return;
  try {
    Vibration.vibrate(pattern);
  } catch {
    // Vibration is optional and may be disabled by the device.
  }
}

async function runAndroidHaptic(type: Haptics.AndroidHaptics) {
  if (Platform.OS !== "android") return;
  try {
    await Haptics.performAndroidHapticsAsync(type);
  } catch {
    // Fallbacks handle devices that don't support Android haptic primitives.
  }
}

export function hapticMessageSent() {
  runVibration([0, 22]);
  void playInAppCueSound("message_sent");
  if (Platform.OS === "android") {
    void runAndroidHaptic(Haptics.AndroidHaptics.Confirm);
  }
  return runHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

export function hapticMessageReceived() {
  runVibration([0, 44, 38, 44]);
  void playInAppCueSound("message_received");
  if (Platform.OS === "android") {
    void runAndroidHaptic(Haptics.AndroidHaptics.Context_Click);
  }
  return runHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}
