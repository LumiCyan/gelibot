# 发布更新包到 GitHub Releases（解决「检查更新 HTTP 404」）

## 为什么 404

更新器检查更新时请求：

```
https://github.com/lumicyan/gelibot/releases/latest/download/release-manifest.json
```

这个地址只对「作为 Release **附件**上传的文件」生效。你的 `v1.17.0` Release
目前只上传了 `GeLi.Bot.v1.17.0.exe`，**没有 `release-manifest.json`**，所以必然 404。

## 修复步骤（一次性 + 以后每次发版重复）

### 1. 本地生成更新资产

```bash
npm run dist                                   # 打包出 exe + app.asar
node scripts/build-update-manifest.mjs 1.18.0 old-asar release-assets-1.18
```

> 如果打包输出目录不是默认的 `dist-release`（例如被占用时换了目录），
> 用同一个变量告诉清单脚本即可，两边自动保持一致：
>
> ```bash
> GC_OUT_DIR=dist-release-1.18 npm run dist
> GC_OUT_DIR=dist-release-1.18 node scripts/build-update-manifest.mjs 1.18.0 old-asar release-assets-1.18
> ```

`release-assets-1.18/` 下会产出：

| 文件 | 作用 |
| --- | --- |
| `release-manifest.json` | 客户端判断是否有更新的清单（**必须上传**） |
| `app-1.18.0.asar` | 完整 asar（非便携版全量更新用） |
| `GeLi Bot v1.18.0.exe` | 便携版整包（绿色版更新用） |
| `app-<旧版>-to-1.18.0.patch` | 差量包（`old-asar/` 里有旧版本时生成） |

清单里的 `notes` 会自动从 `docs/RELEASE-v<版本>.md` 提取（取前两段正文并去掉
Markdown 标记），所以**先写好 release notes，再生成清单**，客户端「发现新版本」
时就能直接显示这一版干了什么。

> 注意：`exeUrl` / `asarUrl` / `patches[].url` 在清单里是**相对文件名**，
> 客户端会拼回 `releases/download/<tag>/<文件名>`。所以附件文件名必须与清单里的
> 字段值**逐字节一致**，包括空格。

### 2. 上传到 Release

打开 https://github.com/lumicyan/gelibot/releases/edit/v1.18.0 （或新建 Release），
把 `release-assets-1.18/` 里的**全部文件**拖到「Attach binaries」区域，上传完成后
`Publish` / `Update release`。

### 3. 验证

```bash
curl -I https://github.com/lumicyan/gelibot/releases/latest/download/release-manifest.json
```

应返回 `HTTP 200`。之后客户端「检查更新」即可读到清单。

---

## 差量更新（从旧版本升级，可选）

`patches` 为空时客户端会走「全量 asar / 完整 exe」。要启用差量，
需要先留存旧版本的 app.asar：

1. 建目录 `old-asar/`，放入历史版本：`app-1.17.0.asar`、`app-1.16.0.asar` …
   （来源：打包旧版本时的 `dist-release/win-unpacked/resources/app.asar`，
   或该版本 Release 附件里的 `app-<版本>.asar`）
2. 发新版时：

   ```bash
   node scripts/build-update-manifest.mjs 1.18.0 old-asar release-assets-1.18
   ```

   脚本会对每个旧版本生成 `app-<旧版>-to-1.18.0.patch`，写进清单的 `patches`。

> **基线必须一致**：差量包是「针对某个确定的旧文件」生成的。
> 如果用户手上的旧 asar 与你放进 `old-asar/` 的不是同一份，
> bspatch 仍会「成功」但产出错误内容——客户端会用结果的 sha256 校验拦住它，
> 自动回退到完整包下载。所以宁可基线不全，也不要放错版本的文件。

   脚本会对每个旧版本生成 `app-<旧版>-to-1.18.0.patch`，写进清单的 `patches`。

## 客户端侧的镜像回退（已实现）

即使清单存在，国内直连 GitHub 也可能超时。更新器 `download()` 现在会在直连
`github.com` 失败后自动按序尝试镜像：

```
https://gh-proxy.com/
https://ghfast.top/
https://ghproxy.net/
```

镜像只用于下载，不影响清单地址生成；自定义源（非 GitHub 域）不做镜像。
