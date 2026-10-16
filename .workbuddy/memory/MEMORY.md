# GeLi Bot —— 项目长期记忆

## 项目定位

Windows 桌面端 Electron 应用：把 QQ（经 SnowLuma / OneBot v11）与 Minecraft Java 服务器
（经 RCON）打通，并管理 QQ ↔ 游戏玩家 ID 的绑定。

- 仓库：https://github.com/LumiCyan/gelibot （public，默认分支 main）
- 开源协议：MIT（`LICENSE`，Copyright (c) 2026 LumiCyan）
- 产品名 / appId：`GeLi Bot` / `cn.gelibot.bridge`
- 名字由来：图标是**鸽子**，「GeLi」即「鸽力」谐音 —— 改图标时别再写成鸭子

## 构建与打包

| 命令 | 说明 |
| ---- | ---- |
| `npm run build` | tsc 主进程 + esbuild 渲染进程 + 拷贝资源 |
| `npm run dist` | **完整打包，走 `scripts/build-release.mjs`（不要直接调 electron-builder）** |
| `npm run dist:dir` | 只出免压缩目录，快速验证 |
| `npm test` | 491 项单元测试 |
| `npm run icon` | 重新生成图标（`make-icon.py` + `make-ui-assets.py`） |
| `npm run fetch:snowluma` | 按需拉取内置 SnowLuma 运行包 |

### 打包的硬约束（改动前务必读）

1. **`signAndEditExecutable` 必须为 `true`**。它在 `winPackager.signApp()` 里是一票否决，
   设为 `false` 会导致 exe 图标根本不写入（v1.15.0 就是这么中招的）。
2. **但打开它就必须给 app-builder 打补丁**，否则解压 winCodeSign 时因
   「无法创建 macOS 符号链接（客户端没有所需的特权）」以退出码 2 失败。
   `scripts/build-release.mjs` 的做法：把 `app-builder.exe` 里唯一的 `-snld`
   等长替换为 `-snl-`（都是 5 字节，偏移约 9019367），用 `CUSTOM_APP_BUILDER_PATH` 挂载。
   这是「先发 github，之后再改」的前提 —— 别把 `npm run dist` 改回裸 electron-builder。
3. **每次打包用全新的 `GC_OUT_DIR`**。运行环境会拦截一次性大量删除
   （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，阈值 50；electron-builder 清输出目录时超限）。
   换新目录名即可绕开，不需要先删旧的。
4. **校验内嵌图标**：`python scripts/verify-exe-icon.py "dist-release-*/win-unpacked/GeLi Bot.exe"`，
   期望 7 档全部 `OK`。

## 网络环境（本机特有，容易误判）

- 访问任何 HTTPS 报 `HTTP 000` 且响应体为空 → 优先怀疑
  `CRYPT_E_NO_REVOCATION_CHECK (0x80092012)`，而不是网络不通。
  - curl 加 `--ssl-no-revoke`
  - git 需要**持久写入**配置：`git config http.sslBackend schannel` +
    `git config http.schannelCheckRevoke false`（`-c` 内联传参不够）
- Node 在 Git Bash 下把 `/tmp` 解析成 `D:\tmp`。临时文件一律放项目内 `.stage/`。
- electron-builder 二进制走 npmmirror 镜像（`ELECTRON_BUILDER_BINARIES_MIRROR`）。

## 安全红线

以下目录**绝不能提交**（已在 `.gitignore`，改动 .gitignore 时勿删）：

- `config/` —— 含 SnowLuma 真实 `accessToken`
- `logs/` —— 含账号信息，单文件可达 52 MB
- `data/` —— 本地运行数据
- `snowluma/` —— 97 MB 第三方运行包，用 `fetch:snowluma` 拉取
- `.stage/` —— 打包/调试临时目录

推送时不要把 token 写进 `git remote` 的 URL（会落到 `.git/config`）。
用一次性形式：`git -c credential.helper="" push "https://user:token@github.com/..."`。

**不要用 `npx @electron/asar extract-file <asar> package.json`** —— 它把文件写在
当前目录，会覆盖项目自己的 `package.json`。要看 asar 内容用
`npx @electron/asar extract <asar> .stage/asar-check`。

## 测试与验证

- 单元测试 **491 项**（76 绑定 / 53 路由 / 72 双服 / 39 迁移 / 76 数据目录 /
  85 在线展示 / 64 SnowLuma / 26 连接错误翻译）
- 真机端到端：SnowLuma 27 项、打包版 21 项（可选）
- UI 改动可用 `node scripts/ui-screenshot.cjs <输出png> [等待毫秒]` 截图验证
- 打包版冒烟：`.stage/smoke-packed.cjs`（启动 portable exe → CDP 截图 + 文本核对）

## 发布流程（v1.17.0 已验证）

0. **先验证 GitHub 写权限**：本机 bash 用的 git 无 credential helper、
   GCM store 常为空 → push 报 `could not read Username`。
   确认能写之后再开始打包，别等 97MB 打完才发现推不上去。
1. 版本号（package.json）+ `docs/RELEASE-vX.Y.Z.md` + README 下载区
2. `npm test` → `npm run typecheck` → `GC_OUT_DIR=dist-release-vX.Y.Z npm run dist`
3. 图标 7 档校验 → SHA256 回填文档 → 打包版冒烟
4. 提交 → push main → tag → push tag → REST API 建 Release →
   curl 传资产（97MB ≈ 5 分钟）→ **下载线上包回验 SHA256**

## 未实现（用户已推迟）

- 服务端插件桥：游戏内 `/easybot bind` 目前无法触发取码
- NSIS 安装包 target（当前只有 portable 单文件版）
- 多服务器 UI、RCON 密码加密存储
