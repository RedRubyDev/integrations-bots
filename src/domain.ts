import { createHmac, timingSafeEqual } from "crypto";

export const tenantServiceKey = (masterKey: string, tenantId: string) =>
  createHmac("sha256", masterKey).update(`shop-bot:${tenantId}`).digest("hex");

export function normalizeDomain(value: string, allowLocal = false): string | null {
  try {
    const url = new URL(
      value.includes("://") ? value.trim() : `https://${value.trim()}`,
    );
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    const domain = url.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    if (allowLocal && ["localhost", "127.0.0.1"].includes(domain)) return domain;
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      domain,
    )
      ? domain
      : null;
  } catch {
    return null;
  }
}
export function secretsEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
