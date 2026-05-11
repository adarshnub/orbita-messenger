export function normalizePhone(phone: string, defaultCountryCode = "+91") {
  const trimmed = phone.trim();
  if (!trimmed) return "";

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (!digits) return "";
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  return `+${digits}`;
}

export async function hashPhone(phone: string) {
  const Crypto = await import("expo-crypto");
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, normalizePhone(phone));
}
