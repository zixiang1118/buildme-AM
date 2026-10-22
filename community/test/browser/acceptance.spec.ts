import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
async function login(page: Page, name = "浏览器管理员") {
  await page.goto("/login");
  await page.getByLabel("用户名", { exact: true }).fill(name);
  await page.getByLabel("密码", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/latest/);
}
test("P-12 关闭JS注册、登录、发帖、审核、回复和点赞", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL: "http://localhost:3198",
  });
  const page = await context.newPage();
  await page.goto("/register");
  await page.getByLabel("用户名", { exact: true }).fill("无脚本同学");
  await page.getByLabel("密码", { exact: true }).fill("browser-test-password");
  await page.getByLabel("邀请码", { exact: true }).fill("browser-only-invite");
  await page.getByRole("button", { name: "注册并加入" }).click();
  await expect(page).toHaveURL(/latest/);
  await page.goto("/new");
  await page
    .getByLabel("标题", { exact: true })
    .fill("关闭脚本也可以发布学习笔记");
  await page
    .getByLabel("正文 · Markdown", { exact: true })
    .fill("# 无脚本发帖\n\n这是真实浏览器表单提交。");
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(
    page.getByText("审核中：管理员通过后会向所有人公开。"),
  ).toBeVisible();
  const url = page.url();
  const admin = await browser.newPage({
    baseURL: "http://localhost:3198",
    javaScriptEnabled: false,
  });
  await login(admin);
  await admin.goto("/admin/review");
  await admin.getByRole("button", { name: "通过审核" }).click();
  await admin.goto(url);
  await admin.getByLabel("回复 · Markdown").fill("无JS也可以回复。");
  await admin.getByRole("button", { name: "发布回复" }).click();
  await admin.getByRole("button", { name: "点赞", exact: true }).click();
  await expect(admin.getByRole("button", { name: "取消点赞" })).toBeVisible();
  await expect(admin.locator("#replies")).toContainText("无JS也可以回复。");
  await admin.close();
  await context.close();
});
test("P-9 5秒本地草稿恢复，服务器草稿继续编辑", async ({ page }) => {
  await login(page, "草稿同学");
  await page.clock.install();
  await page.goto("/new");
  await page.getByLabel("标题", { exact: true }).fill("尚未发布的学习记录");
  await page
    .getByLabel("正文 · Markdown", { exact: true })
    .fill("草稿内容\n\n- [x] 保存完整");
  await page.clock.fastForward(5100);
  await expect(page.locator("#editor-status")).toContainText(
    "草稿已保存在此浏览器",
  );
  await page.reload();
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByLabel("正文 · Markdown", { exact: true })).toHaveValue(
    "草稿内容\n\n- [x] 保存完整",
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page).toHaveURL(/\/drafts\/\d+$/);
  await page.goto("/drafts");
  await page.getByRole("link", { name: "尚未发布的学习记录" }).click();
  await expect(page.getByLabel("标题", { exact: true })).toHaveValue(
    "尚未发布的学习记录",
  );
});
test("P-4 图片上传、实时预览、表情和发布一致，清理已发布本地草稿", async ({
  page,
}) => {
  await login(page, "图片同学");
  await page.goto("/new");
  await page.getByLabel("标题", { exact: true }).fill("图文编辑器的浏览器验收");
  await page
    .getByLabel("正文 · Markdown", { exact: true })
    .fill(
      "# 预览标题\n\n```js\nconst answer = 42;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 图片 | 完成 |",
    );
  await page.locator("[data-image-input]").setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 320, height: 200, channels: 3, background: "#c4582f" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.getByLabel("正文 · Markdown", { exact: true })).toHaveValue(
    /\/media\/.*webp/,
  );
  await expect(page.locator("#editor-preview img")).toBeVisible();
  await expect(page.locator("#editor-preview table")).toBeVisible();
  await page.getByRole("button", { name: "表情", exact: true }).click();
  await page
    .locator(".emoji-panel button")
    .filter({ hasText: "😀" })
    .first()
    .click();
  await expect(page.getByLabel("正文 · Markdown", { exact: true })).toHaveValue(
    /😀/,
  );
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page).toHaveURL(/\/p\/\d+/);
  await expect(page.locator(".prose img")).toBeVisible();
  await expect(page.locator(".prose table")).toBeVisible();
  await page.getByRole("button", { name: "复制这段代码" }).click();
  await page.locator(".prose img").click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.goto("/new");
  await expect(
    page.getByRole("button", { name: "恢复草稿", exact: true }),
  ).toHaveCount(0);
});
test("快速分享无整页刷新，手机与双主题没有横向溢出或外站资源", async ({
  page,
}) => {
  const errors: string[] = [];
  const resources: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => resources.push(request.url()));
  await login(page, "快速同学");
  await page.locator("summary").filter({ hasText: "贴一个链接" }).click();
  await page
    .locator("form[data-quick-share] input[name=title]")
    .fill("快速分享的真实浏览器验证");
  await page
    .locator("form[data-quick-share] textarea[name=body]")
    .fill("发布后直接加入当前列表。");
  const marker = await page.evaluate(() => {
    document.body.dataset.testMarker = "retained";
    return document.body.dataset.testMarker;
  });
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.locator("#post-list .post-card").first()).toContainText(
    "快速分享的真实浏览器验证",
  );
  expect(await page.locator("body").getAttribute("data-test-marker")).toBe(
    marker,
  );
  await mkdir("output/playwright", { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.goto(`/latest?theme=${theme}`);
    await page.screenshot({
      path: `output/playwright/latest-${theme}.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/latest", "/new", "/login", "/settings", "/drafts"]) {
      await page.goto(path);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        path,
      ).toBe(true);
    }
    await page.screenshot({
      path: `output/playwright/mobile-${theme}.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.goto("/latest?embed=1&theme=dark");
  await expect(page.locator(".brand")).toBeHidden();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await page.goto("/new");
  await expect(page.locator(".brand")).toBeHidden();
  expect(
    resources.every((url) => new URL(url).origin === "http://localhost:3198"),
  ).toBe(true);
  expect(errors).toEqual([]);
});
