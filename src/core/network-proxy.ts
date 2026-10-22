import http from "node:http";

/**
 * Node's built-in fetch ignores HTTP(S)_PROXY unless NODE_USE_ENV_PROXY=1.
 * BuildMe's web tools and every model SDK call go through fetch, so behind a
 * proxy (common for students in mainland China) nothing would connect.
 * `http.setGlobalProxyFromEnv` (Node >= 24.5) routes http, https and fetch
 * through the proxy described by the environment.
 */

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

type SetGlobalProxyFromEnv = (env?: NodeJS.ProcessEnv) => () => void;

export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return PROXY_KEYS.some((key) => Boolean(env[key]?.trim()));
}

/** Apply the proxy from `env` to http, https and fetch. Returns whether a proxy was applied. */
export function applyProxyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	if (!hasProxyEnv(env)) return false;
	const setter = (http as unknown as { setGlobalProxyFromEnv?: SetGlobalProxyFromEnv }).setGlobalProxyFromEnv;
	if (typeof setter !== "function") return false;
	setter({ ...env, NO_PROXY: env.NO_PROXY ?? env.no_proxy ?? DEFAULT_NO_PROXY });
	return true;
}

/**
 * Convert a Chromium PAC result such as "PROXY 127.0.0.1:7890; DIRECT" into an
 * HTTP proxy URL. Node's env proxy only speaks HTTP CONNECT, so SOCKS-only
 * results are ignored (Clash/V2Ray "mixed" ports also accept HTTP).
 */
export function proxyUrlFromPac(pac: string): string | undefined {
	for (const rule of pac.split(";")) {
		const [kind, hostPort] = rule.trim().split(/\s+/u);
		if (!kind || !hostPort) continue;
		const upper = kind.toUpperCase();
		if (upper === "PROXY" || upper === "HTTP") return `http://${hostPort}`;
		if (upper === "HTTPS") return `https://${hostPort}`;
	}
	return undefined;
}
