import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import sanitizeHtml from "sanitize-html";
import { parseHTML } from "linkedom";
import type { Db } from "../db/index.js";
import { usernameKey } from "./validation.js";
export interface Heading {
  id: string;
  level: number;
  text: string;
}
export function renderMarkdown(db: Db, body: string, siteUrl: string) {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    highlight: (code, language) =>
      language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language }).value
        : "",
  }).use(taskLists);
  const escape = md.utils.escapeHtml;
  const toc: Heading[] = [];
  const imageIds = new Set<string>();
  let imageCount = 0;
  const imageRule = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, index, options, env, self) => {
    imageCount++;
    const token = tokens[index],
      src = token.attrGet("src") ?? "";
    let source = src;
    try {
      const url = new URL(src, siteUrl);
      if (url.origin === siteUrl) source = url.pathname;
    } catch {
      return escape(token.content);
    }
    const image = db
      .prepare("SELECT id,url FROM images WHERE url=?")
      .get(source) as { id: string; url: string } | undefined;
    if (!image)
      return `<a href="${escape(src)}" target="_blank" rel="nofollow noopener ugc">${escape(token.content || "外站图片")}</a>`;
    imageIds.add(image.id);
    token.attrSet("src", image.url);
    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");
    return imageRule(tokens, index, options, env, self);
  };
  md.renderer.rules.link_open = (tokens, index, _options, _env, self) => {
    tokens[index].attrSet("rel", "nofollow noopener ugc");
    tokens[index].attrSet("target", "_blank");
    return self.renderToken(tokens, index, _options);
  };
  const textRule = md.renderer.rules.text!;
  md.renderer.rules.text = (tokens, index, options, env, self) => {
    const content = tokens[index].content;
    let inLink = false;
    for (let j = 0; j < index; j++) {
      if (tokens[j].type === "link_open") inLink = true;
      if (tokens[j].type === "link_close") inLink = false;
    }
    if (inLink) return textRule(tokens, index, options, env, self);
    return escape(content).replace(
      /@([\p{Script=Han}A-Za-z0-9_]{2,16})/gu,
      (match, name) => {
        const user = db
          .prepare(
            "SELECT id,username FROM users WHERE username_key=? AND banned=0 AND profile_pending=0",
          )
          .get(usernameKey(name)) as
          { id: number; username: string } | undefined;
        return user
          ? `<a href="/u/${user.id}" rel="nofollow noopener ugc">@${escape(user.username)}</a>`
          : match;
      },
    );
  };
  md.renderer.rules.heading_open = (tokens, index, options, _env, self) => {
    const id = `heading-${toc.length + 1}`;
    tokens[index].attrSet("id", id);
    toc.push({
      id,
      level: Number(tokens[index].tag.slice(1)),
      text:
        tokens[index + 1].children
          ?.filter((t) => ["text", "code_inline"].includes(t.type))
          .map((t) => t.content)
          .join("") ?? tokens[index + 1].content,
    });
    return self.renderToken(tokens, index, options);
  };
  const html = sanitizeHtml(md.render(body), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "input", "del"],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "title", "loading", "decoding"],
      code: ["class"],
      span: ["class"],
      input: ["type", "checked", "disabled"],
      li: ["class"],
      ul: ["class"],
      h1: ["id"],
      h2: ["id"],
      h3: ["id"],
      h4: ["id"],
      h5: ["id"],
      h6: ["id"],
      th: ["align"],
      td: ["align"],
    },
    allowedSchemes: ["http", "https"],
    allowProtocolRelative: false,
    transformTags: {
      input: (_tag, attrs) => ({
        tagName: "input",
        attribs: {
          type: "checkbox",
          disabled: "",
          ...(Object.hasOwn(attrs, "checked") ? { checked: "" } : {}),
        },
      }),
    },
  });
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const excerpt = Array.from(document.querySelectorAll("body > *"))
    .map((el) => el.textContent)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return { html, toc, excerpt, imageIds: [...imageIds], imageCount };
}
export function referenceImages(
  db: Db,
  kind: string,
  id: number,
  imageIds: string[],
) {
  db.prepare("DELETE FROM image_refs WHERE kind=? AND entity_id=?").run(
    kind,
    id,
  );
  const insert = db.prepare("INSERT OR IGNORE INTO image_refs VALUES (?,?,?)");
  for (const imageId of imageIds) insert.run(imageId, kind, id);
}
