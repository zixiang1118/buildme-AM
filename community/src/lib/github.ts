import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { FormError } from "./validation.js";
export interface GithubProfile {
  id: number;
  login: string;
  avatar_url: string;
  created_at: string;
}
export class GithubClient {
  constructor(
    private config: Config,
    private endpoints = {
      authorize: "https://github.com/login/oauth/authorize",
      token: "https://github.com/login/oauth/access_token",
      user: "https://api.github.com/user",
    },
  ) {}
  authorize(state: string, verifier: string) {
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({
      client_id: this.config.githubClientId,
      redirect_uri: `${this.config.siteUrl}/auth/github/callback`,
      scope: "read:user",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }
  async profile(code: string, verifier: string): Promise<GithubProfile> {
    const response = await fetch(this.endpoints.token, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: `${this.config.siteUrl}/auth/github/callback`,
      }),
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!response.ok) throw new FormError("GitHub 授权失败，请重新登录");
    const auth = (await response.json()) as { access_token?: string };
    if (!auth.access_token) throw new FormError("GitHub 授权失败，请重新登录");
    const userResponse = await fetch(this.endpoints.user, {
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "BuildMeCommunity",
      },
      signal: AbortSignal.timeout(4000),
      redirect: "error",
    });
    if (!userResponse.ok) throw new FormError("无法读取 GitHub 资料，请重试");
    const user = (await userResponse.json()) as GithubProfile;
    if (
      !Number.isSafeInteger(user.id) ||
      typeof user.login !== "string" ||
      typeof user.avatar_url !== "string" ||
      !Number.isFinite(Date.parse(user.created_at))
    )
      throw new FormError("GitHub 返回的资料不完整");
    return user;
  }
}
