import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../desktop/renderer/markdown.js", import.meta.url), "utf8");
function fixture() {
  const { window, document } = parseHTML("<html><body><article></article></body></html>");
  window.markdownit = MarkdownIt;
  vm.runInContext(source, vm.createContext({ window, document }));
  const article = document.querySelector("article");
  return { article, render: text => window.renderMarkdown(article, text) };
}

describe("chat Markdown", () => {
  it("renders the reported heading, emphasis, repository table, links, lists and literal code", () => {
    const { article, render } = fixture();
    render('## 装了什么\n\n**caveman** → `~/.claude/skills/caveman/`\n\n| 项 | 值 |\n|---|---|\n| 仓库 | [仓库](https://example.com/project) |\n| 文件 | `SKILL.md` + `LICENSE` |\n\n1. 第一项\n2. 第二项\n\n> 说明\n\n```sh\n# 原样保留\nprintf "**literal**"\n```');
    expect(article.querySelector("h2").textContent).toBe("装了什么");
    expect(article.querySelector("strong").textContent).toBe("caveman");
    expect(article.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(article.querySelector(".markdown-table").getAttribute("tabindex")).toBe("0");
    expect(article.querySelector("a").getAttribute("href")).toBe("https://example.com/project");
    expect(article.querySelector("a").getAttribute("rel")).toBe("noopener noreferrer");
    expect(article.querySelectorAll("ol li")).toHaveLength(2);
    expect(article.querySelector("blockquote").textContent.trim()).toBe("说明");
    expect(article.querySelector("pre code").textContent).toBe('# 原样保留\nprintf "**literal**"\n');
  });

  it("does not execute model HTML or create links to executable or local protocols", () => {
    const { article, render } = fixture();
    render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[JS](javascript:alert(1)) [file](file:///etc/passwd) [data](data:text/html,payload) [app](custom:launch)\n\n![远程图片](https://example.com/tracker.png)');
    expect(article.querySelectorAll("script,img,iframe,a")).toHaveLength(0);
    expect(article.textContent).toContain("<script>alert(1)</script>");
    expect(article.textContent).toContain("远程图片");
  });

  it("reparses split Markdown tokens while preserving escapes and fenced code", () => {
    const { article, render } = fixture();
    render("## 标题\n\n**部");
    render("## 标题\n\n**部分完成**\n\n\\# 字面井号\n\n```md\n## 代码里的标题");
    expect(article.querySelector("strong").textContent).toBe("部分完成");
    expect(article.querySelectorAll("h2")).toHaveLength(1);
    expect(article.textContent).toContain("# 字面井号");
    expect(article.querySelector("pre code").textContent).toContain("## 代码里的标题");
  });

  it("keeps table alignment under the desktop policy that disallows inline styles", () => {
    const { article, render } = fixture();
    render("| 左 | 中 | 右 |\n|:---|:---:|---:|\n| 一 | 二 | 三 |");
    expect(article.querySelector("th.markdown-align-center").textContent).toBe("中");
    expect(article.querySelector("td.markdown-align-right").textContent).toBe("三");
    expect(article.querySelector("[style]")).toBeNull();
  });

  it("keeps completed blocks and growing fenced-code nodes while streaming", () => {
    const { article, render } = fixture();
    const prefix = "## 已完成\n\n保留这段说明。\n\n```js\n";
    render(`${prefix}const first = 1;`);
    const heading = article.querySelector("h2"), paragraph = article.querySelector("p");
    const pre = article.querySelector("pre"), code = pre.querySelector("code"), text = code.firstChild;
    pre.scrollLeft = 120;

    render(`${prefix}const first = 1;\nconst second = 2;`);
    expect(article.querySelector("h2")).toBe(heading);
    expect(article.querySelector("p")).toBe(paragraph);
    expect(article.querySelector("pre")).toBe(pre);
    expect(pre.querySelector("code")).toBe(code);
    expect(code.firstChild).toBe(text);
    expect(pre.scrollLeft).toBe(120);
    expect(code.textContent).toBe("const first = 1;\nconst second = 2;");

    render(`${prefix}const first = 1;\nconst second = 2;\n\`\`\`\n\n**完成**`);
    expect(article.querySelector("pre")).toBe(pre);
    expect(article.querySelector("strong").textContent).toBe("完成");
  });

  it("extends an existing table without resetting its scroll container or rows", () => {
    const { article, render } = fixture();
    const prefix = "| 项 | 值 |\n|:---|---:|\n| 第一项 | 1 |";
    render(prefix);
    const wrapper = article.querySelector(".markdown-table"), table = wrapper.querySelector("table");
    const firstRow = table.querySelector("tbody tr");
    wrapper.scrollLeft = 80;
    render(`${prefix}\n| 第二项 | 2 |`);
    expect(article.querySelector(".markdown-table")).toBe(wrapper);
    expect(wrapper.querySelector("table")).toBe(table);
    expect(table.querySelector("tbody tr")).toBe(firstRow);
    expect(wrapper.scrollLeft).toBe(80);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(table.querySelectorAll("td.markdown-align-right")).toHaveLength(2);
  });

  it("applies a late reference definition and can shrink or clear the response", () => {
    const { article, render } = fixture();
    const prefix = "## 参考\n\n查看[资料][source]。";
    render(prefix);
    const heading = article.querySelector("h2"), paragraph = article.querySelector("p");
    expect(article.querySelector("a")).toBeNull();
    render(`${prefix}\n\n[source]: https://example.com/source`);
    expect(article.querySelector("h2")).toBe(heading);
    expect(article.querySelector("p")).toBe(paragraph);
    expect(article.querySelector("a").getAttribute("href")).toBe("https://example.com/source");
    expect(article.querySelector("a").getAttribute("rel")).toBe("noopener noreferrer");

    render("## 参考");
    expect(article.querySelector("h2")).toBe(heading);
    expect(article.querySelector("p")).toBeNull();
    render("");
    expect(article.childNodes).toHaveLength(0);
    render("重新开始。");
    expect(article.querySelector("p").textContent).toBe("重新开始。");
  });

  it("does not replace nodes for identical sources or equivalent rendered Markdown", () => {
    const { article, render } = fixture();
    render("保留 **格式**。");
    const paragraph = article.querySelector("p"), strong = article.querySelector("strong"), text = paragraph.firstChild;
    render("保留 **格式**。");
    render("保留 **格式**。\n\n");
    expect(article.querySelector("p")).toBe(paragraph);
    expect(article.querySelector("strong")).toBe(strong);
    expect(paragraph.firstChild).toBe(text);
  });

  it("matches a fresh render when partial blocks change structure", () => {
    const { article, render } = fixture();
    const stages = [
      "# 标题\n\n| 项 | 值 |",
      "# 标题\n\n| 项 | 值 |\n|---|---|\n| A | **部",
      "# 标题\n\n| 项 | 值 |\n|---|---|\n| A | **部分** |\n\n- 一\n- 二",
      "# 标题\n\n| 项 | 值 |\n|---|---|\n| A | **部分** |\n\n- 一\n\n- 二\n\n[链接][source]",
      "# 标题\n\n| 项 | 值 |\n|---|---|\n| A | **部分** |\n\n- 一\n\n- 二\n\n[链接][source]\n\n[source]: https://example.com",
      "缩短为 `代码` 和 [安全链接](https://example.com) 。",
      "[禁止链接](javascript:alert(1))\n\n```html\n<script>literal</script>\n```",
    ];
    for (const stage of stages) {
      render(stage);
      const fresh = fixture();
      fresh.render(stage);
      expect(article.isEqualNode(fresh.article)).toBe(true);
    }
  });
});
