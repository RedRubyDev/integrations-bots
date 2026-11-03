import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { IntegrationError } from "../contracts";

export class CryptoBox {
  private readonly key: Buffer;
  constructor(key: string) {
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("BOT_STORAGE_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes)");
    this.key = Buffer.from(key, "hex");
  }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
  }
  open<T>(value: string): T {
    try {
    const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8")) as T;
    } catch {
      throw new IntegrationError("Stored bot data cannot be decrypted; restore the original storage encryption key", 503, 0, "BOT_STORAGE_DECRYPTION_FAILED");
    }
  }
}
