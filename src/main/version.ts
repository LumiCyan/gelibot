/**
 * 版本比较与更新源校验（纯函数，无 electron 依赖，便于单测）。
 */

/** 把 "v1.17.0" / "1.17.0" 统一成三段式版本号 */
export function normalizeVersion(v: string): string {
  return String(v).trim().replace(/^v/i, '');
}

/** 比较两个版本号：a > b 返回 1，相等 0，小于 -1 */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 更新源地址是否合法（仅 https，或本机回环的 http） */
export function isUpdateUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      const host = u.hostname.toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * GitHub 直连镜像前缀（按优先级排列）。
 * 直连 github.com 失败时，客户端依次用这些前缀重试，提升国内可用性。
 * 仅对 GitHub 域生效；自定义源不做镜像，避免把任意 URL 透传到第三方。
 */
export const GITHUB_MIRROR_PREFIXES: string[] = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
];

/** 判断一个 URL 是否指向 GitHub 官方下载域（可走镜像回退） */
export function isGithubUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'github.com' || host === 'raw.githubusercontent.com'
      || host === 'objects.githubusercontent.com';
  } catch {
    return false;
  }
}

/**
 * 为给定 URL 生成下载候选列表：原 URL 在前，其后是若干镜像前缀版本。
 * 镜像回退只作用于 GitHub 域，且每个候选都必须是合法（https）地址。
 */
export function mirrorCandidates(url: string): string[] {
  if (!isUpdateUrlAllowed(url) || !isGithubUrl(url)) {
    return [url];
  }
  return [url, ...GITHUB_MIRROR_PREFIXES.map((p) => `${p}${url}`)];
}
