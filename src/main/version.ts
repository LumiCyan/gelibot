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

/** 默认 GitHub 仓库（owner/name） */
export const DEFAULT_GITHUB_REPO = 'LumiCyan/gelibot';

/**
 * 把用户填写的仓库标识归一化成 `owner/name`。
 *
 * 为什么要归一化：这个值会直接拼进下载地址，而用户（以及我们自己）很容易
 * 粘贴成整条网页地址 `https://github.com/LumiCyan/gelibot`、带 `.git` 后缀、
 * 或者首尾带空格/斜杠。不归一化就会拼出 `lumi cyan/gelibot/xxx.exe`
 * 这种根本不是 URL 的东西 —— 更新器只能在最后一步报「地址不合法」，
 * 用户完全看不出是配置写错了。
 *
 * 无法识别时返回空串，调用方据此给出可读的错误提示，而不是拼出一个坏地址。
 */
export function normalizeRepo(input: string | undefined | null): string {
  let s = String(input ?? '').trim();
  if (!s) return '';
  // https://github.com/owner/name(.git) → owner/name
  s = s.replace(/^[a-z]+:\/\/[^/]+\//i, '');
  // git@github.com:owner/name.git → owner/name
  s = s.replace(/^[^@]+@[^:]+:/, '');
  // 去掉末尾的 .git 与首尾斜杠，保留内部结构
  s = s.replace(/\.git$/i, '').replace(/[/]+$/, '').replace(/^[/]+/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length !== 2) return '';
  const [owner, name] = parts;
  // GitHub 的 owner 只允许字母数字与连字符；仓库名额外允许 . _ -
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return '';
  return `${owner}/${name}`;
}

/**
 * 拼 GitHub 发布附件的下载前缀。
 *
 * 有版本号就钉到具体 tag（`releases/download/v2.0.1`），没有则用 latest。
 * 钉 tag 的原因：检查更新拿到的是「某个版本」的清单，附件必须来自同一个
 * release，否则 latest 又往前发了一版时，清单与附件会错位。
 */
export function githubReleaseBase(repo: string | undefined, version?: string): string {
  const r = normalizeRepo(repo) || DEFAULT_GITHUB_REPO;
  const v = normalizeVersion(version ?? '');
  if (!v) return `https://github.com/${r}/releases/latest/download`;
  return `https://github.com/${r}/releases/download/v${v}`;
}

/** 自定义静态源基础地址（去尾斜杠）；未配置返回空串 */
export function customBaseUrl(channel: { customUrl?: string }): string {
  return String(channel.customUrl ?? '').trim().replace(/\/+$/, '');
}

/**
 * 把清单里的附件地址解析成真正能下载的绝对 URL。
 *
 * 清单里的 url 通常只写文件名（`app-2.0.1.asar`、`GeLi-Bot-v2.0.1.exe`），
 * 必须拼成绝对地址才能交给下载器。三个分支缺一不可：
 * 1. 已是绝对地址 —— 原样放行（清单写绝对地址是最稳的写法，也是现在发布脚本的做法）；
 * 2. 配了自定义静态源 —— 拼到该源根目录下；
 * 3. 走 GitHub —— 拼成 `https://github.com/<owner>/<repo>/releases/download/v<版本>/<文件名>`。
 *
 * 第 3 条曾经写错成「拼到 baseUrl」，而 GitHub 模式下 baseUrl 只有
 * `owner/repo`，于是产出 `lumicyan/gelibot/GeLi-Bot-v2.0.1.exe` ——
 * 不是 URL，`isUpdateUrlAllowed` 一律拒绝，更新就卡在「地址不合法」。
 *
 * 仓库名非法时返回空串（调用方会报「地址不合法」），绝不拼一个坏地址出去。
 */
export function resolveUpdateAssetUrl(
  channel: { customUrl?: string; repoUrl?: string },
  asset: string | undefined,
  version?: string,
): string {
  const raw = String(asset ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;

  const rel = raw.replace(/^\/+/, '');
  const custom = customBaseUrl(channel);
  if (custom) return `${custom}/${rel}`;

  const repo = normalizeRepo(channel.repoUrl) || DEFAULT_GITHUB_REPO;
  return `${githubReleaseBase(repo, version)}/${rel}`;
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
