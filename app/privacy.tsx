import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radii, shadow } from "@/theme/colors";

const updatedAt = "June 23, 2026";
const contactEmail = "adarsh@tshaped.in";

const sections = [
  {
    title: "Information we collect",
    body:
      "Orbita Messenger collects the phone number you use for OTP sign-in, your display name, profile details you choose to add, contacts you choose to sync, messages, task-thread content, attachments, voice notes, device push tokens, and basic technical logs needed to keep the service secure and reliable.",
  },
  {
    title: "How we use information",
    body:
      "We use this information to create and secure your account, deliver messages and notifications, sync contacts, show task conversations, process media and voice notes, connect Orbita with Task Manager agents, prevent abuse, troubleshoot errors, and improve the reliability of the app.",
  },
  {
    title: "Contacts",
    body:
      "If you grant contacts permission, Orbita reads phone numbers from your device contacts to help you find people who already use Orbita. We do not sell your contacts. You can deny or revoke contacts permission in your device settings.",
  },
  {
    title: "Voice notes and media",
    body:
      "When you record a voice note or upload a photo, document, audio file, or other attachment, the file is uploaded so it can be delivered to the people in that conversation or task thread. Microphone and media access are only used when you choose those features.",
  },
  {
    title: "Task Manager and AI agent conversations",
    body:
      "If your organization links Task Manager with Orbita, messages in agent chats and task threads may be processed by the organization's Task Manager systems and AI agent features so tasks can be created, updated, assigned, and discussed with the right participants.",
  },
  {
    title: "Sharing and service providers",
    body:
      "We share data only as needed to provide Orbita, including with infrastructure providers such as Supabase, Railway, Expo push notification services, and organization systems connected to Task Manager. We do not sell personal information.",
  },
  {
    title: "Security and retention",
    body:
      "We use access controls, authenticated APIs, storage protections, and transport encryption to protect data in transit and at rest. We keep information for as long as needed to provide the service, comply with legal obligations, resolve disputes, and maintain security.",
  },
  {
    title: "Your choices",
    body:
      "You can update your profile, sign out, revoke device permissions, stop syncing contacts, and request account or data deletion by contacting us. Some organization-managed data may also be controlled by your organization administrator.",
  },
  {
    title: "Children",
    body:
      "Orbita Messenger is intended for workplace and organization communication. It is not directed to children, and we do not knowingly collect personal information from children.",
  },
  {
    title: "Changes to this policy",
    body:
      "We may update this Privacy Policy as Orbita changes. When we make material changes, we will update the effective date and provide notice where appropriate.",
  },
];

export default function PrivacyPolicyScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.shell}>
          <View style={styles.header}>
            <View style={styles.brandRow}>
              <Image source={require("../assets/icon.png")} style={styles.logo} />
              <View>
                <Text style={styles.brandTitle}>Orbita Messenger</Text>
                <Text style={styles.brandSub}>AI-native messaging</Text>
              </View>
            </View>
            <Link href="/" asChild>
              <Pressable style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
                <Ionicons color={colors.primaryDark} name="arrow-back" size={18} />
                <Text style={styles.backText}>Back to app</Text>
              </Pressable>
            </Link>
          </View>

          <View style={styles.hero}>
            <Text style={styles.kicker}>Privacy Policy</Text>
            <Text style={styles.title}>How Orbita handles your data</Text>
            <Text style={styles.copy}>
              This Privacy Policy explains what information Orbita Messenger collects, how it is used, and the choices
              available to you.
            </Text>
            <Text style={styles.updated}>Last updated: {updatedAt}</Text>
          </View>

          <View style={styles.card}>
            {sections.map((section) => (
              <View key={section.title} style={styles.section}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionBody}>{section.body}</Text>
              </View>
            ))}

            <View style={styles.contactBox}>
              <Ionicons color={colors.primaryDark} name="mail-outline" size={20} />
              <View style={styles.contactText}>
                <Text style={styles.sectionTitle}>Contact us</Text>
                <Text style={styles.sectionBody}>
                  For privacy questions or data requests, contact us at {contactEmail}.
                </Text>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F0F2F5" },
  scroll: { flexGrow: 1, padding: 18 },
  shell: { width: "100%", maxWidth: 920, alignSelf: "center", gap: 18 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    paddingVertical: 8,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12, minWidth: 0 },
  logo: { width: 44, height: 44, borderRadius: 12 },
  brandTitle: { color: colors.ink, fontSize: 20, fontWeight: "900" },
  brandSub: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  backButton: {
    minHeight: 40,
    borderRadius: radii.pill,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  pressed: { opacity: 0.78 },
  backText: { color: colors.primaryDark, fontSize: 13, fontWeight: "800" },
  hero: {
    borderRadius: 18,
    padding: 22,
    backgroundColor: "#E7FCE3",
    borderWidth: 1,
    borderColor: "rgba(0,128,105,0.16)",
  },
  kicker: { color: colors.primaryDark, fontSize: 12, fontWeight: "900", textTransform: "uppercase" },
  title: { marginTop: 8, color: colors.ink, fontSize: 34, lineHeight: 39, fontWeight: "900" },
  copy: { marginTop: 10, maxWidth: 680, color: colors.muted, fontSize: 16, lineHeight: 24, fontWeight: "600" },
  updated: { marginTop: 16, color: colors.primaryDark, fontSize: 13, fontWeight: "800" },
  card: {
    borderRadius: 18,
    padding: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 18,
    ...shadow,
  },
  section: { gap: 7 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: "900" },
  sectionBody: { color: colors.muted, fontSize: 14, lineHeight: 22, fontWeight: "600" },
  contactBox: {
    marginTop: 4,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    gap: 12,
    backgroundColor: colors.surfaceBlue,
    borderWidth: 1,
    borderColor: colors.line,
  },
  contactText: { flex: 1, minWidth: 0 },
});
