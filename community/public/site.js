function isCommunityImage(src) {
  const origin = new URL(src, location.origin).origin;
  return (
    origin === location.origin ||
    origin === document.documentElement.dataset.imageOrigin
  );
}

function enhanceContent() {
  for (const pre of document.querySelectorAll(
    ".prose pre:has(code):not([data-copy-ready])",
  )) {
    pre.dataset.copyReady = "true";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-code";
    button.textContent = "复制代码";
    button.setAttribute("aria-label", "复制这段代码");
    pre.append(button);
  }

  for (const image of document.querySelectorAll(".prose img")) {
    if (!isCommunityImage(image.src) || image.closest("a")) continue;
    const link = document.createElement("a");
    link.className = "image-zoom";
    link.href = image.src;
    link.setAttribute("aria-label", `放大图片：${image.alt || "正文图片"}`);
    image.replaceWith(link);
    link.append(image);
  }
}

const lightbox = document.createElement("dialog");
lightbox.className = "lightbox";
lightbox.setAttribute("aria-label", "图片预览");
const lightboxBar = document.createElement("div");
lightboxBar.className = "lightbox-bar";
const caption = document.createElement("p");
const closeButton = document.createElement("button");
closeButton.type = "button";
closeButton.className = "button";
closeButton.textContent = "关闭";
const fullImage = document.createElement("img");
lightboxBar.append(caption, closeButton);
lightbox.append(lightboxBar, fullImage);
document.body.append(lightbox);
closeButton.addEventListener("click", () => lightbox.close());
lightbox.addEventListener("click", (event) => {
  if (event.target !== lightbox) return;
  const rect = lightbox.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    lightbox.close();
});

document.addEventListener("click", async (event) => {
  const copyButton = event.target.closest(".copy-code");
  if (copyButton) {
    try {
      await navigator.clipboard.writeText(
        copyButton.parentElement.querySelector("code").textContent,
      );
      copyButton.textContent = "已复制";
    } catch {
      copyButton.textContent = "请选择代码手动复制";
    }
    setTimeout(() => {
      copyButton.textContent = "复制代码";
    }, 2200);
    return;
  }

  const link = event.target.closest(".prose a.image-zoom");
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
    return;
  const image = link.querySelector("img");
  if (!isCommunityImage(image.src)) return;
  event.preventDefault();
  fullImage.src = image.src;
  fullImage.alt = image.alt;
  caption.textContent = image.alt || "正文图片";
  lightbox.showModal();
});

document.addEventListener("community:content-updated", enhanceContent);
enhanceContent();

for (const marker of document.querySelectorAll(
  "[data-clear-draft][data-user-id]",
)) {
  try {
    localStorage.removeItem(
      `buildme:draft:${marker.dataset.userId}:${marker.dataset.clearDraft}`,
    );
  } catch {
    const notice = document.createElement("p");
    notice.className = "notice";
    notice.setAttribute("role", "status");
    notice.textContent =
      "发布成功。浏览器无法清除对应的本地草稿，下次写作时可选择丢弃。";
    document.querySelector(".page").prepend(notice);
  }
}
