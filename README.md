# dsh-remote-ios —— iPad 壳（「DSH 窗口 + 写作功能」移植）

> 状态：🧱 **环境骨架 + 最小可编译壳**（2026-09-30）。设计方案见私有主仓
> `docs/superpowers/specs/2026-09-30-ios-client-design.md`。
> 本仓**只放 iOS 侧**；Web 层与插件在 `dsh-remote` 主仓。

---

## 0. 先看这条：**Windows 上编译不出 iOS 应用**

| 环节 | 需要什么 | 本机（Windows）能做吗 |
|---|---|---|
| 写代码 / 生成工程 | 文本编辑器 + `project.yml`（XcodeGen） | ✅ 能 |
| **编译** | **macOS + Xcode + iOS SDK** | ❌ **不能**（Windows 的签名工具只能"重签+安装"已编译好的包） |
| 签名 | Apple ID（iLoader 重签；见 §5） | ✅ 能（但要拿到已编译的包） |
| 安装 | USB + Apple Mobile Device 服务 + iLoader 侧载 | ✅ 能 |

⇒ 所以本仓的定位是：**把"除了编译器之外的一切"准备好**，编译走下面两条路之一。

### 编译链（二选一）

| 路 | 做法 | 代价 | 状态 |
|---|---|---|---|
| **① GitHub Actions（推荐）** | 推代码 → `.github/workflows/ios-build.yml` 在 **macos-15 runner** 上构建 TailscaleKit + `xcodegen` + `xcodebuild`，产出**未签名** `.ipa` → 下载回 Windows | 免费额度按 **10×** 计（private 仓免费额度 2000 min/月 ⇒ 约 200 分钟 macOS 时长）；产物未签名 ⇒ 需本机 iLoader 用你的 Apple ID 重签（见 §5） | ✅ **已实测通过**（最新 2026-11-06 run-42166079900：`DSHRemote-unsigned.ipa` 8,870,461 B，含内嵌 TailscaleKit，已真机侧载） |
| ② iPad 上的 Swift Playgrounds | 在 iPad 上建 `.swiftpm` 工程直接运行 | 无需 Mac；工程结构受限、调试弱 | ❓ 未实测 |

> ⚠️ **① 的路上有两个已踩过的坑**（都已修在仓库里，别再踩）：
> 1. **Xcode 版本配对**：`macos-14` 默认 Xcode 是 **15.4**，而 XcodeGen 2.46.0 产出的工程是
>    `objectVersion 77`（Xcode 16 格式）⇒ 报 `future Xcode project file format (77)`。
>    **修法**：workflow 里 `xcode-select` 到镜像中版本最高的 `Xcode_*.app`（该镜像有 15.0–15.4 与 **16.1/16.2**）。
> 2. **XcodeGen 钉不住格式**：`options.objectVersion` 数字/字符串两种写法**生成出来都是 77** ⇒ 该键是死配置，
>    已在 `project.yml` 注明并移除。
> 📌 另：CI **不给任何 Apple ID 凭据**（签名凭据不离开你的电脑）。

### 0.1 签名与分发走哪条路（**2026-09-30 拍定：走 Swift Playgrounds，不装第三方签名工具**）

| 方案 | 结论 |
|---|---|
| **① Swift Playgrounds（✅ 本仓选它）** | 在 iPad 上用 **Apple 自家的机制**直接建工程并运行到本机 ⇒ **不引入任何第三方签名工具**，Apple ID 输在苹果自己的界面里（安全性最好）。⚠️ 见下方"未验点" |
| ② Sideloadly（❌ 已弃用） | 官方域名下载的安装包 **完全没有 Authenticode 签名**（`NotSigned`，137.23 MB，sha256 `7f5bbd15…`；winget 也因**哈希与清单不匹配**拒绝安装）⇒ 它是闭源、要处理你 **Apple ID** 的工具，**不签名的安装包无法验证来源**，故不采用。已删除，未安装。 |
| ③ AltStore/AltServer | 开源可审计，但流程更绕（需同 Wi-Fi 刷新）。备选，未采用 |
| ④ CI 编译 + 第三方重签 | CI 仍保留（**用来验证代码能编译**，见下），但**不作为分发路径** |

**① 的未验点（动手前必须先验）**：

| # | 问题 | 为什么关键 |
|---|---|---|
| P-1 | Swift Playgrounds 的 App 工程**能不能自定义 `Info.plist`**？ | 我们的壳要 ATS 放行明文 http（tailnet 线路）。**若不能改 plist ⇒ 只能走 Funnel 的 https**（那就得接受"多一跳"）。本机无法验证，只能在 iPad 上试一次 |
| P-2 | 工程结构是 `.swiftpm`（不是 `.xcodeproj`）⇒ 本仓的 `project.yml` / CI 出包**不能直接用于 Playgrounds** | 两条路并存：CI 只做"编译校验"，实际运行靠 iPad 上的 Playgrounds 工程（把 `Sources/*.swift` 粘进去） |
| P-3 | 是否需要开发者账号 / 免费 Apple ID 是否够、有效期多久 | 决定长期使用成本 |
| P-4 | Playgrounds 的工程能放几个源文件 / 资源 | 我们的壳是多个 `.swift` + 未来要内置写作页资产（§离线要求）⇒ 资源支持是关键 |

> 🔎 **P-1 的变通（若确实改不了 plist）**：把线路切到 **Funnel 的 https 域名**（`https://<xxx>.ts.net`）—— ATS 对 https 不拦，例外整段都可删。

### 0.2 方案 D 架构总览（**2026-11 当前真实形态**，旧 §0.1 的 Playgrounds 路线已被取代）

> 方案 D 已落地并通过真机验收（见 plan `docs/superpowers/plans/2026-10-24-ipad-embedded-tsnet-localhost-proxy.md`）。
> §0.1 是 2026-09-30 的早期分发评估，**保留作决策记录**；实际工程以下面这节为准。

**一句话形态**：App 进程内嵌一个用户态 tailscale 节点（官方 `libtailscale` c-archive + Swift 封装 `TailscaleKit`），
App 内起一个只绑 `127.0.0.1` 的本地 HTTP 反代，WKWebView 固定加载 `http://127.0.0.1:<动态端口>/__shell__/shell.html`。
与 PC 客户端的「本地回环反代」同构；不创建系统 VPN、不牵引其他 App 流量、免费 Apple ID 可签。

```
WKWebView  ──http://127.0.0.1:<port>──▶  LoopbackProxy(NWListener, 仅回环)
                                          ├─ /__shell__/* 与 18 件壳资产：App Bundle 本地应答(no-store)
                                          └─ 其余 /plugins /api /auth /WS：HttpBridge 逐字节透传
                                                  └─ tailscale_dial("tcp","100.99.84.35:8080")
                                                       （内嵌 netstack，WireGuard P2P / DERP 自动选路）
```

- **为什么必须本地反代**：WKWebView 没有 per-view 代理 API，`tailscaleSession` 的 SOCKS5 只作用于 URLSession、
  不作用于 WebView；所以用回环 listener 每入站一连接 → `tailscale_dial` 拿 fd → 双向字节桥。
  `http://127.0.0.1` 是规范认定的**安全上下文**，根 SW / 内核 v5 SW / `getUserMedia`（语音）一并成立。
- **三档通道（RouteStore 归一化）**：
  ① `.embedded` —— 内嵌节点在线，走 localhost 反代（P2P 直连优先，UDP 打洞失败自动落 DERP，UI 不区分）；
  ② `.funnel` —— 仅当节点 `stopped|failed` 且用户开了应急开关且填了合法 https funnelBase，WKWebView 直连 Funnel https（不经内嵌节点）；
  ③ `nil` —— 两档都不可用时显示原生状态页（失败上屏，不假装在线）。
- **凭据两档**：auth key 仅入网时粘一次，存 **Keychain**，绝不入包/入 git/入日志；节点登录态存沙盒
  `Documents/tailscale`。设置页「登出」=下线+删 Keychain key（保留目录态，重启可自动恢复）；
  「彻底清除」=连目录一起删（需重新粘 tskey）。
- **后台/回前台（issue [#20060](https://github.com/tailscale/tailscale/issues/20060) 应对）**：iOS 挂起回收的是
  自建 NWListener，tsnet 节点存活。回前台先 TCP 探活，桥失效才 stop/start 重建（实测端到端 <1s，**不重 up 节点**）；
  仅当观测到节点真死信号（取不回 handle / 新桥二次探活仍不通）才重新入网兜底。
- **已知限制**：免费 Apple ID **7 天重签**（见 §5）；长后台/内存压力下可能被 jetsam，靠已存登录态冷启动恢复；
  包体因内嵌 Go 运行时增加约 8.3 MiB ipa（见 §5.1）。

---

## 1. 本机环境现状（2026-09-30）

| 项 | 状态 |
|---|---|
| `Apple Mobile Device Service`（usbmuxd，USB 通信地基） | ✅ 已装（`Apple.AppleMobileDeviceSupport` 19.4.0.10）· 服务 Running / Automatic |
| `go-ios` v1.3.2（`ios.exe`，设备信息 / syslog / 截图 / 装包） | ✅ 已就绪：`E:\项目\_ios-tools\go-ios\ios.exe`；`ios list` 已通（`{"deviceList":[]}` ⇒ 未插设备） |
| iLoader（Apple ID 重签 + 侧载） | ✅ 已用（2026-11-06 run-42166079900 真机侧载通过；见 §5） |
| **macOS / Xcode** | ❌ 没有（见 §0） |
| iPad | ⏳ 未连接（插上即可用 `tools/ios-observ.ps1`） |

---

## 2. 观测链路（插上 iPad 后）

**顺序**：`Doctor`（自检）→ 需要时 `Tunnel` → `Session`（★ 一键观测会话）。

```powershell
# ① 先自检：Apple 服务 / go-ios / 设备 / tunnel 四项判定 + 下一步提示
powershell -File tools/ios-observ.ps1 -Action Doctor

# ② 等设备接入（没弹「信任此电脑」时很有用；默认等 120 秒，可用 -WaitSeconds 调）
powershell -File tools/ios-observ.ps1 -Action Wait

# ③ iOS 17+ 的多数命令需要隧道（**需管理员**；另开一个窗口跑，保持开着）
powershell -File tools/ios-observ.ps1 -Action Tunnel

# ④ ★ 一键观测会话：建 evidence\<时间戳>\ → 存设备信息 → 后台抓 syslog
#    → 提示你去 iPad 上复现 → 回车结束 → 自动截图 + 收崩溃列表 + 写 SUMMARY.md
powershell -File tools/ios-observ.ps1 -Action Session

# 单项动作
powershell -File tools/ios-observ.ps1 -Action List      # 设备列表
powershell -File tools/ios-observ.ps1 -Action Info       # 设备详情
powershell -File tools/ios-observ.ps1 -Action Syslog     # 实时日志（Ctrl+C 结束）
powershell -File tools/ios-observ.ps1 -Action Shot       # 截屏到 .\shots\
powershell -File tools/ios-observ.ps1 -Action Crash      # 崩溃列表
powershell -File tools/ios-observ.ps1 -Action Install -Ipa <已签名.ipa>
powershell -File tools/ios-observ.ps1 -Action Launch     # 启动本 app（默认 bundleId）
```

> **`Session` 产出的目录长这样**（`evidence\` 已 gitignore，不入库）：
> `device-info.json` · `device-name.txt` · `device-date.txt` · `syslog.txt` · `screenshot.png` · `crash-list.txt` · `SUMMARY.md`
> ⇒ **把这个目录给我**（或只给 `syslog.txt` + `screenshot.png`）即可，我能直接看到真实渲染与日志。

> 🔴 **两个已踩的 go-ios 坑**（脚本里已按实测写法修正，别改回去）：
> 1. 参数要**等号形式**：`--udid=<v>`、`--output=<路径>`、`--path=<ipa>`（空格形式在 1.3.2 上不生效）。
> 2. go-ios 的 stdout 会**混进 PowerShell 函数返回值**（会让 `$rc` 变成 `{"deviceList":[]} 0`）；
>    且它每次往 stderr 打同一句良性 WARN（agent 未跑）⇒ 必须接住 stdout+stderr 并过滤那句，否则真实输出被淹。


---

## 3. 工程结构（XcodeGen 管工程，CI 在 macOS 上编译）

`.xcodeproj` 由 `project.yml` 生成且 gitignore，本机（Windows）只改文本，编译真值在 CI（见 §0）。
方案 D 落地后，`Sources/` 下为扁平 `.swift`（仅 `Settings/` 子目录），按职责逻辑分组如下：

```
project.yml                          XcodeGen 工程唯一真源（target / 部署目标 17.0 / TailscaleKit 依赖 / plist）
Vendor/TAILSCALEKIT.VERSION          钉死的 libtailscale commit/版本（入 git，版本真源）
Vendor/TailscaleKit.xcframework      官方 Swift 封装 + Go 静态库（生成物，gitignore，CI 用脚本重建）
tools/build-tailscalekit.sh          按 VERSION 可复现构建 xcframework（仅 macOS；含 18.1→17.0 部署目标 patch）
.github/workflows/ios-build.yml      macos-15：gate(构建 xcframework) → test → 未签名 ipa + 三道硬自检
Resources/Info.plist                 ATS 回环放行 + 麦克风用途串 + iPad 机型
ShellAssets/                         18 件壳资产（3 CSS + 15 JS）随包内置，反代本地应答

Sources/
├─ App.swift / ShellWebView.swift    SwiftUI 入口；WebView 固定加载 http://127.0.0.1:<port>/__shell__/shell.html
├─ 〔节点面〕
│   ├─ TailnetNode.swift             App 级单例：up/down、状态机、看门狗、回前台桥重建/节点自愈
│   ├─ TailnetAuthStore.swift        auth key 的 Keychain 存取（不落 UserDefaults/日志）
│   ├─ TailnetConnecter.swift        tailscale_dial fd 桥（GCD，半关闭/EINTR 联动）
│   └─ Settings/TailnetSettingsView  认证页（粘 key、状态机、登出/彻底清除）+ TailnetVerifyView 验收入口
├─ 〔回环反代面〕
│   ├─ LoopbackProxy.swift           NWListener 仅绑 127.0.0.1 动态端口，路由壳资产/反代
│   ├─ HttpBridge.swift / HTTPHeadCodec.swift   HTTP/1.1 解析回写、WS(Upgrade)/SSE 逐字节透传、Cookie/Host
│   ├─ ShellAssetRoutes.swift / ShellHTMLInjector.swift / AssetManifest.swift  18 件白名单本地应答 + html 注入
│   ├─ ByteBridge.swift / NWConnectionChannel.swift  64KB 双向字节拷贝底层
│   └─ LoopbackProbe.swift            回前台 TCP 探活
├─ RouteStore.swift / GatewayURL.swift  三档通道归一化（.embedded / .funnel / nil 状态页）
├─ 数据与同步内核（方案 D 零改动）
│   └─ WorkspaceStore / AppDataStore / OutboxStore / PathGuard / BackgroundFlusher
│       / BridgeDispatcher / NativeBridge / BridgeSyncSchemeHandler / OutboxCounter
├─ BridgeJS.swift                    document-start 注入 ownsHost 与 49 方法消息桥
├─ MediaPermission.swift             WKUIDelegate 麦克风授权（方案 E-iOS，origin 白名单 + 无视频采集兜底）
└─ S1ViewController / S1ProbePage    登录种 Cookie + 五探针自检页
```

> 旧的虚拟 origin 三件套（`ShellOrigin` / `ShellSchemeHandler` / `ShellHTMLRewriter`、`dsh-asset` scheme、
> `local.dsh-remote.invalid`、`loadHTMLString` 壳装载）已在 Phase 5 全部删除，grep 零匹配。

---

## 4. 两个关键决策的历史推演（**均已被方案 D 收口，保留决策脉络**）

> 本节是 2026-09 方案 D 之前的推演。最终两个问题都由 §0.2 的「内嵌节点 + localhost 真回环反代」一并解决：
> 回环权威门走了下表的 **A（真回环）**，写作页同源走了下表的 **乙-1（壳层本地反代 + 资产随包内置）**。
> `ownsHost` 注入（B）作为桥接语义保留在 `BridgeJS.swift`，但权威门不再靠它。

### 4.1 「回环权威门」走哪条路

内核 UI 在**非回环权威**下会把整个设置面板降级为内存态（PC 端为此做了本地反代）。两条路：

| | A 真回环（app 内起反代） | **B 注入 `ownsHost`（推荐）** |
|---|---|---|
| 做法 | app 进程内起 HTTP 反代（HTTP+WS+SSE+Host 改写），页面加载 `http://127.0.0.1:<port>/` | `WKUserScript(atDocumentStart, forMainFrameOnly: false)` 注入 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` |
| 量级 | 中～大 | **一行 + 时序** |
| iOS 难点 | **后台会被挂起**；要自己写全套转发 | 依赖上游内部接口名（`__DSH_TRANSPORT__`）不被改 |

➡️ 骨架阶段曾按 **B** 写注入（`BridgeJS.swift` 仍保留 ownsHost 注入作为桥接语义）；**方案 D 最终落地走 A**——
`LoopbackProxy` 真回环反代，页面加载 `http://127.0.0.1:<port>/`，回环权威天然成立。

### 4.2 ⚠️ 同源问题：想复用 PC 的「写作页」UI，就得改一处

PC 客户端的写作页（`shell.html` / `writing.js` / `writing.css`）之所以能用，是因为它**由本地反代在"与网关同源"的源上返回**。
在 iOS 上如果直接加载网关页面（路线 B），**这些本地资产没有同源的落脚点**：

| 出路 | 说明 | 代价 |
|---|---|---|
| **乙-1** 壳层也起本地反代 | 回到路线 A ⇒ 同源天然成立 | 就是 §4.1 的 A（大） |
| **乙-2** 把这些资产**托管到网关**（`/__shell__/`） | 页面与资产同源；iOS 壳只做 WebView | 要动网关静态路由（小，但要改服务端） |
| ❌ 乙-3 用 `WKURLSchemeHandler` 自定义 scheme | **不可行**：Apple 不允许为 http/https 注册 handler ⇒ 必然跨源，CSP/Cookie 全崩 | —— |

⇒ **建议（2026-09-30 修订）：转走「乙-1」—— app 内起本地 HTTP 服务、把写作页资产随包内置。**
🔴 **原建议是"乙-2（资产托管到网关）"，已作废**：用户随后提出「无网络下也要能用（iPad 可能没有蜂窝）」，
而资产托管在网关 ⇒ 断网时**连页面都加载不出来** ⇒ 与离线要求直接冲突。
详见设计文档 `docs/superpowers/specs/2026-09-30-ios-client-design.md` **§5.4「离线可用」**（该节还给出了"分层：写作离线 / 对话需网"与四件必须处理的事）。
✅ **已拍定并落地（方案 D）**：走 **乙-1**——`LoopbackProxy` + `ShellAssetRoutes` 把 18 件写作页资产随包内置、
由本地反代在 localhost 同源应答（`cache-control: no-store`），断网时页面与写作资产仍可加载。

---

## 5. 装机流程（拿到 CI 产出的未签名 .ipa 之后）

> 现状口径（2026-11-06，方案 D 落地后）：CI 在 `macos-15` 上产出**未签名** `DSHRemote-unsigned.ipa`，
> 本机用 **iLoader** 以免费 Apple ID 重签并侧载。Phase 2.1 曾用 Sideloadly 验证过含 Go 动态框架的包
> 可被整包重签；最终装机以 iLoader 为准（2026-11-06 run-42166079900 已真机侧载通过）。

1. Windows 打开 **iLoader** → USB 连 iPad → 拖入 `DSHRemote-unsigned.ipa` → 填 Apple ID → 重签并安装
   （iLoader 会对 app 本体与 `Frameworks/` 内的 TailscaleKit 动态框架**一并重签**）。
2. iPad 上：设置 → 通用 → VPN与设备管理 → 信任该开发者证书。
3. **免费 Apple ID 签名有效期 7 天** ⇒ 到期 App 打不开（证书失效），需重新走第 1 步重签重装；
   想免 7 天节奏需 99 USD/年付费账号 + TestFlight。重签重装**不丢**节点登录态——节点态存在
   App 沙盒 `Documents/tailscale`，只要不在 App 内点「彻底清除」，覆盖安装后仍可自动恢复上线。
4. ✅ **无需另装 Tailscale App**：方案 D 已把 tailscale 节点以 `TailscaleKit.framework` 内嵌进本壳，
   首次在 App 内「TS」设置页粘一次 auth key 入网即可，不创建系统 VPN、不牵引其他 App 流量。

### 5.1 包体增量（方案 D 内嵌节点带来的体积变化）

| 产物 | 体积 | 说明 |
|---|---|---|
| 内嵌前 ipa（2026-10，纯壳 v0.2.5） | 约 **0.44–0.54 MB** | 无 Go 运行时 |
| 内嵌后 ipa（2026-11-06，run-42166079900） | **8,870,461 B（约 8.46 MiB）** | 含压缩后的 Go 静态库 |
| └ 包内 `TailscaleKit` 动态库（未压缩） | **22,356,392 B（约 21.3 MiB）** | Go c-archive 主体，ipa 内被 zip 压缩 |
| └ 主二进制 `DSHRemote`（未压缩） | 2,400,464 B（约 2.29 MiB） | 仅 `LC_LOAD_DYLIB` 引用 TailscaleKit，自身不含 Go |

⇒ 净增主要来自内嵌的 TailscaleKit（约 +8.3 MiB ipa / +21 MiB 安装后），属一次性固定成本，不随使用增长。
CI 在 `ios-build.yml` 里以「embed dylib ≥ 20 MB + 主二进制 `otool -L` 含 TailscaleKit + dylib 导出
`tailscale_*` 符号」三项硬自检，防止产出看似成功但没链上 Go 的假包。

### 5.2 TailscaleKit 构建与版本复现

- **版本真源**：[Vendor/TAILSCALEKIT.VERSION](Vendor/TAILSCALEKIT.VERSION)（入 git）。当前钉
  `libtailscale` commit `d1dc45d0…`（binding **0.2.0** / 内核 **v1.104.1** / Go **1.27.1**），不追 main 浮动 tag。
  `Vendor/TailscaleKit.xcframework` 是生成物、被 gitignore，不入库。
- **本地/CI 复现（仅 macOS）**：`tools/build-tailscalekit.sh`（`--force` 删缓存重建）。脚本读 VERSION →
  浅克隆钉死 commit → `cd swift && make ios-fat`（device arm64 + simulator arm64/x86_64 三切片）→
  落到 `Vendor/`。脚本在 make 前把上游 pbxproj 写死的 6 处 `IPHONEOS_DEPLOYMENT_TARGET=18.1` sed 成 **17.0**
  （export 环境变量已被 run 40345456800 证伪：pbxproj 显式值优先级更高），使产物 minos 与本工程统一为 17.0。
- **CI 流程（`.github/workflows/ios-build.yml`，runner `macos-15`）**：job `tailscalekit-gate` 跑构建脚本并以
  `vtool` 断言两切片 minos=17.0（闸门 A）→ job `build` 模拟器跑单测、Release iphoneos 出未签名 ipa，
  再做 PLIST_KEYS_CHECK 与 TailscaleKit LINK_CHECK。升级依赖 = 改 VERSION 并在 plan 留痕，等 CI 全绿。
