export class FormError extends Error {
  constructor(
    message: string,
    public fields: Record<string, string> = {},
    public status: 400 | 403 | 404 | 409 | 422 | 429 = 422,
  ) {
    super(message);
  }
}
export function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
export function length(text: string) {
  return [...text].length;
}
export function usernameKey(name: string) {
  return name.normalize("NFKC").toLowerCase();
}
export function validateUsername(value: string) {
  if (!/^[\p{Script=Han}A-Za-z0-9_]{2,16}$/u.test(value))
    throw new FormError("请检查用户名", {
      username: "用户名需为 2–16 个中文、字母、数字或下划线",
    });
}
export function validatePassword(value: string) {
  if (length(value) < 8 || Buffer.byteLength(value) > 1024)
    throw new FormError("请检查密码", {
      password: "密码至少 8 位，最多 1024 字节",
    });
}
export function httpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FormError("请填写有效网址", {
      link: "链接只接受 http 或 https 地址",
    });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new FormError("请填写有效网址", {
      link: "链接只接受不含账号密码的 http 或 https 地址",
    });
  return url.href;
}
