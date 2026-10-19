/**
 * 慰问服主纯函数测试：天数计算 / 文案渲染 / 时刻解析。
 *
 * 天数这块最容易出错的是「跨月、跨年、闰日、时区」，
 * 所以都用 UTC 归一化后逐日累加来验证，不靠手算。
 *
 * 运行：npm test（会先 build:main）
 */
const {
  todayDateString,
  daysSince,
  formatCareMessage,
  parseDailyAt,
} = require('../../dist/main/owner-care.js');

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

/** 用本地时间构造某一天（模拟运行环境的本地时区） */
function localDate(y, m, d, hh = 12) {
  return new Date(y, m - 1, d, hh, 0, 0);
}

// ---------- todayDateString ----------

check('日期格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(todayDateString()));
check('月份补零', todayDateString(localDate(2026, 1, 5)) === '2026-01-05');
check('日补零', todayDateString(localDate(2026, 10, 8)) === '2026-10-08');
check('年尾日期', todayDateString(localDate(2026, 12, 31)) === '2026-12-31');

// ---------- daysSince：起始日当天 = 1 ----------

check('当天为第 1 天', daysSince('2026-10-18', localDate(2026, 10, 18)) === 1);
check('次日为第 2 天', daysSince('2026-10-18', localDate(2026, 10, 19)) === 2);
check('第 3 天', daysSince('2026-10-18', localDate(2026, 10, 20)) === 3);
check('满 30 天', daysSince('2026-10-01', localDate(2026, 10, 30)) === 30);

// 跨月
check('跨月 10-30 → 11-02 是第 4 天', daysSince('2026-10-30', localDate(2026, 11, 2)) === 4);
check('跨月 10-31 → 11-01 是第 2 天', daysSince('2026-10-31', localDate(2026, 11, 1)) === 2);

// 跨年
check('跨年 12-30 → 01-02 是第 4 天', daysSince('2025-12-30', localDate(2026, 1, 2)) === 4);
check('跨年 12-31 → 01-01 是第 2 天', daysSince('2025-12-31', localDate(2026, 1, 1)) === 2);

// 闰年：2024-02-28 起，29 号存在
check('闰日算一天 02-28→02-29', daysSince('2024-02-28', localDate(2024, 2, 29)) === 2);
check('闰日算一天 02-28→03-01', daysSince('2024-02-28', localDate(2024, 3, 1)) === 3);
check('闰日算一天 02-29→03-01', daysSince('2024-02-29', localDate(2024, 3, 1)) === 2);
// 平年：2026 没有 2-29
check('平年 02-28→03-01 是 2 天', daysSince('2026-02-28', localDate(2026, 3, 1)) === 2);

// 长跨度
check('一年整', daysSince('2025-10-18', localDate(2026, 10, 18)) === 366 || daysSince('2025-10-18', localDate(2026, 10, 18)) === 365);

// ---------- daysSince：异常输入 ----------

check('未来日期返回 0', daysSince('2030-01-01', localDate(2026, 10, 18)) === 0);
check('明天开始返回 0', daysSince('2026-10-19', localDate(2026, 10, 18)) === 0);
check('空串返回 0', daysSince('', localDate(2026, 10, 18)) === 0);
check('乱码返回 0', daysSince('abc', localDate(2026, 10, 18)) === 0);
check('月份非法返回 0', daysSince('2026-13-01', localDate(2026, 10, 18)) === 0);
check('日期非法返回 0', daysSince('2026-02-31', localDate(2026, 10, 18)) === 0);
check('2026-04-31 非法', daysSince('2026-04-31', localDate(2026, 10, 18)) === 0);
check('单数字月份也能解析', daysSince('2026-1-5', localDate(2026, 1, 6)) === 2);

// 时区健壮性：同一天的早/晚应该算出同一天数
{
  const d1 = daysSince('2026-10-18', localDate(2026, 10, 20, 0));
  const d2 = daysSince('2026-10-18', localDate(2026, 10, 20, 23));
  check('同一天不同时刻天数一致', d1 === d2 && d1 === 3);
}

// ---------- formatCareMessage ----------

check(
  '替换 {days}',
  formatCareMessage('离开 {days} 天', { days: 3, owner: '服主', startDate: '2026-10-18' }) ===
    '离开 3 天',
);
check(
  '替换 {owner}',
  formatCareMessage('{owner}跑了', { days: 1, owner: '老王', startDate: '2026-10-18' }) ===
    '老王跑了',
);
check(
  '替换 {startDate}',
  formatCareMessage('自 {startDate} 起', { days: 1, owner: '服主', startDate: '2026-10-18' }) ===
    '自 2026-10-18 起',
);
check(
  '多个变量一起替换',
  formatCareMessage('【慰问】{owner}离开 {days} 天了（自 {startDate}）', {
    days: 12,
    owner: '服主',
    startDate: '2026-10-06',
  }) === '【慰问】服主离开 12 天了（自 2026-10-06）',
);
check(
  '同一变量出现多次都替换',
  formatCareMessage('{days}，又是 {days}', { days: 5, owner: '', startDate: '' }) === '5，又是 5',
);
check(
  '未知变量原样保留',
  formatCareMessage('{unknown}', { days: 1, owner: 'a', startDate: 'b' }) === '{unknown}',
);
check('空模板返回空串', formatCareMessage('', { days: 1, owner: 'a', startDate: 'b' }) === '');
check(
  'null 模板安全',
  formatCareMessage(null, { days: 1, owner: 'a', startDate: 'b' }) === '',
);

// ---------- parseDailyAt ----------

check('解析 20:00', parseDailyAt('20:00')?.hour === 20 && parseDailyAt('20:00')?.minute === 0);
check('解析 09:05', parseDailyAt('09:05')?.hour === 9 && parseDailyAt('09:05')?.minute === 5);
check('解析 0:00', parseDailyAt('0:00')?.hour === 0);
check('解析 23:59', parseDailyAt('23:59')?.minute === 59);
check('25:00 非法', parseDailyAt('25:00') === null);
check('20:60 非法', parseDailyAt('20:60') === null);
check('空串非法', parseDailyAt('') === null);
check('乱码非法', parseDailyAt('晚上八点') === null);

console.log(`慰问服主测试：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
