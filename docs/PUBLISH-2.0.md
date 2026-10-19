# 发布 v2.0.0（需要你在本机完成）

## 为什么最后一步要你来做

这台机器的出网被中间人代理拦了 TLS，**访问不了 `github.com` / `api.github.com`**：

```
curl https://api.github.com        → HTTP 000（SSL 握手失败）
git  https://github.com/...        → unable to get local issuer certificate
ssh  git@github.com:22             → Connection refused
```

但发现一个可用通道：**`ssh.github.com:443` 是通的**（SSH 握手成功，只缺公钥）。
所以现在：

| 事项 | 状态 |
| --- | --- |
| 代码提交 | ✅ 已在本地 commit（`8c83e59`）+ 打 tag（`v2.0.0`） |
| 代码 push | ⬜ 需要你的公钥授权（见步骤 1） |
| Release 创建 + 附件上传 | ⬜ 需要能访问 `api.github.com` 的网络（你自己电脑） |

---

## 步骤 1：把公钥加到 GitHub

我生成了一对专用密钥（只用于这个项目）。把下面这一整行贴到
https://github.com/settings/ssh/new ：

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILmfISmHh3ptFG4ouMV7upYcJ+cPQ9VMvFyFIHKy7gBS gelibot-release-2026
```

Title 随便是 `gelibot-release`，类型保持 Authentication Key，点 Add。

> `~/.ssh/config` 已配好让 `github.com` 走 `ssh.github.com:443`，不需要再改。

---

## 步骤 2：推送代码

在项目目录执行：

```bash
git push -u origin main
git push origin v2.0.0
```

> 如果提示 `Permission denied (publickey)`，说明步骤 1 还没生效，
> 用 `ssh -T git@github.com` 验证（成功会回 "Hi LumiCyan!"）。

---

## 步骤 3：上传 Release 与全部附件

Release 附件必须**文件名逐字节匹配**清单里的字段 —— 尤其
`GeLi Bot v2.0.0.exe` 里有空格，手动改名就会导致客户端 404。

### 方式 A：用脚本（推荐，自动校验 sha256）

需要先装 GitHub CLI 并登录：

```bash
winget install GitHub.cli
gh auth login          # 选 GitHub.com → HTTPS → 浏览器授权
```

然后：

```bash
node scripts/upload-release.mjs              # 只做 Release
node scripts/upload-release.mjs --push-code  # 顺便把代码和 tag 也推了
```

脚本会：比对清单与实际文件的 sha256（防传错版本）→ `gh release create`
→ 上传 6 个附件 → 验证清单 URL 返回 200。

### 方式 B：纯网页（不用装 gh）

打开 https://github.com/lumicyan/gelibot/releases/new ，填：

- **Choose a tag**：`v2.0.0`（已存在就直接选）
- **Release title**：`GeLi Bot v2.0.0`
- **描述**：把 `docs/RELEASE-v2.0.0.md` 全文粘进去

然后把下面 **6 个文件**拖进附件区（**不要改名**）：

| # | 文件 | 来源目录 | 大小 |
| --- | --- | --- | --- |
| 1 | `release-manifest.json` | `release-assets-2.0/` | 1,100 |
| 2 | `app-2.0.0.asar` | `release-assets-2.0/` | 5,943,019 |
| 3 | `app-1.17.0-to-2.0.0.patch` | `release-assets-2.0/` | 1,949,232 |
| 4 | `app-1.18.0-to-2.0.0.patch` | `release-assets-2.0/` | 1,443,473 |
| 5 | `GeLi Bot v2.0.0.exe` | `dist-release-2.0/` | 97,764,988 |
| 6 | `GeLi Bot Setup 2.0.0.exe` | `dist-release-2.0/` | 97,926,675 |

勾上 **Set as the latest release**，点 Publish。

---

## 步骤 4：验证

```bash
curl -sL -o /dev/null -w "%{http_code}\n" \
  https://github.com/lumicyan/gelibot/releases/latest/download/release-manifest.json
```

应返回 `200`。之后客户端「检查更新」就能读到清单。

再核对一下客户端行为：

- 装的是 **1.17.0** → 走 `app-1.17.0-to-2.0.0.patch`（1.86 MB）
- 装的是 **1.18.0** → 走 `app-1.18.0-to-2.0.0.patch`（1.38 MB）
- 都不是 → 自动回退完整 asar（5.67 MB）
- 便携版 → 直接下载完整 exe 覆盖

---

## 完整校验值（可贴到 Release 页面）

| 文件 | 大小 | SHA256 |
| --- | --- | --- |
| `GeLi Bot Setup 2.0.0.exe` | 97,926,675 | `342b27847984e3c6fbdd2d704c42ac00e1ae6ab31e022d14c6c3474b7b143cd5` |
| `GeLi Bot v2.0.0.exe` | 97,764,988 | `c575a5a844fe0fc1904c4b9546a2263a46da416244c955e885d28d5565ffc8f1` |
| `app-2.0.0.asar` | 5,943,019 | `835387f60ff737a2db29342850e05b5a105c08a0714bde2e7337a22879a5f1d1` |
| `app-1.17.0-to-2.0.0.patch` | 1,949,232 | `aaa754010f19f3a951a74a1a129368b9c1ec87549d052cd787b9179b9add52c9` |
| `app-1.18.0-to-2.0.0.patch` | 1,443,473 | `1c6d0b0a7c555e4719d9f927e348a95cf9cfc0b226ca5f02cead28a9069c9ca3` |
| `release-manifest.json` | 1,100 | `ad5167e2cbb0b40f868ed410486a2d4ceee540f5e37d81de40a1da6de4b9d07a` |

> 注意：`release-manifest.json` 的 sha256 在你改过 notes 后会变，
> 以 `node scripts/upload-release.mjs` 输出的校验结果为准。
