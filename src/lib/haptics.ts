import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

async function runHaptic(effect: () => Promise<void>) {
  if (Platform.OS === "web") return;
  try {
    await effect();
  } catch {
    // Haptics are optional and unavailable on some devices/simulators.
  }
}

export function hapticMessageSent() {
  return runHaptic(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

export function hapticMessageReceived() {
  return runHaptic(() => Haptics.selectionAsync());
}
