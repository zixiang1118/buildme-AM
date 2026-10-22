import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import { bodyLimit } from "hono/body-limit";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Env } from "./types.js";
import { Layout, Empty } from "./views/layout.js";
import { pageProps } from "./views/forms.js";
import { createStorage, type Storage } from "./lib/storage.js";
import { publicCache } from "./lib/public-cache.js";
import { sessions } from "./lib/session.js";
import { FormError } from "./lib/validation.js";
import { GithubClient } from "./lib/github.js";
import { SafeFetcher } from "./lib/remote.js";
import { administration } from "./routes/admin.js";
import { accounts } from "./routes/accounts.js";
import { posts } from "./routes/posts.js";
import { workRoutes } from "./routes/works.js";
import { browsing } from "./routes/browse.js";
import { interactions } from "./routes/interactions.js";
export interface Dependencies {
  storage?: Storage;
  github?: GithubClient;
  remote?: SafeFetcher;
  now?: () => number;
}
export function createApp(config: Config, db: Db, deps: Dependencies = {}) {
  const app = new Hono<Env>(),
    storage = deps.storage ?? createStorage(config),
    remote = deps.remote ?? new SafeFetcher();
  app.use("*", compress());
  app.use("*", async (c, next) => {
    const images =
      config.storageDriver === "oss"
        ? ` ${new URL(config.ossPublicUrl).origin}`
        : "";
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'${images}; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Cache-Control", "no-store");
    c.set("config", config);
    c.set("db", db);
    c.set("storage", storage);
    c.set("now", (deps.now ?? Date.now)());
    await next();
  });
  app.use("/assets/*", async (c, next) => {
    c.header(
      "Cache-Control",
      /\.[a-f0-9]{12}\./.test(c.req.path)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    );
    await next();
  });
  app.use(
    "/assets/*",
    serveStatic({
      root: "./public",
      rewriteRequestPath: (p) =>
        p.replace("/assets/", "/").replace(/\.[a-f0-9]{12}(?=\.)/, ""),
    }),
  );
  app.use(
    "/fonts/*",
    async (c, next) => {
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      await next();
    },
    serveStatic({ root: "./public" }),
  );
  app.use(
    "/media/*",
    async (c, next) => {
      if (!/^\/media\/[a-f0-9-]+(?:-640)?\.(webp|gif)$/.test(c.req.path))
        return c.notFound();
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      await next();
    },
    serveStatic({ root: config.dataDir, rewriteRequestPath: (p) => p }),
  );
  app.get("/healthz", (c) => {
    db.prepare("UPDATE health_probe SET checked_at=? WHERE id=1").run(
      Date.now(),
    );
    db.prepare("SELECT checked_at FROM health_probe").get();
    return c.json({ status: "ok", database: "read-write" });
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 10 * 1024 * 1024,
      onError: (c) => c.text("请求不能超过 10MB", 413),
    }),
  );
  app.use("*", sessions);
  app.use("*", publicCache());
  accounts(app, deps.github ?? new GithubClient(config), remote);
  administration(app);
  browsing(app);
  workRoutes(app);
  posts(app, remote);
  interactions(app);
  app.get("/about", (c) =>
    c.html(
      <Layout {...pageProps(c, "关于与规则")}>
        <section class="panel prose">
          <h1>关于 BuildMe 社区</h1>
          <p>一个分享 Agent 学习与实践的地方。</p>
          <h2>社区规则（待负责人完善）</h2>
          <p>
            尊重他人，分享可复现的经验，不发布广告或他人的隐私。联系方式由负责人上线前补充。
          </p>
        </section>
      </Layout>,
    ),
  );
  app.notFound((c) =>
    c.html(
      <Layout {...pageProps(c, "页面不存在")}>
        <Empty title="页面不存在">
          这个地址不存在，或功能尚未开放。<a href="/latest">返回社区</a>
        </Empty>
      </Layout>,
      404,
    ),
  );
  app.onError((error, c) => {
    if (error instanceof FormError) {
      if (c.req.header("accept")?.includes("application/json"))
        return c.json(
          { error: error.message, fields: error.fields },
          error.status,
        );
      return c.html(
        <Layout {...pageProps(c, "请检查操作")}>
          <section class="panel">
            <p class="error" role="alert">
              {error.message}
            </p>
            <a href={c.get("user") ? "/latest" : "/login"}>
              {c.get("user") ? "返回社区" : "前往登录"}
            </a>
          </section>
        </Layout>,
        error.status,
      );
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "request_failed",
        path: c.req.path,
      }),
    );
    return c.text("服务暂时不可用，请稍后再试。", 500);
  });
  return app;
}
