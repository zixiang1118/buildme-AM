import { resolve } from "node:path";

export interface Config {
  port: number;
  appVersion: string;
  dataDir: string;
  siteUrl: string;
  sessionSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  githubMinAgeDays: number;
  downloadMacUrl: string;
  downloadWinUrl: string;
  storageDriver: "local" | "oss";
  ossRegion: string;
  ossBucket: string;
  ossAccessKeyId: string;
  ossAccessKeySecret: string;
  ossPublicUrl: string;
  trustProxy: boolean;
}
export function readConfig(env = process.env): Config {
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32)
    throw new Error("SESSION_SECRET 必须至少 32 个字符，请先配置 .env");
  const siteUrl = new URL(env.SITE_URL ?? "http://localhost:3100").origin;
  if (!["http:", "https:"].includes(new URL(siteUrl).protocol))
    throw new Error("SITE_URL 需要 http 或 https");
  const driver = env.STORAGE_DRIVER ?? "local";
  if (driver !== "local" && driver !== "oss")
    throw new Error("STORAGE_DRIVER 必须是 local 或 oss");
  if (
    driver === "oss" &&
    [
      "OSS_REGION",
      "OSS_BUCKET",
      "OSS_ACCESS_KEY_ID",
      "OSS_ACCESS_KEY_SECRET",
      "OSS_PUBLIC_URL",
    ].some((k) => !env[k])
  )
    throw new Error("请填写全部 OSS 环境变量");
  return {
    port: Number(env.PORT ?? 3100),
    appVersion: env.APP_VERSION ?? "0.4.3",
    dataDir: resolve(env.DATA_DIR ?? "./data"),
    siteUrl,
    sessionSecret,
    githubClientId: env.GITHUB_CLIENT_ID ?? "",
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? "",
    githubMinAgeDays: Number(env.GITHUB_MIN_ACCOUNT_AGE_DAYS ?? 30),
    downloadMacUrl: env.DOWNLOAD_MAC_URL ?? "",
    downloadWinUrl: env.DOWNLOAD_WIN_URL ?? "",
    storageDriver: driver,
    ossRegion: env.OSS_REGION ?? "",
    ossBucket: env.OSS_BUCKET ?? "",
    ossAccessKeyId: env.OSS_ACCESS_KEY_ID ?? "",
    ossAccessKeySecret: env.OSS_ACCESS_KEY_SECRET ?? "",
    ossPublicUrl: env.OSS_PUBLIC_URL ?? "",
    trustProxy: env.TRUST_PROXY === "true",
  };
}
