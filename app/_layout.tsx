import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LogBox } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

LogBox.ignoreLogs([
  "ProgressBarAndroid has been extracted from react-native core",
  "SafeAreaView has been deprecated and will be removed in a future release",
  "Clipboard has been extracted from react-native core",
  "PushNotificationIOS has been extracted from react-native core",
]);

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar backgroundColor="#F0EFF4" style="dark" translucent={false} />
    </SafeAreaProvider>
  );
}
