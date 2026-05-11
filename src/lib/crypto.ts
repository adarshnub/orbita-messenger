export type EncryptedEnvelope = {
  version: 1;
  algorithm: "AES-GCM-256";
  iv: string;
  ciphertext: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  if (typeof btoa !== "undefined") {
    return btoa(String.fromCharCode(...bytes));
  }
  const nodeBuffer = (globalThis as unknown as { Buffer?: { from: (value: Uint8Array) => { toString: (encoding: string) => string } } }).Buffer;
  if (!nodeBuffer) throw new Error("Base64 encoding is unavailable on this runtime.");
  return nodeBuffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string) {
  if (typeof atob !== "undefined") {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }
  const nodeBuffer = (globalThis as unknown as {
    Buffer?: { from: (value: string, encoding: string) => Uint8Array };
  }).Buffer;
  if (!nodeBuffer) throw new Error("Base64 decoding is unavailable on this runtime.");
  return Uint8Array.from(nodeBuffer.from(value, "base64"));
}

export function canUseNativeCrypto() {
  return Boolean(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues);
}

export async function importConversationKey(rawKeyBase64: string) {
  if (!canUseNativeCrypto()) {
    throw new Error("WebCrypto is unavailable on this runtime.");
  }

  return crypto.subtle.importKey("raw", base64ToBytes(rawKeyBase64), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export function createConversationKey() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generation is unavailable on this runtime.");
  }

  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return bytesToBase64(key);
}

export async function encryptMessage(plainText: string, rawKeyBase64: string): Promise<EncryptedEnvelope> {
  const key = await importConversationKey(rawKeyBase64);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plainText));

  return {
    version: 1,
    algorithm: "AES-GCM-256",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptMessage(envelope: EncryptedEnvelope, rawKeyBase64: string) {
  const key = await importConversationKey(rawKeyBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext),
  );

  return decoder.decode(plaintext);
}
