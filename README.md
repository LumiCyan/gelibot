# GeLi Bot — QQ ↔ Minecraft 桥接控制台

一个 Windows 桌面端工具：通过 **SnowLuma（OneBot v11）** 接收 QQ 群 / 私聊消息，  
经权限判定后通过 **RCON** 向 Minecraft Java 服务器投递指令，并管理 QQ 号与游戏玩家 ID 的绑定关系。

**SnowLuma 已内置**：程序里带了一份完整的 SnowLuma 运行包（含自带 `node.exe`），
在「连接设置」页点一下按钮就能启动它并自动打开管理后台，不用再手工解压、跑 `launcher.bat`。

配色：白色主调，蓝色为主色点缀，浅绿作次色点缀。

---

## 架构

```
QQ 群 / 私聊
      ↓
SnowLuma（OneBot v11，WS :3001）←── SnowLuma 启动器（本程序内一键起停）
      ↓
本程序（Electron 主进程）
  ├─ OneBot 客户端：收事件 / 发消息 / 改群名片
  ├─ 权限路由：白名单 → 指令 → 模板填充 → 参数校验 → 限流
  ├─ 绑定管理：双模式（双向验证 / 信任）、强制绑定、退群解绑
  ├─ 验证码管理：签发 / 校验 / 过期回收
  └─ RCON 客户端
      ↓
Minecraft 服务器（RCON :25575）
```

绑定链路（双向验证模式）：

```
服务器内 /easybot bind ──┐
                        │ 签发验证码
              BindCodeManager ──→ RCON tellraw 播报到游戏内
                        │
群内 /绑定 <验证码> ─────┴──→ 校验并消费 → BindingManager 落库
                                              ↓
                                       群名片更新（按策略）
                                              ↓
                                       强制绑定服务器 → kick 未绑定玩家
```

---

## 前置条件

### 1. Minecraft 服务端

在 `server.properties` 中配置：

```properties
enable-rcon=true
rcon.port=25575
rcon.password=<用 openssl rand -base64 24 生成的强随机串>
white-list=true
enforce-whitelist=true
```

> ⚠️ 不要把 25575 端口暴露到公网。RCON 是明文 TCP，持有密码等于拥有服务器控制台权限。

### 2. SnowLuma

程序里已内置 SnowLuma（完整版，自带 `node.exe`），所以**不需要自己去下载**：

1. 打开「连接设置」页，找到 **SnowLuma 启动器** 卡片
2. 点 **启动 SnowLuma** —— 会自动拉起进程，并在浏览器打开管理后台
3. 首次进入后台需要先同意 EULA / 隐私条款才能解锁面板
4. 用卡片上显示的**后台账号密码**登录（全新数据目录首次启动时随机生成，界面上会直接给出）
5. 按引导扫码接入 QQ 进程
6. 进入**节点配置** → 启用 **WS 服务端**，记下端口（默认 3001）与 Token，填到下面的「OneBot v11 连接」卡片里

想换成自己那份 SnowLuma（比如升级版本）时，在卡片里把「SnowLuma 程序目录」指向
你的目录即可，留空就继续用内置版。程序目录里必须同时有 `index.mjs` 与 `node.exe`。

> 内置版来自 SnowLuma v1.14.22 的 `win-x64` 发行包。它是**源码可见非商业许可**，
> 自己用没问题；若要把本程序连同它一起公开发布或商用，需要先取得 SnowLuma 的书面授权。

---

## 使用

### Windows 双击启动（推荐）

直接双击项目根目录的 **`run.cmd`**，会自动完成构建并拉起窗口。

### 命令行

```bash
npm install
npm start
```

开发模式（数据目录落在项目内 `data/`，方便调试）：

```bash
npm run dev
```

> 如果启动后没有出现窗口，检查是否设置了 `ELECTRON_RUN_AS_NODE` 环境变量。
> 该变量会让 Electron 退化为纯 Node 模式，需先清除后再启动。`run.cmd` 已内置清除逻辑。

---

## 打包为 exe

产物：**`GeLi Bot v1.15.0.exe`**（单文件绿色版，93.2 MB / 97,696,286 字节，双击即用）
——其中约 60 MB 压缩后来自内置的 SnowLuma 运行包（原始 97 MB）。

```bash
npm run dist        # 完整打包
npm run dist:dir    # 只生成免压缩目录，用于快速验证
```

配置见 `electron-builder.config.js`，要点：

| 配置 | 说明 |
| ---- | ---- |
| `productName: 'GeLi Bot'` | 应用名，决定 exe 内部标识与数据目录名 |
| `portable` target | 单文件绿色版，不写注册表、不留后台服务 |
| `extraResources` | 把 `snowluma/`（97 MB 解压后）铺到 `resources/snowluma/` |
| `electronDist` | **复用 `node_modules/electron/dist`**，省掉一次 100MB+ 下载 |
| `files` | 只打 `dist/**` 与 `package.json`，源码/测试/截图/SnowLuma 都不走这里 |
| `asar: true` | 代码打进 `app.asar`，避免文件散落 |
| `signAndEditExecutable: false` | 无签名证书，跳过着色签名（否则会尝试联网下载 winCodeSign） |
| `icon: 'build/icon.ico'` | 7 档尺寸图标（16→256），由 `scripts/make-icon.py` 纯 Python 生成 |

**SnowLuma 为什么放 `extraResources` 而不是 `files`**：它是独立进程（自带 `node.exe`），
不能进 asar，需要保持可执行的真实文件结构。`portable` 目标会把它一并压进 `app-64.7z`，
所以 exe 只涨约 33 MB（而不是 97 MB）。

**想换内置的 SnowLuma 版本**：把新发行包解压覆盖项目根目录的 `snowluma/` 再打包即可，
要求目录里有 `index.mjs` 和 `node.exe`。

**受限网络下打包**：electron-builder 默认从 GitHub 拉 NSIS 工具链，必然超时。
需要把镜像指向 npmmirror：

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run dist
```

**输出目录**：默认 `dist-release/`，可用环境变量覆盖：

```bash
GC_OUT_DIR=dist-release-v1150 npm run dist
```

**打包前注意**：electron-builder 会先清空输出目录。若上一次的 `win-unpacked/`
仍被占用（例如刚跑过 exe 没退出干净，或所在环境拦截了递归删除），清理步骤会失败。
此时换一个新的 `dist-release-v<版本>` 目录名重跑即可，无需先删旧目录。

> 本机验证时踩到的坑：运行环境会对递归删除与 `app.asar` 的删除做拦截
> （`tag` 为 `SAFE_DELETE_FAIL_CLOSED` / `Some operations were aborted`）。
> 表现为 `win-unpacked/resources/app.asar` 无法删除也无法改名（WinError 32，
> 有进程持有句柄）。处理方式即上面所述——换新输出目录；残留的旧目录只剩
> 一个 0 字节占位文件，不影响打包。

**图标**：`scripts/make-icon.py` 不依赖 Pillow，直接手写 ICO/BMP 字节流，
生成 7 档尺寸（16/24/32/48/64/128/256）的 `build/icon.ico`。
需要换图标时改脚本里的 `BG` 配色与字母即可重新生成。

---

## 功能说明

### 连接设置

配置 RCON 与 OneBot 两个通道，支持单独测试与立即重连。  
顶部状态栏实时显示 **SnowLuma / RCON / QQ** 三条链路的状态。

### SnowLuma 启动器

内置了完整的 SnowLuma 运行包，不用再去手工解压和跑 `launcher.bat`。

- **一键启停**：启动 / 停止按钮直接管理 SnowLuma 进程，显示 PID 与运行状态
- **自动开后台**：检测到 WebUI 真正开始监听后，自动用系统浏览器打开管理后台
- **凭据直取**：从启动日志里抓出首次生成的 `admin / 密码`，显示在界面上并支持一键复制
- **程序目录可换**：留空用内置版；也可指向自己的 SnowLuma 目录（校验 `index.mjs` 与 `node.exe`）
- **数据分离**：SnowLuma 的 `config/` 与 `logs/` 写到数据目录，程序目录保持只读不被写脏
  （这样内置版放在只读的 `resources/` 里也能正常持久化）
- **随程序退出**：默认关闭本程序时一并停止 SnowLuma，可取消勾选让它继续在后台跑
- **启动日志**：卡片内直接看 SnowLuma 的输出，含首次启动的完整凭据横幅
- **重复启动保护**：启动前先探测 WebUI 端口，已有实例在跑时给出明确提示而不是撞端口

> 实现上没有走 `launcher.bat`，原因有二：它依赖 PATH 里的 `node`（发行包自带 `node.exe`
> 更可靠），且它结尾有 `pause`，进程永不退出，没法做生命周期管理。
> 因此直接 spawn `<目录>/node.exe <目录>/index.mjs`。
>
> 注意入口脚本必须传**绝对路径** —— Node 是按 cwd 解析相对入口的，
> 而 cwd 被设成了数据目录，传 `index.mjs` 会直接 `MODULE_NOT_FOUND`。

### 群 / 私聊白名单

- 只有白名单内的群 / 私聊会被处理，其余消息直接忽略
- 可分别开关群聊响应与私聊响应
- 管理员列表：管理员不受白名单限制，并可执行「仅管理员」指令

### 指令管理

这是**安全模型的核心**。所有投递到 RCON 的指令都必须以模板形式定义：

| 字段    | 说明                                      |
| ----- | --------------------------------------- |
| 触发命令名 | 群成员输入的指令名，如 `加白`                        |
| 命令模板  | 真正投递给 RCON 的命令，如 `whitelist add {arg0}` |
| 作用域   | 群聊 / 私聊 / 两者                            |
| 仅管理员  | 限制只有管理员可执行                              |
| 允许参数  | 是否接受玩家传入参数                              |

**为什么安全**：玩家输入只作为参数代入模板，且参数强制校验为合法 MC 玩家 ID  
（`^[A-Za-z0-9_]{3,16}$`），无法拼接出模板之外的命令。  
本程序不做「群消息直通 RCON」。

### 账号绑定

绑定方式对齐 **EasyBot** 的设计，提供两种互斥模式。

#### 模式一：双向验证模式（默认）

玩家必须在**游戏内与社交平台两侧**各自完成一步，才能建立绑定：

```
① 玩家在服务器内执行  /easybot bind
       ↓
   程序签发一次性验证码，并通过 RCON（tellraw）播报到玩家本人
       ↓
② 玩家在 QQ 群内发送  /绑定 482913
       ↓
   校验通过 → 建立绑定 → 群名片按策略更新
```

| 配置项 | 说明 |
| ---- | ---- |
| 验证码位数 | 4–12 位，默认 6 |
| 验证码类型 | 纯数字 / 纯字母 / 数字+字母（字母集已剔除 I、L、O 等易混淆字符） |
| 有效期 | 默认 300 秒，过期自动作废 |
| 服务器内取码指令 | 默认 `easybot bind`，可改 |
| 播报到游戏内 | 开启后通过 `tellraw` 把验证码发给玩家本人 |

**一次性语义**：验证码消费即销毁，无论绑定成功还是失败。同一玩家重复取码时，旧码立即作废，
保证任意时刻只有一个有效码。

「待验证码」面板实时列出全部未使用的验证码，含剩余有效期，管理员可手动撤销。

#### 模式二：社交平台信任模式

玩家直接在群内发送 `/绑定 <玩家ID>` 即可完成绑定，无需进服取码。适合信任度较高的社群。

#### 强制绑定

启用后，列表中的服务器要求玩家**必须完成绑定才能进入**：

- 未绑定玩家无法进入
- 在线解绑后立即被踢出（通过 RCON 下发 `kick <玩家> <提示语>`）
- 踢出提示支持 MC 颜色码，可自定义

服务器标识列表留空表示对当前所有服务器生效。

#### 退群自动解绑

开启后，群成员退群（`group_decrease` 通知）会**自动解绑该 QQ 的全部账号**。

#### 绑定后修改群名片

| 策略 | 行为 |
| ---- | ---- |
| 不修改 | 默认 |
| 绑定/解绑成功后改名 | 仅在绑定状态变化时调用一次 API |
| 玩家发消息时检查并更新 | 每次消息都查询并同步，实时性好但会增加请求量 |

多个绑定会用空格拼接，超出 30 字符自动截断。

#### 其他策略

- **单个 QQ 最多可绑定的玩家 ID 数量**：超限时拒绝新绑定
- **玩家 ID 全局唯一**：避免冒用他人身份
- **自助绑定 / 自助解绑**开关：关闭后仅管理员可通过界面操作
- **执行指令前必须先绑定**：管理员的指令不受此限制
- **回复时 @ 触发者**：群聊内生效

#### 群内可用指令（内置，不投递 RCON）

```
/绑定 <验证码>      双向验证模式：用游戏内取得的验证码完成绑定
/绑定 <玩家ID>      信任模式：直接绑定游戏账号
/解绑 [玩家ID]      解除绑定（仅有一个绑定时可省略参数）
/我的绑定           查看已绑定账号
/查询绑定 <关键词>   按 QQ 或玩家 ID 反查归属（仅管理员）
/帮助               查看可用指令
```

#### 消息模板

全部回复文案可在「账号绑定 → 消息模板」中自定义，支持的占位符：

| 占位符 | 含义 |
| ---- | ---- |
| `#player` | 玩家 ID |
| `#qq` | QQ 号 |
| `#code` | 验证码 |
| `#time` | 剩余有效期 |
| `#current` / `#max` | 当前已绑数量 / 上限 |
| `#why` | 失败原因 |

### 指令控制台

手动执行 RCON 命令（绕过权限校验，但记入审计），以及向指定群 / 私聊发送测试消息。

### 审计日志

记录**每一条**真正投递到服务器的 RCON 命令：时间、来源、触发者、命令、结果。  
点击任意一行可展开查看原始消息与完整返回内容。

---

## 界面预览

运行时实际截图（保存在 `docs/screenshots/`）：

| 页面 | 文件 | 说明 |
| ---- | ---- | ---- |
| 连接设置 | `gelibot-1-连接设置.png` | **SnowLuma 启动器**（一键启动 / 停止 / 打开后台）+ RCON 通道配置 |
| 群 / 私聊白名单 | `gelibot-2-群白名单.png` | 群、私聊、管理员三类名单 |
| 指令管理 | `gelibot-3-指令管理.png` | 9 条内置指令，模板编辑器与安全说明 |
| 账号绑定 | `gelibot-4-账号绑定.png` | 绑定模式选择（双向验证 / 信任）+ 验证码规则 + 绑定策略 |
| 指令控制台 | `gelibot-5-控制台.png` | 手动执行 RCON 命令与发送测试消息 |
| 审计日志 | `gelibot-6-审计日志.png` | 执行记录，带成功 / 失败标签 |
| **SnowLuma 运行中** | `gelibot-snowluma-running.png` | 点「启动 SnowLuma」后的状态：PID、后台地址、临时账号密码、启动日志 |
| **打包版实机运行** | `gelibot-packed-snowluma.png` | `GeLi Bot.exe` 启动内置 SnowLuma 后的真实窗口，程序目录指向 `resources/snowluma` |

---

## 数据存储

| 环境   | 位置                             |
| ---- | ------------------------------ |
| 开发模式 | 项目内 `data/`                    |
| 打包后  | `%APPDATA%/GeLi Bot/data/`     |

首次启动会自动生成 `config.json`，随后按需生成 `bindings.json`、`audit.json`。  
写入采用「临时文件 + 重命名」方式，避免写坏。

配置升级采用**逐层深度合并**：老版本 `config.json` 缺少的新字段会自动补齐，
用户已填写的值一律保留（详见「已验证的行为」中的配置迁移测试）。

**SnowLuma 的数据目录**单独放在 `%APPDATA%/GeLi Bot/snowluma/`，它的
`config/` 与 `logs/` 都在那里。

> 从 `GeLiCraft` 改名到 `GeLi Bot` 时，程序会在首次启动自动把旧的
> `%APPDATA%/GeLiCraft/data/` 复制过来（只在目标不存在时做一次，且是复制而非搬移，
> 旧目录保持原样），免去重填 RCON 密码与绑定关系。
> 候选旧目录为 `GeLiCraft` 与 `gelibot`（后者是 productName 未写进 `app.asar` 的
> 早期构建留下的），同时存在时取 `config.json` 较新的那个。
>
> **为什么数据目录名必须靠 `extraMetadata.productName`**：Electron 的
> `app.getPath('userData')` = `%APPDATA%/<package.json 的 productName ?? name>`。
> `electron-builder.config.js` 里的 `productName` 只影响 exe 名与安装信息，
> **不会**自动写进 `app.asar` 内的 `package.json`；如果 `extraMetadata` 里不带它，
> 打包后会退化成小写的 `name`，数据目录就跟产品名对不上了。

---

## 项目结构

```
src/
  shared/
    types.ts          全部数据模型（含 BindMode / SnowLumaConfig / SnowLumaStatus）
    defaults.ts       默认配置与 9 条内置指令
  main/
    store.ts          JSON 持久化（原子写 + 逐层合并升级）
    bindcode.ts       验证码管理器（签发 / 消费 / 过期回收）
    binding.ts        绑定管理器（双模式 / 上限 / 唯一性 / 退群解绑 / 踢出消息）
    router.ts         权限路由与内置指令（安全核心）
    snowluma.ts       SnowLuma 进程管理器（起停 / 日志解析 / 凭据提取 / 端口探测）
    rcon.ts           RCON 协议客户端
    onebot.ts         OneBot v11 客户端（含群名片、退群事件）
    main.ts           主进程装配与 IPC
  preload/
    preload.ts        contextBridge 暴露白名单 IPC
  renderer/
    App.tsx + pages/  6 个页面
    pages/SnowLumaCard.tsx  SnowLuma 启动器卡片
snowluma/             内置的 SnowLuma 运行包（含自带 node.exe）
scripts/
  build-renderer.mjs  esbuild 打包渲染进程
  copy-assets.mjs     静态资源拷贝
  make-icon.py        纯 Python 生成 build/icon.ico（不依赖 Pillow）
  tests/              三套测试（npm test 运行）
build/icon.ico        应用图标（electron-builder buildResources）
docs/screenshots/     界面截图
electron-builder.config.js  打包配置
```

---

## 已验证的行为

搭建过程中对各层链路都做了实测（mock 服务端 + 真实协议封包），
`npm test` 共 **219 项**断言，另有 2 套可选的**真机**端到端测试（**27 + 21 项**）：

**绑定逻辑 `test-bind.cjs`（76 项）**

- 验证码：位数 / 字符集 / 易混淆字符剔除 / 100 次签发无重复
- 一次性语义：同一玩家重复取码旧码作废；消费后二次使用失败
- 过期：过期码消费失败并被自动清理
- 双向验证：跨群使用被拒、失败后码作废需重新获取
- 信任模式：6 类注入与非法 ID（`../../etc`、`Steve;stop`、`rm -rf`、超长、中文、含空格）全部拒绝，0 条写入
- 上限与唯一性：多档上限（1 / 3 / 5）边界正确；他人已绑定的 ID 被拒绝
- 解绑：指定解绑、唯一绑定时可省略参数、多绑定时强制指定、管理员绕过开关
- 退群解绑、强制绑定判定（含服务器列表匹配）、消息模板渲染、群名片截断、管理员反查

**路由集成 `test-router.cjs`（40 项）**

- 双向验证完整链路：服务器取码 → 验证码播报 → 群内绑定 → 落库
- 信任模式绑定、非法 ID 拦截
- 解绑 / 我的绑定 / 查询绑定（含管理员权限校验）
- 强制绑定：解绑后下发 `kick`；未启用时零调用
- 绑定前置要求：未绑定被拦，绑定后放行
- 权限与注入：普通用户被拒管理指令且零 RCON 调用；4 类注入参数全部被拦截
- 帮助分级（非管理员看不到管理员指令）、限流生效、私聊场景与来源记录

**配置迁移 `test-migrate.cjs`（39 项）**

- 全新安装生成的默认值正确
- 老版本 `config.json`（`binding` 仅有 3 个旧字段）加载后**新字段自动补齐**，
  用户原有配置（host、密码、上限、开关、限流值）全部保留
- 部分 `messages` 缺失时只补缺失项，自定义项不被覆盖
- 正常配置持久化往返一致；损坏 JSON 不抛异常，降级为默认配置

**SnowLuma 启动器 `test-snowluma.cjs`（64 项）**

- 日志解析：用真实 SnowLuma 启动日志做样本，凭据行与监听行都能正确提取；
  尾斜杠被规整、大小写与多余空格容错、普通行与无协议头的行不误判
- 目录解析：内置 / 自定义 / 缺失三种来源判定正确；
  缺 `index.mjs` 或 `node.exe` 都能报出具体原因；
  **自定义目录填错时不会悄悄回退到内置版**（否则用户以为在用外部版本）
- 端口探测：空闲端口为 false、有服务为 true、返回 401 也算活着、非法地址不抛异常
- 配置：默认值正确、老配置自动补齐 `snowluma` 段、部分字段缺失时保留用户值、持久化往返一致

**SnowLuma 真机端到端 `test-snowluma-live.cjs`（27 项，可选）**

真的把内置 SnowLuma 拉起来跑一遍，验证「一键启动」整条链路：

```bash
node scripts/tests/test-snowluma-live.cjs
```

- 进程被真实拉起、拿到 PID、状态从 starting 走到 running
- 从日志里抓到后台账号密码，并解析出监听地址
- `config/` 与 `logs/` 落在**数据目录**，程序目录保持只读不被写脏
- 停止后进程退出、状态复位、PID 清空、无残留
- 缺 `snowluma/` 时自动跳过，不算失败

**打包版端到端（21 项，实测记录）**

直接驱动 `dist-release-v1150/win-unpacked/GeLi Bot.exe`（与 portable exe 的
`resourcesPath` 完全一致），用 CDP 连进页面点真实按钮：

- 品牌：`<title>` 与页头均为 `GeLi Bot`；6 个导航项齐全
- **内置定位走 `process.resourcesPath`**：`resolvedDir` 落在
  `resources/snowluma`，`dirSource = bundled`
- **数据目录为 `%APPDATA%\GeLi Bot\snowluma`**（验证 `extraMetadata.productName` 生效）
- 点「启动 SnowLuma」后：拿到 PID、解析出 `admin` 与临时密码、`listening = true`
- 后台 `http://127.0.0.1:5099` **真实返回 HTTP 200**
- 界面同步显示「运行中」、PID 与后台地址
- 关闭程序后 SnowLuma 进程确实退出（`stopWithApp` 生效）
- 结果：**21/21 通过**

**RCON 协议（7 项，早期验证）**

- 正确密码鉴权成功、错误密码被拒绝并给出明确提示
- `list`、`whitelist add` 命令收发正常
- 换行注入防护生效：`list\nstop` 被清洗为 `list stop`，`stop` 不会单独执行
- 空命令、未连接状态下的调用被拒绝

运行方式：

```bash
npm test          # 构建主进程 + 跑全部三套测试
```

---

## 已实现 / 待办

**已实现**

- OneBot v11 客户端（含 echo 关联、断线重连、机器人账号展示、群名片更新、退群事件）
- RCON 协议客户端（鉴权、超时、响应聚合、自动重连、换行注入防护）
- 白名单 + 指令 + 模板 + 参数校验 + 限流的完整权限链路
- **双模式账号绑定**（双向验证 / 社交平台信任），对齐 EasyBot
- **一次性验证码**：格式可配、有效期可配、重复取码作废旧码、过期自动回收
- **强制绑定**：服务器白名单 + 未绑定踢出（RCON kick）
- **退群自动解绑**、**绑定后改群名片**（三种策略）
- 可自定义的绑定消息模板（6 个文案，支持占位符）
- QQ ↔ 玩家 ID 绑定、数量上限、玩家 ID 全局唯一
- 六个功能页面的图形界面 + 待验证码实时面板
- 全量审计日志
- **内置 SnowLuma 完整版 + 一键启动器**（启动 / 停止 / 打开后台 / 抓取临时凭据 / 随程序退出）
- **打包为单文件绿色版 exe**（`GeLi Bot v1.15.0.exe`，93.2 MB，含自绘图标与内置 SnowLuma）

**尚未实现**

- **服务端插件桥**：把游戏内 `/easybot bind` 转成本程序的取码调用
  （当前需通过界面或 IPC 触发取码，或用「签发验证码」按钮代发）
- 白名单审批流（当前管理员指令直接执行，无「申请 → 批准」两阶段）
- 安装版 exe（当前只有 portable；如需开始菜单快捷方式与卸载项，加一个 `nsis` target 即可）
- 多账号 / 多服务器同时管理（数据结构已预留 `serverId`，但界面仍是单实例）
- 敏感配置加密（当前 `config.json` 明文存密码）

---

## 注意事项

1. **RCON 密码**当前以明文存储在 `config.json` 中，请确保该目录权限可控
2. **SnowLuma 强绑定 QQ 版本**，QQ 自动更新可能导致 hook 失效，建议关闭 QQ 自动更新
3. **SnowLuma 为源码可见非商业许可**，核心 native 组件闭源。自用没问题；
   但**对外分发本 exe 需要先取得授权**（包里含 SnowLuma 二进制，占 97 MB）。
   若要发布给别人，建议改成不内置：让对方自行下载 SnowLuma，
   再用启动器里的「程序目录」指向它。
4. 建议使用**专门的机器人小号**，不要用主账号
5. 若在受限环境（如部分沙箱、CI）运行 Electron，需确保未设置  
   `ELECTRON_RUN_AS_NODE` 环境变量，否则 Electron 会以纯 Node 模式启动，  
   `require('electron')` 将无法取得应用 API
6. **双向验证模式的服务器取码**目前由本程序内的 `startServerSideBind` 提供。
   若要让玩家在游戏内真正打出 `/easybot bind` 取到码，需要在服务端侧接一个插件或
   命令桥把该指令转成本程序的一次调用（EasyBot 的做法是装它自己的服务端插件）。
   当前版本已把验证码签发、播报、校验完整实现，缺的只是「服务端 → 本程序」这一段触发。
