import { describe, expect, it } from "vitest";
import { canUseNativeCrypto, createConversationKey, decryptMessage, encryptMessage } from "./crypto";

describe("message encryption", () => {
  it.runIf(canUseNativeCrypto())("round trips encrypted messages", async () => {
    const key = createConversationKey();
    const envelope = await encryptMessage("orbita secret", key);

    expect(envelope.ciphertext).not.toContain("orbita secret");
    await expect(decryptMessage(envelope, key)).resolves.toBe("orbita secret");
  });
});
