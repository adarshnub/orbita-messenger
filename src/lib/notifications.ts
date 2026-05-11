import * as Notifications from "expo-notifications";

export async function registerForPushNotifications() {
  const current = await Notifications.getPermissionsAsync();
  const finalStatus =
    current.status === "granted" ? current : await Notifications.requestPermissionsAsync();

  if (finalStatus.status !== "granted") {
    return null;
  }

  return Notifications.getExpoPushTokenAsync();
}
