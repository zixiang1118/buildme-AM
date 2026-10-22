import type { Hono, Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env, User } from "../types.js";
import { AuthPage, Errors, Field, pageProps } from "../views/forms.js";
import { Layout, Csrf, Avatar } from "../views/layout.js";
import {
  FormError,
  textField,
  length,
  usernameKey,
  validatePassword,
} from "../lib/validation.js";
import {
  register,
  login,
  limit,
  token,
  digest,
  ensureNameAvailable,
  hashPassword,
  verifyPassword,
  createInvite,
  resetPassword,
  logAdmin,
  userById,
} from "../lib/auth.js";
import { requireUser, requireAdmin, requireStaff, rotateSession } from "../lib/session.js";
import { GithubClient } from "../lib/github.js";
import { SafeFetcher, RemoteError } from "../lib/remote.js";
import { saveImage } from "../lib/images.js";
import { checkWords, queueProfile } from "../lib/moderation.js";
import { AdminShell } from "../views/admin.js";
function Settings({
  c,
  error,
  notice,
}: {
  c: Context<Env>;
  error?: FormError;
  notice?: string;
}) {
  const user = requireUser(c);
  return (
    <Layout {...pageProps(c, "账号设置")} notice={notice}>
      <div class="page-heading">
        <h1>账号设置</h1>
        <a href="/drafts">我的草稿</a>
      </div>
      <div class="layout">
        <section class="panel">
          <Errors error={error} />
          {user.must_change_password === 1 && (
            <p class="notice">你正在使用临时密码，请先设置新密码。</p>
          )}
          <form class="form" method="post" action="/settings">
            <Csrf value={c.get("csrf")} />
            <Field
              label="用户名"
              name="username"
              value={user.username}
              error={error?.fields.username}
              help="注册后 30 天内可以修改一次"
            />
            <Field
              label="一句话简介"
              name="bio"
              value={user.bio}
              error={error?.fields.bio}
            />
            <button class="button primary">保存资料</button>
          </form>
          {user.password_hash && (
            <>
              <h2>修改密码</h2>
              <form class="form" method="post" action="/settings/password">
                <Csrf value={c.get("csrf")} />
                <Field
                  label="当前密码"
                  name="currentPassword"
                  type="password"
                  required
                />
                <Field
                  label="新密码"
                  name="password"
                  type="password"
                  error={error?.fields.password}
                  required
                />
                <button class="button">更新密码</button>
              </form>
            </>
          )}
        </section>
        <aside class="sidebar">
          <section class="panel">
            <h2>头像</h2>
            <Avatar user={user} />
            <form
              class="form"
              method="post"
              action="/settings/avatar"
              enctype="multipart/form-data"
            >
              <Csrf value={c.get("csrf")} />
              <Field label="选择图片" name="image">
                <input
                  name="image"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  required
                />
              </Field>
              <button class="button">更新头像</button>
            </form>
          </section>
          <section class="panel">
            <h2>登录方式</h2>
            <p>{user.github_id ? "已绑定 GitHub" : "尚未绑定 GitHub"}</p>
            {!user.github_id && c.get("config").githubClientId && (
              <a class="button" href="/auth/github?bind=1">
                绑定 GitHub
              </a>
            )}
            {user.role !== "member" && (
              <p>
                <a href="/admin">管理社区</a>
              </p>
            )}
            <form method="post" action="/logout">
              <Csrf value={c.get("csrf")} />
              <button class="button">退出登录</button>
            </form>
          </section>
        </aside>
      </div>
    </Layout>
  );
}
function Admin({
  c,
  notice,
  error,
}: {
  c: Context<Env>;
  notice?: string;
  error?: FormError;
}) {
  const db = c.get("db");
  const invitations = db
    .prepare(
      "SELECT id,label,used,max_uses,expires_at,revoked FROM invitations ORDER BY id DESC",
    )
    .all() as {
    id: number;
    label: string;
    used: number;
    max_uses: number;
    expires_at: number | null;
    revoked: number;
  }[];
  const users = db
    .prepare("SELECT id,username FROM users ORDER BY id DESC LIMIT 100")
    .all() as User[];
  return (
    <AdminShell c={c} title="邀请码与账号恢复">
      {notice && <p class="notice">{notice}</p>}
      <div class="page-heading">
        <h1>社区管理</h1>
        <a href="/admin/review">待审核帖子</a>
        <a href="/admin/works">作品精选</a>
      </div>
      <Errors error={error} />
      <div class="layout">
        <section class="panel">
          <h2>邀请码</h2>
          <form class="form" method="post" action="/admin/invites">
            <Csrf value={c.get("csrf")} />
            <Field
              label="可用次数"
              name="maxUses"
              type="number"
              value="1"
              required
            />
            <Field label="有效天数（留空不过期）" name="days" type="number" />
            <button class="button primary">生成邀请码</button>
          </form>
          <div class="table-scroll">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>邀请码标识</th>
                  <th>已用 / 总次数</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((i) => (
                  <tr>
                    <td>{i.label}</td>
                    <td>
                      {i.used} / {i.max_uses}
                    </td>
                    <td>
                      {i.revoked
                        ? "已作废"
                        : i.expires_at && i.expires_at <= c.get("now")
                          ? "已过期"
                          : "有效"}
                    </td>
                    <td>
                      <form
                        method="post"
                        action={`/admin/invites/${i.id}/revoke`}
                      >
                        <Csrf value={c.get("csrf")} />
                        <button class="button" disabled={!!i.revoked}>
                          作废
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <aside class="sidebar">
          <section class="panel">
            <h2>重置用户密码</h2>
            <form class="form" method="post" action="/admin/reset-password">
              <Csrf value={c.get("csrf")} />
              <label class="field">
                用户
                <select name="userId">
                  {users.map((u) => (
                    <option value={u.id}>{u.username}</option>
                  ))}
                </select>
              </label>
              <p class="field-help">
                旧会话会立即失效。临时密码仅显示一次，请私下交给用户。
              </p>
              <button class="button">重置并生成临时密码</button>
            </form>
          </section>
        </aside>
      </div>
    </AdminShell>
  );
}
export function accounts(
  app: Hono<Env>,
  github: GithubClient,
  remote: SafeFetcher,
) {
  app.get("/login", (c) => c.html(<AuthPage c={c} />));
  app.get("/register", (c) => c.html(<AuthPage c={c} register />));
  for (const path of ["/login", "/register"])
    app.post(path, async (c) => {
      const form = await c.req.formData();
      const values = {
        username: textField(form, "username").trim(),
        invite: textField(form, "invite").trim(),
      };
      try {
        let user: User;
        if (path === "/register") {
          limit(
            c.get("db"),
            "register",
            c.get("ipKey"),
            5,
            3600000,
            c.get("now"),
          );
          user = await register(
            c.get("db"),
            values.username,
            textField(form, "password"),
            values.invite,
            c.get("now"),
          );
        } else
          user = await login(
            c.get("db"),
            values.username,
            textField(form, "password"),
            c.get("ipKey"),
            c.get("now"),
          );
        rotateSession(c, user.id);
        return c.redirect(
          user.must_change_password ? "/settings?reset=1" : "/latest",
          303,
        );
      } catch (error) {
        if (!(error instanceof FormError)) throw error;
        return c.html(
          <AuthPage
            c={c}
            register={path === "/register"}
            values={values}
            error={error}
          />,
          error.status,
        );
      }
    });
  app.post("/logout", (c) => {
    rotateSession(c, null);
    return c.redirect("/login", 303);
  });
  app.post("/theme", async (c) => {
    const form = await c.req.formData(),
      theme = textField(form, "theme");
    if (theme === "dark" || theme === "light")
      setCookie(c, "theme", theme, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: true,
        maxAge: 31536000,
      });
    else deleteCookie(c, "theme", { path: "/" });
    const back = new URL(
      textField(form, "returnTo") || "/latest",
      c.get("config").siteUrl,
    );
    return c.redirect(
      back.origin === c.get("config").siteUrl
        ? back.pathname + back.search
        : "/latest",
      303,
    );
  });
  app.get("/settings", (c) => c.html(<Settings c={c} />));
  app.post("/settings", async (c) => {
    const user = requireUser(c),
      form = await c.req.formData(),
      name = textField(form, "username").trim(),
      bio = textField(form, "bio");
    try {
      if (length(bio) > 60)
        throw new FormError("简介不能超过 60 字", {
          bio: "简介不能超过 60 字",
        });
      const change = name !== user.username;
      if (change) {
        if (user.renamed_at || c.get("now") - user.created_at > 30 * 86400000)
          throw new FormError("用户名只能在注册后 30 天内修改一次", {
            username: "已超过改名范围",
          });
        ensureNameAvailable(c.get("db"), name, user.id);
      }
      if(checkWords(c.get("db"),name+" "+bio)==='pending') {
        queueProfile(c.get("db"),user.id,name,bio,c.get("now"));
        return c.html(<Settings c={c} notice="资料已提交审核，审核前保留当前公开资料"/>);
      }
      c.get("db").prepare("DELETE FROM pending_profiles WHERE user_id=?").run(user.id);
      c.get("db").prepare("UPDATE users SET profile_pending=0 WHERE id=?").run(user.id);
      c.get("db")
        .prepare(
          "UPDATE users SET username=?,username_key=?,bio=?,renamed_at=? WHERE id=?",
        )
        .run(
          name,
          usernameKey(name),
          bio,
          change ? c.get("now") : user.renamed_at,
          user.id,
        );
      c.set("user", userById(c.get("db"), user.id)!);
      return c.html(<Settings c={c} notice="资料已保存" />);
    } catch (error) {
      if (!(error instanceof FormError)) throw error;
      return c.html(<Settings c={c} error={error} />, error.status);
    }
  });
  app.post("/settings/password", async (c) => {
    const user = requireUser(c),
      form = await c.req.formData();
    try {
      if (!user.password_hash) throw new FormError("此账号使用 GitHub 登录");
      if (
        !(await verifyPassword(
          textField(form, "currentPassword"),
          user.password_hash,
        ))
      )
        throw new FormError("当前密码错误");
      validatePassword(textField(form, "password"));
      const hash = await hashPassword(textField(form, "password"));
      c.get("db").transaction(() => {
        c.get("db")
          .prepare(
            "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
          )
          .run(hash, user.id);
        c.get("db")
          .prepare("DELETE FROM sessions WHERE user_id=?")
          .run(user.id);
      })();
      rotateSession(c, user.id);
      return c.html(<Settings c={c} notice="密码已更新，其他登录会话已退出" />);
    } catch (error) {
      if (!(error instanceof FormError)) throw error;
      return c.html(<Settings c={c} error={error} />, error.status);
    }
  });
  app.post("/settings/avatar", async (c) => {
    const user = requireUser(c);
    try {
      limit(
        c.get("db"),
        "image-hour",
        String(user.id),
        60,
        3600000,
        c.get("now"),
      );
      limit(
        c.get("db"),
        "image-day",
        String(user.id),
        200,
        86400000,
        c.get("now"),
      );
      const file = (await c.req.formData()).get("image");
      if (!(file instanceof File)) throw new FormError("请选择图片");
      const image = await saveImage(
        c.get("db"),
        c.get("storage"),
        user.id,
        Buffer.from(await file.arrayBuffer()),
        c.get("now"),
      );
      c.get("db")
        .prepare("UPDATE users SET avatar_url=? WHERE id=?")
        .run(image.url, user.id);
      return c.redirect("/settings", 303);
    } catch (error) {
      if (!(error instanceof FormError)) throw error;
      return c.html(<Settings c={c} error={error} />, error.status);
    }
  });
  app.get("/auth/github", (c) => {
    if (!c.get("config").githubClientId)
      throw new FormError("页面不存在", {}, 404);
    const bind = c.req.query("bind") === "1";
    if (bind) requireUser(c);
    const state = token(),
      verifier = token();
    c.get("db")
      .prepare("DELETE FROM oauth_states WHERE expires_at<?")
      .run(c.get("now"));
    c.get("db")
      .prepare("INSERT INTO oauth_states VALUES (?,?,?,?,?)")
      .run(
        digest(state),
        c.get("sessionId"),
        bind ? c.get("user")!.id : null,
        verifier,
        c.get("now") + 600000,
      );
    return c.redirect(github.authorize(state, verifier));
  });
  app.get("/auth/github/callback", async (c) => {
    const db = c.get("db");
    const state = c.req.query("state");
    if (!state) throw new FormError("GitHub 授权状态无效，请重新登录", {}, 403);
    const record = db
      .prepare(
        "SELECT * FROM oauth_states WHERE state_hash=? AND session_id=? AND expires_at>?",
      )
      .get(digest(state), c.get("sessionId"), c.get("now")) as
      { user_id: number | null; verifier: string } | undefined;
    if (!record)
      throw new FormError("GitHub 授权状态无效，请重新登录", {}, 403);
    db.prepare("DELETE FROM oauth_states WHERE state_hash=?").run(
      digest(state),
    );
    const code = c.req.query("code");
    if (!code) throw new FormError("GitHub 授权未完成，请重试");
    let profile;
    try {
      profile = await github.profile(code, record.verifier);
    } catch (error) {
      if (error instanceof FormError) throw error;
      throw new FormError("GitHub 暂时无法访问，请稍后再试或使用邀请码账号");
    }
    let user = db
      .prepare("SELECT * FROM users WHERE github_id=?")
      .get(String(profile.id)) as User | undefined;
    if (record.user_id) {
      const current = requireUser(c);
      if (current.id !== record.user_id)
        throw new FormError("绑定会话已失效", {}, 403);
      if (user && user.id !== current.id)
        throw new FormError("这个 GitHub 账号已绑定其他社区账号");
      if (current.github_id && current.github_id !== String(profile.id))
        throw new FormError("此账号已经绑定 GitHub");
      db.prepare("UPDATE users SET github_id=? WHERE id=?").run(
        String(profile.id),
        current.id,
      );
      return c.redirect("/settings", 303);
    }
    if (!user) {
      if (
        c.get("now") - Date.parse(profile.created_at) <
        c.get("config").githubMinAgeDays * 86400000
      )
        throw new FormError("你的 GitHub 账号太新，请使用邀请码注册");
      limit(db, "register", c.get("ipKey"), 5, 3600000, c.get("now"));
      let base = profile.login.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 16);
      if (base.length < 2) base = `gh_${base}`;
      let name = base,
        n = 1;
      while (
        db
          .prepare("SELECT 1 FROM users WHERE username_key=?")
          .get(usernameKey(name))
      ) {
        const suffix = String(n++);
        name = base.slice(0, 16 - suffix.length) + suffix;
      }
      const profileReview=checkWords(db,name)==='pending';
      const result = db
        .prepare(
          "INSERT INTO users(username,username_key,github_id,created_at) VALUES (?,?,?,?)",
        )
        .run(name, usernameKey(name), String(profile.id), c.get("now"));
      user = userById(db, Number(result.lastInsertRowid))!;
      if(profileReview) {db.prepare("UPDATE users SET profile_pending=1 WHERE id=?").run(user.id);queueProfile(db,user.id,name,"",c.get("now"));}
      if (profile.avatar_url) {
        try {
          const avatar = await remote.get(profile.avatar_url, {
            maxBytes: 8 * 1024 * 1024,
          });
          const image = await saveImage(
            db,
            c.get("storage"),
            user.id,
            avatar.body,
            c.get("now"),
          );
          db.prepare("UPDATE users SET avatar_url=? WHERE id=?").run(
            image.url,
            user.id,
          );
        } catch (error) {
          if (!(error instanceof FormError || error instanceof RemoteError))
            throw error;
        }
      }
    }
    if (user.banned) throw new FormError("账号已被停用", {}, 403);
    rotateSession(c, user.id);
    return c.redirect("/latest", 303);
  });
  app.use("/admin/*", async (c, next) => {
    requireStaff(c);
    await next();
  });
  app.get("/admin", (c) => {
    if(requireStaff(c).role==='moderator')return c.redirect('/admin/review');
    return c.html(<Admin c={c} />);
  });
  app.post("/admin/invites", async (c) => {
    const admin = requireAdmin(c),
      form = await c.req.formData();
    try {
      const max = Number(textField(form, "maxUses")),
        days = textField(form, "days");
      if (
        !Number.isInteger(max) ||
        max < 1 ||
        max > 10000 ||
        (days &&
          (!Number.isInteger(Number(days)) ||
            Number(days) < 1 ||
            Number(days) > 3650))
      )
        throw new FormError("请输入有效次数（1–10000）和有效天数（1–3650）");
      const code = createInvite(
        c.get("db"),
        admin.id,
        max,
        days ? c.get("now") + Number(days) * 86400000 : null,
        c.get("now"),
      );
      return c.html(<Admin c={c} notice={`邀请码（仅显示一次）：${code}`} />);
    } catch (error) {
      if (!(error instanceof FormError)) throw error;
      return c.html(<Admin c={c} error={error} />, error.status);
    }
  });
  app.post("/admin/invites/:id/revoke", (c) => {
    const admin = requireAdmin(c);
    c.get("db")
      .prepare("UPDATE invitations SET revoked=1 WHERE id=?")
      .run(c.req.param("id"));
    logAdmin(
      c.get("db"),
      admin.id,
      "invite.revoke",
      c.req.param("id"),
      c.get("now"),
    );
    return c.redirect("/admin", 303);
  });
  app.post("/admin/reset-password", async (c) => {
    const admin = requireAdmin(c);
    const id = Number(textField(await c.req.formData(), "userId"));
    if (!userById(c.get("db"), id)) throw new FormError("用户不存在");
    const password = await resetPassword(
      c.get("db"),
      admin.id,
      id,
      c.get("now"),
    );
    return c.html(
      <Admin
        c={c}
        notice={`用户 ${id} 的临时密码（仅显示一次）：${password}`}
      />,
    );
  });
}
