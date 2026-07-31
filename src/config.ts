export type PluginConfig = {
  defaultDirectory: string;
  tokenGuideUrl?: string | undefined;
};

const ALLOWED_KEYS = new Set(["defaultDirectory", "tokenGuideUrl"]);

export function resolvePluginConfig(value: unknown): PluginConfig {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`unknown configuration key: ${key}`);
    }
  }
  const defaultDirectory =
    typeof record.defaultDirectory === "string"
      ? record.defaultDirectory.trim()
      : "/openClawShare";
  const tokenGuideUrl =
    typeof record.tokenGuideUrl === "string" && record.tokenGuideUrl.trim()
      ? new URL(record.tokenGuideUrl).toString()
      : undefined;
  return { defaultDirectory, tokenGuideUrl };
}
