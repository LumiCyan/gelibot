import fs from 'node:fs';
import path from 'node:path';

/**
 * 数据目录解析。
 *
 * 背景：Electron 的 `app.getPath('userData')` = `%APPDATA%/<产品名>`，
 * 也就是数据位置**绑死在产品名上**。历史上产品名改过三次
 * （GeLiCraft → gelibot → GeLi Bot），于是 `%APPDATA%` 下留下了三个互不相通的
 * 目录，用户每换一次名字就等于重装。更糟的是这一切是静默的。
 *
 * 这里加一条更稳的规则：**程序目录下如果存在 `data/config.json`，就以它为准。**
 * 用户把 data 文件夹和 exe 放在一起，换任何版本、任何电脑，配置都是同一份。
 *
 * 便携版的坑：electron-builder 的 portable 目标会把应用解压到 `%TEMP%` 再运行，
 * 所以 `app.getPath('exe')` 指向临时目录，**必须**优先读 `PORTABLE_EXECUTABLE_DIR`
 * （由 portable.nsi 注入，值是用户放 exe 的那个文件夹）。
 */

export type DataDirSource = 'portable' | 'user';

export const DATA_SUBDIR = 'data';

export interface DataDirProbe {
  /**
   * 「程序目录」：
   * - 便携版 = 用户放 exe 的文件夹（PORTABLE_EXECUTABLE_DIR）
   * - 安装版 = 安装目录
   * - 开发模式 = null（不参与判断，避免误吃 node_modules 里的目录）
   */
  portableDir: string | null;
  /** 系统用户数据目录：`%APPDATA%/GeLi Bot` */
  userDataDir: string;
}

export interface DataDirDecision {
  /** 实际使用的 data 目录（绝对路径） */
  dir: string;
  source: DataDirSource;
  /** 决策原因，直接展示给用户看 */
  reason: string;
  /** 需要提醒用户的异常（例如程序目录不可写）*/
  warning?: string;
}

/** 挑选「程序目录」。portableDir 环境变量优先，其次才是 exe 所在目录。 */
export function pickPortableDir(opts: {
  portableEnv?: string | undefined;
  exePath: string;
  isPackaged: boolean;
}): string | null {
  const fromEnv = (opts.portableEnv ?? '').trim();
  if (fromEnv) return fromEnv;
  // 开发模式（从源码运行）不认 exe 目录，否则会指向 node_modules/electron/dist
  if (!opts.isPackaged) return null;
  return path.dirname(opts.exePath);
}

/**
 * 程序目录下的 data 目录，**仅当其中已有 config.json 时**才算数。
 * 这样「用户主动把 data 放过去」才生效，不会因为程序刚好装在某个碰巧叫 data
 * 的目录旁边而误判。
 */
export function sidecarDataDir(portableDir: string | null): string | null {
  if (!portableDir) return null;
  const dir = path.join(portableDir, DATA_SUBDIR);
  return fs.existsSync(path.join(dir, 'config.json')) ? dir : null;
}

/** 目录是否可写（顺带把缺失的目录建出来）*/
export function isDirWritable(dir: string): boolean {
  const probe = path.join(dir, `.gelibot-write-test-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      /* 清不掉也无所谓，名字是唯一的 */
    }
  }
}

/**
 * 决定本次运行使用哪个数据目录。
 * `writable` 参数是为了单元测试能注入假实现。
 */
export function resolveDataDir(
  probe: DataDirProbe,
  writable: (dir: string) => boolean = isDirWritable,
): DataDirDecision {
  const fallback = path.join(probe.userDataDir, DATA_SUBDIR);
  const sidecar = sidecarDataDir(probe.portableDir);

  if (!sidecar) {
    return {
      dir: fallback,
      source: 'user',
      reason: probe.portableDir
        ? '程序目录下没有 data 文件夹，配置保存在系统用户目录'
        : '配置保存在系统用户目录',
    };
  }

  if (writable(sidecar)) {
    return {
      dir: sidecar,
      source: 'portable',
      reason: '程序目录下存在 data 文件夹，配置跟随程序',
    };
  }

  // 只读位置（Program Files、光盘、只读 U 盘）→ 回退，否则保存会静默失败
  return {
    dir: fallback,
    source: 'user',
    reason: '程序目录下的 data 文件夹不可写，本次回退到系统用户目录',
    warning:
      `程序目录下的 data 文件夹不可写（${sidecar}），本次改用系统用户目录，` +
      '你刚才的修改不会写进程序目录。请把程序移到有写入权限的位置。',
  };
}

export type MovePlan =
  | { ok: true; target: string }
  | { ok: false; error: string };

/** 规划「把配置存到程序目录」，只做检查，不动文件 */
export function planMoveToPortable(opts: {
  portableDir: string | null;
  currentDir: string;
}): MovePlan {
  if (!opts.portableDir) {
    return {
      ok: false,
      error: '当前运行方式没有可用的程序目录（只有打包后的绿色版 / 安装版支持）',
    };
  }
  const target = path.join(opts.portableDir, DATA_SUBDIR);
  if (path.resolve(target) === path.resolve(opts.currentDir)) {
    return { ok: false, error: '配置已经在程序目录下了，无需再移动' };
  }
  if (fs.existsSync(target)) {
    return {
      ok: false,
      error: `程序目录下已经存在 data 文件夹（${target}）。为避免覆盖，请先手动移走它再继续`,
    };
  }
  if (!isDirWritable(opts.portableDir)) {
    return {
      ok: false,
      error: `程序目录不可写（${opts.portableDir}），请把程序移到有写入权限的位置`,
    };
  }
  return { ok: true, target };
}

/**
 * 把当前数据目录整体复制到程序目录。
 * 先写进同级的临时目录再改名，避免半途失败留下一个「残缺但会被优先使用」的 data。
 */
export function moveDataToPortable(currentDir: string, target: string): void {
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  try {
    fs.cpSync(currentDir, staging, { recursive: true });
    fs.renameSync(staging, target);
  } catch (err) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}
