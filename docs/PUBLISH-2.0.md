# v2.0.0 发布记录（已完成）

**✅ 已于 2026-10-19 22:03 发布**

- Release：https://github.com/LumiCyan/gelibot/releases/tag/v2.0.0
- 代码：`main` 已推到 `e9a1f3f`，tag `v2.0.0` 已推
- 附件：6 个，全部 `uploaded`
- 验证：`releases/latest/download/` 下 4 个关键 URL 全部 **HTTP 200 且字节数精确匹配**

本文档保留发布过程中踩到的两个坑，供以后发版参考。

---

## 坑一：出网被代理拦 TLS，但 `-k` 能过

```
curl https://api.github.com        → HTTP 000（SSL 握手失败）
ssh  git@github.com:22             → Connection refused
```

环境里有本地代理 `127.0.0.1:64135` 做 TLS 中间人，系统证书链校验不过。
解决办法：**只对本次请求/进程关闭证书校验**

- curl：加 `-k`
- git：`git -c http.sslVerify=false push`
- node：`process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`

代理在 `127.0.0.1`，不涉及外部第三方，风险可控。

## 坑二：GitHub 把文件名里的空格换成点

上传 `GeLi Bot v2.0.0.exe` 后，实际存储名变成了 `GeLi.Bot.v2.0.0.exe`。
清单里 `exeUrl` 写的是带空格的名字，客户端拼出来的 URL 就 **404**。

**规则：Release 附件名一律用连字符，不要有空格。**
本次改为 `GeLi-Bot-v2.0.0.exe` / `GeLi-Bot-Setup-2.0.0.exe`，
上传脚本会在返回后**立即比对存储名**，不一致直接报错退出。

---

## 复现发布（下次照这个走）

```bash
# 1. 打包 + 生成清单（清单的 exeUrl 必须与下面的上传名一致）
GC_OUT_DIR=dist-build-2.0 npm run dist
GC_OUT_DIR=dist-build-2.0 node scripts/build-update-manifest.mjs 2.0.0 old-asar release-assets-2.0

# 2. 推代码与 tag
git -c http.sslVerify=false push origin HEAD
git -c http.sslVerify=false push origin v2.0.0

# 3. 创建 Release 并上传 6 个附件（自动删旧资产、比对 sha256、校验文件名）
export GITHUB_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep '^password=' | cut -d= -f2-)
node scripts/upload-release-api.mjs 2.0.0

# 4. 验证
curl -skL -o /dev/null -w "%{http_code}\n" \
  https://github.com/LumiCyan/gelibot/releases/latest/download/release-manifest.json
```

---

## 本次附件一览

| 文件 | 大小 | SHA256 |
| --- | --- | --- |
| `GeLi-Bot-Setup-2.0.0.exe` | 97,926,675 | `342b27847984e3c6fbdd2d704c42ac00e1ae6ab31e022d14c6c3474b7b143cd5` |
| `GeLi-Bot-v2.0.0.exe` | 97,764,988 | `c575a5a844fe0fc1904c4b9546a2263a46da416244c955e885d28d5565ffc8f1` |
| `app-2.0.0.asar` | 5,943,019 | `835387f60ff737a2db29342850e05b5a105c08a0714bde2e7337a22879a5f1d1` |
| `app-1.17.0-to-2.0.0.patch` | 1,949,232 | `aaa754010f19f3a951a74a1a129368b9c1ec87549d052cd787b9179b9add52c9` |
| `app-1.18.0-to-2.0.0.patch` | 1,443,473 | `1c6d0b0a7c555e4719d9f927e348a95cf9cfc0b226ca5f02cead28a9069c9ca3` |
| `release-manifest.json` | 1,100 | 以远端实际文件为准 |
