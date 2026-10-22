import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { readConfig } from "../src/config.js";
import { createApp, type Dependencies } from "../src/app.js";
import { hashPassword, createInvite } from "../src/lib/auth.js";
export async function fixture(deps: Dependencies = {}) {
  const dir = await mkdtemp(join(tmpdir(), "community-test-"));
  const db = openDb(":memory:");
  let now = Date.now();
  const config = readConfig({
    SESSION_SECRET: "test-community-secret-is-long-enough",
    SITE_URL: "http://localhost:3100",
    DATA_DIR: dir,
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-oauth-secret",
  });
  db.prepare(
    "INSERT INTO users(id,username,username_key,password_hash,role,created_at,first_post_approved) VALUES (1,'管理员','管理员',?,'admin',?,1)",
  ).run(await hashPassword("admin-password"), now - 40 * 86400000);
  const app = createApp(config, db, { ...deps, now: () => now });
  const invite = () => createInvite(db, 1, 5, null, now);
  return {
    db,
    config,
    app,
    invite,
    setNow: (value: number) => {
      now = value;
    },
    get now() {
      return now;
    },
    close: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export function browser(app: ReturnType<typeof createApp>) {
  let cookie = "";
  let csrf = "";
  return {
    get cookie() {
      return cookie;
    },
    get csrf() {
      return csrf;
    },
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      const response = await app.request(path, { ...init, headers });
      const cookies = response.headers.getSetCookie();
      for (const item of cookies) {
        const pair = item.split(";")[0];
        if (pair.startsWith("community_session=")) cookie = pair;
      }
      const html = await response.clone().text();
      const match = html.match(/name="csrf" value="([^"]+)"/);
      if (match) csrf = match[1];
      return response;
    },
    async post(
      path: string,
      values: Record<string, string | Blob> = {},
      json = false,
    ) {
      const form = new FormData();
      form.set("csrf", csrf);
      for (const [k, v] of Object.entries(values)) form.set(k, v);
      return this.request(path, {
        method: "POST",
        body: form,
        headers: json ? { Accept: "application/json" } : {},
      });
    },
    async login(username = "管理员", password = "admin-password") {
      await this.request("/login");
      return this.post("/login", { username, password });
    },
  };
}
