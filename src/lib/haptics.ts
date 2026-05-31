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

export function hapticMessageSent() {
  runVibration(12);
  void playInAppCueSound("message_sent");
  return runHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

export function hapticMessageReceived() {
  runVibration([0, 18, 26, 18]);
  void playInAppCueSound("message_received");
  return runHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}
