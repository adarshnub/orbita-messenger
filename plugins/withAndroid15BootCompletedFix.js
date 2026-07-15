const { withAndroidManifest } = require("expo/config-plugins");

const NOTIFICATIONS_SERVICE =
  "expo.modules.notifications.service.NotificationsService";

module.exports = function withAndroid15BootCompletedFix(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];

    if (!application) {
      return config;
    }

    manifest.$ = {
      ...manifest.$,
      "xmlns:tools": "http://schemas.android.com/tools",
    };

    application.receiver = (application.receiver ?? []).filter(
      (receiver) => receiver.$?.["android:name"] !== NOTIFICATIONS_SERVICE,
    );
    application.receiver.push({
      $: {
        "android:name": NOTIFICATIONS_SERVICE,
        "android:enabled": "true",
        "android:exported": "false",
        "tools:node": "replace",
      },
      "intent-filter": [
        {
          $: { "android:priority": "-1" },
          action: [
            {
              $: {
                "android:name":
                  "expo.modules.notifications.NOTIFICATION_EVENT",
              },
            },
            {
              $: { "android:name": "android.intent.action.MY_PACKAGE_REPLACED" },
            },
          ],
        },
      ],
    });

    return config;
  });
};
