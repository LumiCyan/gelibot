/**
 * 更新器纯函数测试：版本比较与更新源校验。
 * 只测 src/main/version.ts（无 electron 依赖），保证核心逻辑可独立验证。
 *
 * 运行：npm test（会先 build:main）
 */
const { compareVersions, normalizeVersion, isUpdateUrlAllowed, isGithubUrl, mirrorCandidates, GITHUB_MIRROR_PREFIXES } =
  require('../../dist/main/version.js');

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
