/**
 * 更新器纯函数测试：版本比较与更新源校验。
 * 只测 src/main/version.ts（无 electron 依赖），保证核心逻辑可独立验证。
 *
 * 运行：npm test（会先 build:main）
 */
const {
  compareVersions,
  normalizeVersion,
  isUpdateUrlAllowed,
  isGithubUrl,
  mirrorCandidates,
  GITHUB_MIRROR_PREFIXES,
  normalizeRepo,
  githubReleaseBase,
  DEFAULT_GITHUB_REPO,
  resolveUpdateAssetUrl,
} = require('../../dist/main/version.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  ✘ ${name}${extra ? '：' + extra : ''}`);
  }
}

// ---------- normalizeVersion ----------
check('normalize 去 v 前缀', normalizeVersion('v1.17.0') === '1.17.0');
check('normalize 保留无 v', normalizeVersion('1.17.0') === '1.17.0');
check('normalize 去空白', normalizeVersion('  1.2.3  ') === '1.2.3');

// ---------- compareVersions ----------
check('相等', compareVersions('1.17.0', '1.17.0') === 0);
check('a > b 基本', compareVersions('1.18.0', '1.17.0') === 1);
check('a < b 基本', compareVersions('1.16.0', '1.17.0') === -1);
check('次版本号比较', compareVersions('1.10.0', '1.9.0') === 1);
check('忽略 v 前缀', compareVersions('v1.18.0', '1.17.0') === 1);
check('不等长补零', compareVersions('1.18', '1.17.3') === 1);
check('不等长补零 2', compareVersions('1.17', '1.17.0') === 0);
check('大版本跃迁', compareVersions('2.0.0', '1.99.99') === 1);
check('非数字段按 0', compareVersions('1.x.0', '1.0.0') === 0);

// ---------- isUpdateUrlAllowed ----------
check('https 允许', isUpdateUrlAllowed('https://github.com/a/b') === true);
check('http 回环允许', isUpdateUrlAllowed('http://127.0.0.1:8080/x') === true);
check('http localhost 允许', isUpdateUrlAllowed('http://localhost/x') === true);
check('http 公网拒绝', isUpdateUrlAllowed('http://example.com/x') === false);
check('ftp 拒绝', isUpdateUrlAllowed('ftp://example.com/x') === false);
check('非法 URL 拒绝', isUpdateUrlAllowed('not a url') === false);
check('空串拒绝', isUpdateUrlAllowed('') === false);

// ---------- normalizeRepo ----------
// 这一组全是「用户实际会填的写法」：整条网址、带 .git、带空格、大小写混排。
// 拼地址时曾经直接把 repoUrl 当 URL 前缀用，导致
// `lumicyan/gelibot/GeLi-Bot-v2.0.1.exe` 这种不是 URL 的字符串被送进下载器。
check('repo 已规范格式原样', normalizeRepo('LumiCyan/gelibot') === 'LumiCyan/gelibot');
check('repo 去首尾空白', normalizeRepo('  LumiCyan/gelibot  ') === 'LumiCyan/gelibot');
check('repo 保留大小写', normalizeRepo('LumiCyan/gelibot') !== 'lumicyan/gelibot');
check('repo 接受整条网址', normalizeRepo('https://github.com/LumiCyan/gelibot') === 'LumiCyan/gelibot');
check('repo 接受带 .git', normalizeRepo('https://github.com/LumiCyan/gelibot.git') === 'LumiCyan/gelibot');
check('repo 接受 SSH 写法', normalizeRepo('git@github.com:LumiCyan/gelibot.git') === 'LumiCyan/gelibot');
check('repo 去尾部斜杠', normalizeRepo('LumiCyan/gelibot/') === 'LumiCyan/gelibot');
check('repo 去多余斜杠', normalizeRepo('/LumiCyan/gelibot//') === 'LumiCyan/gelibot');
check('repo 空值返回空串', normalizeRepo('') === '');
check('repo undefined 返回空串', normalizeRepo(undefined) === '');
check('repo 只有仓库名不合法', normalizeRepo('gelibot') === '');
check('repo 三段路径不合法', normalizeRepo('a/b/c') === '');
check('repo 中文 owner 不合法', normalizeRepo('立哥/gelibot') === '');
check('repo 含空格 owner 不合法', normalizeRepo('lumi cyan/gelibot') === '');

// ---------- githubReleaseBase ----------
check('默认仓库常量正确', DEFAULT_GITHUB_REPO === 'LumiCyan/gelibot');
check(
  '有版本号钉到 tag',
  githubReleaseBase('LumiCyan/gelibot', '2.0.1') ===
    'https://github.com/LumiCyan/gelibot/releases/download/v2.0.1',
);
check(
  '版本号带 v 前缀不重复',
  githubReleaseBase('LumiCyan/gelibot', 'v2.0.1') ===
    'https://github.com/LumiCyan/gelibot/releases/download/v2.0.1',
);
check(
  '无版本号走 latest',
  githubReleaseBase('LumiCyan/gelibot') ===
    'https://github.com/LumiCyan/gelibot/releases/latest/download',
);
check(
  '空仓库回落到默认',
  githubReleaseBase('', '2.0.1') ===
    'https://github.com/LumiCyan/gelibot/releases/download/v2.0.1',
);
check(
  'repo 写法脏也能拼对',
  githubReleaseBase('https://github.com/LumiCyan/gelibot.git', '2.0.1') ===
    'https://github.com/LumiCyan/gelibot/releases/download/v2.0.1',
);
check(
  '拼出的地址通过合法性校验',
  isUpdateUrlAllowed(`${githubReleaseBase('LumiCyan/gelibot', '2.0.1')}/GeLi-Bot-v2.0.1.exe`) === true,
);
// 回归：曾经拼成 `lumicyan/gelibot/x.exe`（没有 https，不是 URL）
check(
  '回归：裸 owner/repo 拼出来的不是 URL',
  isUpdateUrlAllowed('lumicyan/gelibot/GeLi-Bot-v2.0.1.exe') === false,
);

// ---------- resolveUpdateAssetUrl（这次的线上事故就是它） ----------
// 复现现场：便携版、清单里 exeUrl 只写文件名、repoUrl 填的是 owner/name。
// 旧实现会拼出 `lumicyan/gelibot/GeLi-Bot-v2.0.1.exe` → 下载器判「地址不合法」。
{
  const ghChannel = { customUrl: '', repoUrl: 'lumicyan/gelibot' };
  const exe = resolveUpdateAssetUrl(ghChannel, 'GeLi-Bot-v2.0.1.exe', '2.0.1');
  check(
    'GitHub 相对文件名 → 完整下载地址',
    exe === 'https://github.com/lumicyan/gelibot/releases/download/v2.0.1/GeLi-Bot-v2.0.1.exe',
    exe,
  );
  check('解析结果通过合法性校验', isUpdateUrlAllowed(exe) === true, exe);
  check(
    'asar 相对名同样能解析',
    resolveUpdateAssetUrl(ghChannel, 'app-2.0.1.asar', '2.0.1') ===
      'https://github.com/lumicyan/gelibot/releases/download/v2.0.1/app-2.0.1.asar',
  );
  check(
    '差量包相对名同样能解析',
    resolveUpdateAssetUrl(ghChannel, 'app-2.0.0-to-2.0.1.patch', '2.0.1').endsWith(
      '/releases/download/v2.0.1/app-2.0.0-to-2.0.1.patch',
    ),
  );
  check(
    '绝对地址原样放行（老客户端靠这条才能修好）',
    resolveUpdateAssetUrl(ghChannel, exe, '2.0.1') === exe,
  );
  check(
    '绝对地址不被二次拼接',
    resolveUpdateAssetUrl(ghChannel, 'https://cdn.example.com/x.exe', '2.0.1') ===
      'https://cdn.example.com/x.exe',
  );
  check('空文件名返回空串', resolveUpdateAssetUrl(ghChannel, '', '2.0.1') === '');
  check('undefined 返回空串', resolveUpdateAssetUrl(ghChannel, undefined, '2.0.1') === '');
  check(
    '无版本号走 latest',
    resolveUpdateAssetUrl({ customUrl: '', repoUrl: '' }, 'x.exe') ===
      'https://github.com/LumiCyan/gelibot/releases/latest/download/x.exe',
  );
  check(
    '仓库名写脏也拼对',
    resolveUpdateAssetUrl({ customUrl: '', repoUrl: ' https://github.com/LumiCyan/gelibot.git ' }, 'x.exe', '2.0.1') ===
      'https://github.com/LumiCyan/gelibot/releases/download/v2.0.1/x.exe',
  );
}
{
  const custom = { customUrl: 'https://up.example.com/gelibot/', repoUrl: 'Ignored/repo' };
  check(
    '自定义源优先且去尾斜杠',
    resolveUpdateAssetUrl(custom, 'app-2.0.1.asar', '2.0.1') ===
      'https://up.example.com/gelibot/app-2.0.1.asar',
  );
  check(
    '自定义源下绝对地址仍原样放行',
    resolveUpdateAssetUrl(custom, 'https://other.example.com/a.exe') ===
      'https://other.example.com/a.exe',
  );
}
{
  const local = { customUrl: 'http://127.0.0.1:8080/up', repoUrl: '' };
  check(
    '回环静态源可用（本地测试）',
    isUpdateUrlAllowed(resolveUpdateAssetUrl(local, 'x.exe', '2.0.1')) === true,
  );
}

// ---------- isGithubUrl ----------
check('github.com 是 GitHub 域', isGithubUrl('https://github.com/a/b') === true);
check('raw.githubusercontent 是 GitHub 域', isGithubUrl('https://raw.githubusercontent.com/a/b') === true);
check('objects.githubusercontent 是 GitHub 域', isGithubUrl('https://objects.githubusercontent.com/x') === true);
check('自定义源非 GitHub 域', isGithubUrl('https://my-oss.example.com/x') === false);
check('非法 URL 非 GitHub 域', isGithubUrl('not a url') === false);

// ---------- mirrorCandidates ----------
{
  const gh = 'https://github.com/lumicyan/gelibot/releases/latest/download/release-manifest.json';
  const cands = mirrorCandidates(gh);
  check('GitHub URL 生成镜像候选', cands.length === 1 + GITHUB_MIRROR_PREFIXES.length);
  check('原 URL 排在首位', cands[0] === gh);
  check('镜像候选带前缀', cands[1] === GITHUB_MIRROR_PREFIXES[0] + gh);
  check('所有候选均 https 合法', cands.every((c) => isUpdateUrlAllowed(c)));
}
{
  const custom = 'https://my-oss.example.com/release-manifest.json';
  const cands = mirrorCandidates(custom);
  check('自定义源不生成镜像', cands.length === 1 && cands[0] === custom);
}
{
  const local = 'http://127.0.0.1:8080/x';
  const cands = mirrorCandidates(local);
  check('回环 http 不生成镜像', cands.length === 1 && cands[0] === local);
}
{
  const bad = 'http://example.com/x';
  const cands = mirrorCandidates(bad);
  check('非 https 公网只返回原 URL', cands.length === 1 && cands[0] === bad);
}

console.log(`更新器测试：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
