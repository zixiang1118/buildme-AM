import { describe, it, expect } from "vitest";
import { openDb, migrate } from "../src/db/index.js";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
const config = readConfig({
  SESSION_SECRET: "test-secret-for-community-at-least-32",
  SITE_URL: "http://localhost:3100",
});
describe("C0", () => {
  it("D-3 重复迁移保留已有数据", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO tags(name) VALUES ('测试标签')").run();
    migrate(db);
    expect(
      db.prepare("SELECT name FROM tags WHERE name=?").get("测试标签"),
    ).toEqual({ name: "测试标签" });
    db.close();
  });
  it("S-2 页面仅使用本站资源，并提供双外壳", async () => {
    const db = openDb(":memory:");
    const app = createApp(config, db);
    const page = await app.request("/latest?embed=1&theme=dark");
    const html = await page.text();
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain("is-embed");
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect((await app.request("/healthz")).status).toBe(200);
    db.close();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "../src/lib/storage.js";
it("C0 本地存储读写与删除采用服务端 key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "community-storage-"));
  const storage = new LocalStorage(dir);
  await storage.put("test.webp", Buffer.from("test"));
  expect(await storage.get("test.webp")).toEqual(Buffer.from("test"));
  expect(storage.url("test.webp")).toBe("/media/test.webp");
  await storage.remove("test.webp");
  await expect(storage.get("test.webp")).rejects.toThrow();
  await rm(dir, { recursive: true });
});
