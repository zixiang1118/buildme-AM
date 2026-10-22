import { describe, it, expect } from "vitest";
import { fixture, browser } from "./helpers.js";
import {
  hashPassword,
  verifyPassword,
  createInvite,
  resetPassword,
  register,
} from "../src/lib/auth.js";
import { readConfig } from "../src/config.js";
import { GithubClient } from "../src/lib/github.js";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
async function githubFixture() {
  let id = 99;
  let age = 40;
  let authorizations = 0;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/token") {
      authorizations++;
      res.end(JSON.stringify({ access_token: "oauth-token-never-store" }));
    } else
      res.end(
        JSON.stringify({
          id,
          login: "GitHub-User",
          avatar_url: "",
          created_at: new Date(Date.now() - age * 86400000).toISOString(),
        }),
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = readConfig({
    SESSION_SECRET: "test-community-secret-is-long-enough",
    GITHUB_CLIENT_ID: "test",
  });
  const f = await fixture({
    github: new GithubClient(config, {
      authorize: `${base}/authorize`,
      token: `${base}/token`,
      user: `${base}/user`,
    }),
  });
  return {
    ...f,
    setAge: (a: number) => {
      age = a;
    },
    setId: (i: number) => {
      id = i;
    },
    get calls() {
      return authorizations;
    },
    close: async () => {
      await f.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function oauth(b: ReturnType<typeof browser>, bind = false) {
  const response = await b.request("/auth/github" + (bind ? "?bind=1" : ""));
  const state = new URL(response.headers.get("location")!).searchParams.get(
    "state",
  );
  return b.request(`/auth/github/callback?code=mock-code&state=${state}`);
}
describe("C1 账号", () => {
  it("U-1 GitHub 首次创建、再次登录同一账号，U-3 令牌不落库", async () => {
    const f = await githubFixture();
    const b = browser(f.app);
    expect((await oauth(b)).status).toBe(303);
    await b.request("/settings");
    await b.post("/logout");
    expect((await oauth(b)).status).toBe(303);
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM users WHERE github_id=?").get("99"),
    ).toEqual({ n: 1 });
    expect(
      f.db.serialize().includes(Buffer.from("oauth-token-never-store")),
    ).toBe(false);
    await f.close();
  });
  it("U-2 新 GitHub 账号被拒绝", async () => {
    const f = await githubFixture();
    f.setAge(1);
    const response = await oauth(browser(f.app));
    expect(await response.text()).toContain("请使用邀请码注册");
    expect(f.db.prepare("SELECT COUNT(*) n FROM users").get()).toEqual({
      n: 1,
    });
    await f.close();
  });
  it("U-3 state 缺失、不匹配和跨会话拒绝", async () => {
    const f = await githubFixture();
    const a = browser(f.app),
      b = browser(f.app);
    expect((await a.request("/auth/github/callback?code=bad")).status).toBe(
      403,
    );
    const start = await a.request("/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    );
    expect(
      (await b.request(`/auth/github/callback?state=${state}&code=x`)).status,
    ).toBe(403);
    expect(
      (await a.request("/auth/github/callback?state=wrong&code=x")).status,
    ).toBe(403);
    expect(f.calls).toBe(0);
    await f.close();
  });
  it("U-4 邀请注册、错误、过期、耗尽以及并发单次邀请码", async () => {
    const f = await fixture();
    const b = browser(f.app);
    await b.request("/register");
    expect(
      (
        await b.post("/register", {
          username: "同学甲",
          password: "password123",
          invite: f.invite(),
        })
      ).status,
    ).toBe(303);
    const expired = createInvite(f.db, 1, 1, f.now - 1);
    await expect(
      register(f.db, "过期用户", "password123", expired, f.now),
    ).rejects.toThrow("过期");
    await expect(
      register(f.db, "错误用户", "password123", "wrong", f.now),
    ).rejects.toThrow("错误");
    const one = createInvite(f.db, 1, 1, null);
    const results = await Promise.allSettled([
      register(f.db, "并发甲", "password123", one, f.now),
      register(f.db, "并发乙", "password123", one, f.now),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await f.close();
  });
  it("U-5 用户名大小写唯一且中文可用，U-6 密码随机盐存储", async () => {
    const f = await fixture();
    const code = f.invite();
    const user = await register(f.db, "Alice", "password123", code, f.now);
    await expect(
      register(f.db, "alice", "password123", code, f.now),
    ).rejects.toThrow("这个用户名已被使用");
    expect(user.password_hash).not.toContain("password123");
    const another = await hashPassword("password123");
    expect(another).not.toBe(user.password_hash);
    expect(await verifyPassword("password123", another)).toBe(true);
    await f.close();
  });
  it("U-7 同 IP 五次失败后锁定十五分钟", async () => {
    const f = await fixture();
    const b = browser(f.app);
    await b.request("/login");
    for (let i = 0; i < 5; i++)
      expect(
        (await b.post("/login", { username: "管理员", password: "incorrect" }))
          .status,
      ).toBe(400);
    const blocked = await b.post("/login", {
      username: "管理员",
      password: "admin-password",
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("秒后再试");
    f.setNow(f.now + 900001);
    expect(
      (
        await b.post("/login", {
          username: "管理员",
          password: "admin-password",
        })
      ).status,
    ).toBe(303);
    await f.close();
  });
  it("U-8 邀请账号绑定 GitHub 后登录同一账号且禁止重复绑定", async () => {
    const f = await githubFixture();
    const a = browser(f.app);
    await a.login();
    expect((await oauth(a, true)).status).toBe(303);
    await a.request("/settings");
    await a.post("/logout");
    expect((await oauth(a)).status).toBe(303);
    expect(await (await a.request("/settings")).text()).toContain("管理员");
    const other = await register(
      f.db,
      "其他用户",
      "password123",
      f.invite(),
      f.now,
    );
    const b = browser(f.app);
    await b.login(other.username, "password123");
    expect(await (await oauth(b, true)).text()).toContain("已绑定其他");
    await f.close();
  });
  it("U-9 退出和重置立即撤销旧会话，临时密码强制更新", async () => {
    const f = await fixture();
    const b = browser(f.app);
    await b.login();
    const old = b.cookie;
    await b.request("/settings");
    await b.post("/logout");
    expect(
      (await f.app.request("/settings", { headers: { cookie: old } })).status,
    ).toBe(403);
    const user = await register(
      f.db,
      "重置用户",
      "password123",
      f.invite(),
      f.now,
    );
    await b.login(user.username, "password123");
    const old2 = b.cookie;
    const temporary = await resetPassword(f.db, 1, user.id, f.now);
    expect(
      (await f.app.request("/settings", { headers: { cookie: old2 } })).status,
    ).toBe(403);
    expect(
      (await b.login(user.username, temporary)).headers.get("location"),
    ).toBe("/settings?reset=1");
    expect((await b.request("/latest")).headers.get("location")).toBe(
      "/settings?reset=1",
    );
    await b.request("/settings");
    expect(
      (
        await b.post("/settings/password", {
          currentPassword: temporary,
          password: "new-password",
        })
      ).status,
    ).toBe(200);
    expect((await b.request("/latest")).status).toBe(200);
    await f.close();
  });
  it("M-9 CSRF 错误返回403，管理员入口无权限返回404", async () => {
    const f = await fixture();
    const b = browser(f.app);
    await b.request("/register");
    expect((await b.post("/register", { csrf: "wrong" })).status).toBe(403);
    const user = await register(
      f.db,
      "普通用户",
      "password123",
      f.invite(),
      f.now,
    );
    await b.login(user.username, "password123");
    expect((await b.request("/admin")).status).toBe(404);
    await f.close();
  });
});
