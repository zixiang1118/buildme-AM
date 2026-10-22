import { test, expect } from "@playwright/test";
test("B-8 即时搜索200毫秒防抖并支持斜线快捷键", async ({ page }) => {
  const searches: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/search/suggest?")) searches.push(r.url());
  });
  await page.goto("/");
  await expect(page.locator("[data-mobile-menu]")).toBeHidden();
  await page.keyboard.press("/");
  await expect(page.locator("[data-search-input]")).toBeFocused();
  await page
    .locator("[data-search-input]")
    .pressSequentially("harness", { delay: 20 });
  await expect.poll(() => searches.length).toBe(1);
  await expect(page.locator("#search-suggestions")).toContainText("harness");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=harness/);
  await expect(page.locator("mark").first()).toHaveText("harness");
});
test("B-10 B-11 B-12 浅深主题的浏览页面390px布局与正文对比度，嵌入保持", async ({
  page,
}) => {
  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [
      "/",
      "/p/1",
      "/search?q=harness",
      "/login",
      "/tags",
      "/download",
    ]) {
      await page.goto(`${path}${path.includes("?") ? "&" : "?"}theme=${theme}`);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        path,
      ).toBe(true);
      const failures = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const rgba = (value: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data).map(
            (n, i) => (i === 3 ? n / 255 : n),
          );
        };
        const over = (a: number[], b: number[]) =>
          a
            .slice(0, 3)
            .map((n, i) => n * a[3] + b[i] * (1 - a[3]))
            .concat(1);
        const luminosity = (rgb: number[]) =>
          rgb
            .slice(0, 3)
            .map((n) => {
              const v = n / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
        const failed: {
          text: string;
          ratio: number;
          tag: string;
          parent: string;
          color: string;
          background: number[];
        }[] = [];
        for (const element of Array.from(
          document.querySelectorAll<HTMLElement>("body *"),
        )) {
          if (
            !Array.from(element.childNodes).some(
              (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
            ) ||
            !element.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
            }) ||
            element.closest("svg,script,style,option")
          )
            continue;
          const chain: HTMLElement[] = [];
          let current: HTMLElement | null = element;
          while (current) {
            chain.unshift(current);
            current = current.parentElement;
          }
          let background = [255, 255, 255, 1];
          for (const node of chain)
            background = over(
              rgba(getComputedStyle(node).backgroundColor),
              background,
            );
          const foreground = over(
              rgba(getComputedStyle(element).color),
              background,
            ),
            a = luminosity(foreground),
            b = luminosity(background),
            ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          if (ratio < 4.49)
            failed.push({
              text: element.textContent!.trim().slice(0, 45),
              ratio,
              tag: element.tagName,
              parent: element.parentElement!.outerHTML.slice(0, 400),
              color: getComputedStyle(element).color,
              background,
            });
        }
        return failed;
      });
      expect.soft(failures, `${theme} ${path}`).toEqual([]);
    }
  }
  await page.goto("/?embed=1&theme=dark");
  await expect(page.locator(".brand")).toBeHidden();
  await page.goto("/search?q=harness");
  await expect(page.locator(".brand")).toBeHidden();
});
