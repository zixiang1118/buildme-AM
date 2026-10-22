import type { Child } from "hono/jsx";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { Layout, Csrf } from "./layout.js";
import { unreadCount } from "../lib/interactions.js";
import { FormError } from "../lib/validation.js";
export function pageProps(c: Context<Env>, title: string) {
  return {
    title,
    unread: unreadCount(c.get("db"), c.get("user")),
    path: c.req.path,
    user: c.get("user"),
    csrf: c.get("csrf"),
    theme: c.get("theme"),
    embed: c.get("embed"),
    imageOrigin:
      c.get("config").storageDriver === "oss"
        ? new URL(c.get("config").ossPublicUrl).origin
        : undefined,
  };
}
export function Field(p: {
  label: string;
  name: string;
  value?: string;
  type?: string;
  error?: string;
  help?: string;
  required?: boolean;
  children?: Child;
}) {
  return (
    <label class="field">
      <span>{p.label}</span>
      {p.children ?? (
        <input
          name={p.name}
          type={p.type ?? "text"}
          value={p.type === "password" ? undefined : p.value}
          required={p.required}
          aria-invalid={p.error ? "true" : undefined}
          autocomplete={p.type === "password" ? "current-password" : undefined}
        />
      )}{" "}
      {p.error && <span class="field-error">{p.error}</span>}
      {p.help && <small class="field-help">{p.help}</small>}
    </label>
  );
}
export function Errors({ error }: { error?: FormError }) {
  return error ? (
    <div class="error" role="alert">
      {error.message}
    </div>
  ) : null;
}
export function AuthPage({
  c,
  register = false,
  values = {},
  error,
}: {
  c: Context<Env>;
  register?: boolean;
  values?: Record<string, string>;
  error?: FormError;
}) {
  return (
    <Layout {...pageProps(c, register ? "加入社区" : "欢迎回来")}>
      <div class="auth-layout">
        <section class="auth-intro">
          <p class="eyebrow">BUILD TOGETHER</p>
          <h1>
            一个好问题，
            <br />
            可能就是下一步的开始。
          </h1>
          <p class="muted">
            在这里分享发现，写下经验，和同学们一起把想法做出来。
          </p>
        </section>
        <section class="auth-card panel">
          <h2>{register ? "用邀请码加入" : "欢迎回来"}</h2>
          <Errors error={error} />
          {c.get("config").githubClientId && (
            <>
              <a class="button" href="/auth/github">
                用 GitHub 登录
              </a>
              <p class="muted">或使用邀请码账号</p>
            </>
          )}
          <form
            class="form"
            method="post"
            action={register ? "/register" : "/login"}
          >
            <Csrf value={c.get("csrf")} />
            <Field
              label="用户名"
              name="username"
              value={values.username}
              error={error?.fields.username}
              required
            />
            <Field
              label="密码"
              name="password"
              type="password"
              error={error?.fields.password}
              required
            />
            {register && (
              <Field
                label="邀请码"
                name="invite"
                value={values.invite}
                error={error?.fields.invite}
                required
              />
            )}
            <button class="button primary" type="submit">
              {register ? "注册并加入" : "登录"}
            </button>
          </form>
          <p>
            {register ? (
              <a href="/login">已有账号？登录</a>
            ) : (
              <a href="/register">有邀请码？注册账号</a>
            )}
          </p>
          <p class="field-help">
            忘记密码请联系管理员，或绑定 GitHub 后用 GitHub 登录。
          </p>
        </section>
      </div>
    </Layout>
  );
}
