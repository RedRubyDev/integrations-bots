import { Provider } from "./contracts";

export type UpdateMode = "webhook" | "polling";
export type UpdateModes = Record<Provider, UpdateMode>;

export function resolveUpdateModes(env: Record<string, string | undefined>): UpdateModes {
  const parse = (name: string, fallback: UpdateMode): UpdateMode => {
    const value = env[name] || fallback;
    if (value !== "webhook" && value !== "polling") throw new Error(`${name} must be webhook or polling`);
    return value;
  };
  const fallback = parse("BOT_UPDATE_MODE", "webhook");
  return {
    telegram: parse("TELEGRAM_UPDATE_MODE", fallback),
    bale: parse("BALE_UPDATE_MODE", fallback),
  };
}
