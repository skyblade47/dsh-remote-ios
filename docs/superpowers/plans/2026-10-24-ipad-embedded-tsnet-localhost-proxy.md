# 方案 D：iPad 壳内嵌 tailscale 节点（libtailscale/TailscaleKit）+ localhost 反代 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **先评审、后实现；未获明确批准不得改工程结构/CI、不得动 Tailscale ACL 之外的服务端、不得 commit/push。**

**北极星（用户原话，跨方案不变）：**「我需要确保的是自动保存和上传同步可用。最后，才是内核可用。」方案 D 的全部价值排序同样是：**通道冗余先保证「自动保存（本地 outbox，已封板）→ 上传同步（经内嵌节点到 dsh-cloud）在海外弱网可达」，其次才谈内核页完整加载。**

**Goal:** 在不上 App Store、免费 Apple ID 自签侧载、部署目标 iOS 17、纯自用前提下，把 iPad 壳从「虚拟 https origin（`local.dsh-remote.invalid`）+ WKURLSchemeHandler 白名单拦截 + HTMLRewriter 内联」收敛为与 PC 同构的形态：**App 进程内嵌用户态 tailscale 节点 + `127.0.0.1` 本地 HTTP 反代 + WKWebView 固定加载 `http://127.0.0.1:<port>/__shell__/shell.html`**，获得①WireGuard P2P 直连 ②自建 DERP（方案 C region 900）TCP/443 兜底 ③Funnel https 应急 三档通道，且 `127.0.0.1` 是安全上下文（根 SW / 内核 v5 SW / getUserMedia 一并成立）。

**Spec 锚点：** [dsh-remote 仓 spec](../../../dsh-remote/docs/superpowers/specs/2026-10-22-overseas-delivery-tsnet-voice-design.md) §5（方案 D）、§5.5 入口顺位、§5.7 验收、§7.1（方案 E-iOS 随 D 落地）、§8.1 iPad 目标、§11；方案 C 计划（DERP region 900 已上线，作为线路②）。

**前置事实（2026-10-24 双路调研结论，本计划据此修正 spec 的若干旧假设）：**

1. **选型定案：官方 `tailscale/libtailscale`（c-archive，C ABI）+ 仓内官方 Swift 6 封装 `TailscaleKit.xcframework`**。2026-10 仍高度活跃（binding **0.2.0** / tailscale **v1.104.1**），GHA `macos-15` 每提交构建 iOS 真机/模拟器切片，附官方示例 `TailscaleKitHello`。**放弃** gomobile 裸 bind tsnet（无官方 iOS 支持/示例）与复用官方闭源 GUI（系统 VPN 方向相反且源码不在公开仓）两条路。
2. **不需要 Network Extension entitlement、不创建系统 VPN、不牵引其他 App 流量**：官方示例 entitlements 无任何 NE 键；且 Apple DTS 明确免费 Personal Team 根本不支持 NE capability —— 故用户态 netstack 是本场景**唯一**可行路线，免费账号可签。
3. **数据面 API 齐备**：C 头提供 `tailscale_dial(tcp/udp)`、`tailscale_listen/accept`（unix socketpair + fd-passing，2026-10 已定长 64 字节成帧，修复 #18310）、`tailscale_loopback`（SOCKS5+LocalAPI）、`tailscale_set_authkey/control_url/dir/ephemeral`、`tailscale_status_json`。Swift 层有 `TailscaleNode`、`OutgoingConnection`、`URLSessionConfiguration.tailscaleSession`。
4. **关键修正（spec §5.4 的反代底座）**：`tailscaleSession` 的 SOCKS5 配置**只作用于 URLSession，不会自动作用于 WKWebView**（无官方说明，列为 spike）。因此给 WebView 用的 localhost 反代，底座明确为：**本地 `NWListener`(仅 127.0.0.1) 每入站一连接 → `tailscale_dial("tcp","100.99.84.35:8080")` 拿 fd → 双向字节桥**（出站版 TailnetBridge；阻塞 C 调用放 GCD/detached，不放 Swift cooperative 线程）。HTTP 请求/响应、`Connection: Upgrade` 的 WebSocket、SSE 都在这条 TCP 字节桥上逐字节透传。
5. **iOS 17 工程落差**：TailscaleKit 源码 2026-08 已做 API gating 支持 iOS 17.0，但**其 xcodeproj 仍写 `IPHONEOS_DEPLOYMENT_TARGET=18.1`**，集成时必须以 xcconfig/构建参数把 TailscaleKit 与 App 统一压到 17.0。
6. **后台挂起硬点（官方 issue [#20060](https://github.com/tailscale/tailscale/issues/20060)，调研当日仍 open）**：App 挂起后 iOS 回收用户态节点 loopback listener，缓存地址永久失效；恢复需重建节点数据面/桥接。这决定 Task 6 的前后台重建设计，且必须真机验证，不假定自愈。
7. **壳资产实测 18 件（非 spec/旧文常说的 17）**：3 CSS + 15 JS；shell.html 自身在 Bundle 由反代直出。
8. **共享 JS 天然兼容**：ShellAssets 中除 `ipad.js`/`ipad.css` 外全部 fetch 已是同源根相对路径、注释按 `http://127.0.0.1:<port>` 反代编写；[outbox-drain 计划](../../dsh-remote-ios/docs/superpowers/plans/2026-10-24-ipad-outbox-drain.md)的上传通道 `POST /writing-studio/api/clientZoneSave` 与 origin 解耦，反代正确转发后自动受益，**不改同步内核**。
9. **两个必须给替代的旧假设**：① `ipad.js` 用 `location.hostname !== 'local.dsh-remote.invalid'` 判定「网关是否已配置」，迁移后 hostname 恒为 127.0.0.1，该判定恒真 —— 需改为由原生桥注入的「节点/反代上游状态」信号；② 现状 Cookie 种在文档 origin（虚拟网关域），迁移后 Cookie 种在 `127.0.0.1`，上游 Cookie 由反代透传 —— 反代必须正确双向转发 `Set-Cookie`/`Cookie` 与 `Secure;SameSite` 在 http loopback 下的实测行为。
10. **环境约束（执行者须知）**：实现/调试机当前为 Windows，**所有 xcodebuild / 真机 / xcodegen 动作必须在 macOS（本机或 CI `macos-15`）完成**；Windows 侧只能改 Swift/JS/yml 文本。CI 是唯一无 Mac 时的构建真值来源。

---

## 0. 全局约定（每个 Task 适用）

1. **分阶段闸门**：Phase 1（产物可构建）与 Phase 2（最小真机 spike）是**排雷闸门**，未过不得进入 Phase 3+ 的大重构。每个闸门需明确 go/no-go 证据后才继续。
2. **凭据只用不存盘**：Tailscale **auth key** 仅在生成时由用户粘贴进 App 设置页 → Keychain；**绝不打进包、不入 git、不入日志、不写 plan**。Tailscale 控制台对该 key 建议 reusable + tag、按需关过期、可随时吊销。构建用的任何签名身份走 CI/Xcode secret，不入库。
3. **默认不 commit/push**；每个 Phase 结束等指令再提交。分支建议 `feature/embedded-tsnet`（现状基线分支 `feature/m0-m1-shell`，开工前确认起点）。
4. 不改上游内核包/批包/rev/同步代码；不改 PC/安卓；不改服务端（方案 C 已就绪，本方案是其客户端消费方；唯一可能的服务端动作是在 Tailscale 控制台为 iPad 节点建 tag/ACL，需单独授权）。
5. 文本文件 UTF-8、LF；Swift 风格对齐仓内现有文件（SPM 无、XcodeGen 管工程，`project.yml` 为工程唯一真源，不手改 .xcodeproj）。
6. 「失败上屏」纪律沿用：节点未认证/启动中/上线（显示 tailnet IP）/失败原因，均复用现有加载失败浮层，不假装在线；通道探测仍以 `GET <base>/auth/login` 返回 200 为业务可达判据。
7. 三方版本钉死、可复现：libtailscale 以 **commit SHA + binding/tailscale 版本**记录在构建脚本与 README，不追 main 浮动 tag。
8. **Mac/真机动作显式标注 `[macOS]`/`[真机]`/`[CI]`**；Windows 可做的标注 `[Win]`（纯文本编辑）。

---

## 1. File Structure（职责边界，iOS 仓 `dsh-remote-ios`）

| 文件 | 职责 | 动作 |
|---|---|---|
| `tools/build-tailscalekit.sh` | 钉版本拉取 libtailscale（commit SHA）→ `make ios-fat` → 把 `TailscaleKit.xcframework` 与来源/版本元数据落到 `Vendor/`；幂等、可在 macos runner 与本地 Mac 复跑 | **新增（Phase 1）** |
| `Vendor/TailscaleKit.xcframework` | 官方 Swift 封装 + Go 静态库产物（device+simulator 切片） | **生成物，gitignore（默认不入 git，CI/脚本重建）** |
| `Vendor/TAILSCALEKIT.VERSION` | commit SHA / binding / tailscale 版本 / 构建时间 / Xcode 版本 | **新增（入 git，唯一版本真源）** |
| `Sources/Tailnet/TailnetNode.swift` | 包 `TailscaleKit.TailscaleNode`：auth key（Keychain 读）、状态目录（Documents/tailscale）、up/down、状态机、IP/statusJSON | **新增（Phase 3）** |
| `Sources/Tailnet/TailnetAuthStore.swift` | auth key 的 Keychain 存取（kSecAttrAccessibleAfterFirstUnlock，不入 UserDefaults/日志） | **新增（Phase 3）** |
| `Sources/Proxy/LoopbackProxy.swift` | `NWListener` 仅绑 127.0.0.1 动态端口；路由：壳资产本地应答 + 其余经 tailnet 桥；返回实际端口 | **新增（Phase 4，核心）** |
| `Sources/Proxy/TailnetConnecter.swift` | 封装 `tailscale_dial("tcp",…)` fd 桥（GCD queue，64KB 双向拷贝，EINTR/半关闭联动） | **新增（Phase 2 spike 先行雏形 / Phase 4 定稿）** |
| `Sources/Proxy/ShellAssetRoutes.swift` | 18 件白名单 + `/__shell__/shell.html` 的本地 HTTP 应答（content-type、`cache-control: no-store`），迁移自 AssetManifest/ShellSchemeHandler | **新增（Phase 4）** |
| `Sources/Proxy/ShellHTMLInjector.swift` | 在返回 shell.html 时注入 ipad.css/ipad.js（接管 ShellHTMLRewriter 的注入职责；**不再做 scheme 改写与全量内联**） | **新增（Phase 4）** |
| `Sources/Proxy/HttpBridge.swift` | HTTP/1.1 请求解析与响应回写、`Host`/Cookie/Set-Cookie/转发头处理、`Connection: Upgrade`(WS) 与 SSE 逐字节透传 | **新增（Phase 4，最高复杂度）** |
| `Sources/Settings/TailnetSettingsView.swift` | 设置页「Tailscale 认证」：粘贴 key、状态机展示（未认证/启动中/已上线+IP/失败原因） | **新增（Phase 3）** |
| `Sources/GatewayURL.swift` | 由「只收 https」改为**通道分流归一化**：localhost 主线（内部生成，不接受手填 http 网关）+ Funnel https 应急 | **重写契约（Phase 5）** |
| `Sources/ShellWebView.swift` | 固定 `load(http://127.0.0.1:<port>/__shell__/shell.html)`；删除 dsh-asset 装载路径；保留 BridgeJS document-start 注入与 dshBridge messageHandler | **改造（Phase 5）** |
| `Sources/ShellOrigin.swift` | 占位 origin 三态模型 | **废弃删除（Phase 5）** |
| `Sources/ShellSchemeHandler.swift` | dsh-asset WKURLSchemeHandler | **废弃删除（Phase 5）** |
| `Sources/ShellHTMLRewriter.swift` | scheme 改写 + 全量内联 | **废弃删除（注入职责移 ShellHTMLInjector，Phase 5）** |
| `Sources/AssetManifest.swift` | 18 件清单/content-type | **保留并被 ShellAssetRoutes 复用** |
| `Sources/S1ViewController.swift` / `S1ProbePage.swift` | 登录种 Cookie + 五探针 | **改造**：探针改为「本地反代健康 + 经反代的网关连通」，origin 期望改 localhost；登录走反代（Phase 5） |
| `Sources/App.swift` | 去「改网关即 `.id(token)` 重建 WebView 换 baseURL」；改为节点/反代状态驱动；前后台事件接节点重建 | **改造（Phase 5/6）** |
| `ShellAssets/ipad.js` | `gatewayConfigured()` 的 hostname 判定 → 改为读原生注入的节点/上游状态；outbox drain 安装闸门随之改信号源 | **小改（Phase 5/6，18 件中唯一允许改的业务 JS）** |
| `Sources/BridgeJS.swift` | 保留 `ownsHost:true` 与 49 方法；新增向页面注入「tailnet 状态/本地 base」的最小引导；同步 XHR `dsh-bridge://sync` 去留随 Phase 5 决策（优先保留 messageHandler 异步通道，同步写盘通道评估改反代 HTTP 端点） | **小改（Phase 5）** |
| `Resources/Info.plist` | 加 `NSAllowsLocalNetworking`；评估原生 URLSession tailnet 明文的 ATS 例外（反代到节点是 loopback，节点到 100.x 在 netstack 内不受 ATS 约束，需 spike 确认）；加 `NSMicrophoneUsageDescription`（方案 E-iOS） | **改（Phase 4/7）** |
| `project.yml` | 加 `Vendor/TailscaleKit.xcframework` binary/framework 依赖、部署目标统一 17.0、麦克风权限串 | **改（Phase 1/7）** |
| `.github/workflows/ios-build.yml` | runner 升 `macos-15`、装 Go（按 libtailscale go.mod 的版本，**不照抄其 CI yaml 的 1.24**）、Xcode 16.1+、跑 build 脚本再 xcodegen/xcodebuild；缓存 Go 与 libtailscale 构建 | **改（Phase 1）** |
| `.gitignore` | 忽略 `Vendor/TailscaleKit.xcframework/`（保留 VERSION 入仓） | **改（Phase 1）** |
| `README.md` | 架构章 §0.1/§3/§4 从「方案 B ownsHost 注入」改写为「内嵌节点 + localhost 反代」；记录 xcframework 来源版本与构建法 | **回填（Phase 7）** |
| 数据/同步内核 | `WorkspaceStore`/`AppDataStore`/`OutboxStore`/`PathGuard`/`BackgroundFlusher`/`BridgeDispatcher`/`NativeBridge` | **零改动**（AppDataStore 仅 gateway 校验口径随契约调整） |

> 明确**不新增**系统 VPN / Network Extension target、不新增 app group/extension；节点状态在主 App 沙盒 Documents/tailscale。

---

## 2. 阶段与任务

### Phase 0 — 评审与开工基线（不改代码）

- [x] **0.1** 用户评审本计划；确认分支起点（`feature/m0-m1-shell` 或当前 outbox 分支合入后），建 `feature/embedded-tsnet`。
      — 2026-10-25：用户指令「先 commit，然后开始方案 d」视为授权开工；从已封板的 `feature/ipad-outbox-drain`（本地领先 origin 2 提交，北极星上传同步依赖 outbox）切出 `feature/embedded-tsnet`。
- [x] **0.2** 确认 Tailscale 侧准备（控制台动作，用户执行/授权）：生成一个**专用 auth key**（建议 reusable、打 tag 如 `tag:ipad`、按需 ephemeral 取舍——ephemeral 每次上线换节点名，自用固定设备建议**非** ephemeral 以便 ACL/IP 稳定）；确认 ACL 允许该 tag 访问 `dsh-cloud:8080`（或先沿用个人账号权限）。**key 只在 Phase 3 设置页用一次，不发在对话/文件里。**
      — 2026-10-25：用户确认专用 auth key 已在控制台生成完毕（按 tag:ipad / reusable / 非 ephemeral 要求），key 内容只留在用户本机，全程未入对话、不入仓；Phase 2.2 真机入网时由用户本机注入一次。
- [ ] **0.3** 确认 Mac/CI 构建条件：可用的 macOS（Xcode 16.1+，Go 版本按 libtailscale `go.mod` 当日核对）、iPad 真机 + 免费 Apple ID、数据线/开发者模式；无 Mac 则确认以 `macos-15` CI 产出可安装 ipa 的流程（侧载仍需 Mac/Xcode，确认用户侧最终装机手段）。
- [x] **0.4** 开工当日重新拉取 libtailscale main，核对 Makefile / `swift/Makefile` / `.github/workflows/swift.yml` / `tailscale.h` 与本计划前置事实（迭代极快，防止版本漂移）；把选定 commit SHA 记入 `Vendor/TAILSCALEKIT.VERSION`（文件在 1.x 真正构建时落地，此处先在 plan 记录 SHA 候选）。
      — 2026-10-25 一手核对（GitHub main 当日）：pin `d1dc45d039edb7759ecbee6ba2aea0c4bca884b8`（2026-10-14，binding 0.2.0，含 listener fd-passing 定长记录安全修复 258321b），内核 v1.104.1，**go.mod 要求 Go 1.27.1**（计划初稿的 1.24.x 作废；上游 `.github/workflows/swift.yml` 仍写 setup-go 1.24，已过时，勿抄）；pbxproj 两个 iOS target 写死 `IPHONEOS_DEPLOYMENT_TARGET=18.1` 且 Swift 源码无 `@available(iOS 17` gating，Go clangwrap 用 `-mios-version-min=12.0`；sim 切片 arm64+x86_64 经 lipo 合成。全部固化进 VERSION。

### Phase 1 — 闸门 A：xcframework 可复现构建（先解决「能不能造出来」）

- [x] **1.1** `[macOS/CI]` 新增 `tools/build-tailscalekit.sh`：set -euo pipefail；读 `Vendor/TAILSCALEKIT.VERSION` 的 commit SHA；浅克隆 libtailscale 到工作缓存 → `cd swift && make ios-fat`（必要时传部署目标 17.0 的覆盖）→ 产物拷到 `Vendor/TailscaleKit.xcframework`；打印切片 `lipo -info`/`xcodebuild -create-xcframework` 结果与版本。脚本不持任何密钥。
- [x] **1.2** `[CI]` 改 `.github/workflows/ios-build.yml`：`macos-15`、setup-go（版本以 libtailscale go.mod 为准，开工核对）、选 Xcode 16.1+、先跑 build 脚本，再 xcodegen → 模拟器 build/test；加 Go/build 缓存。此步先**只构建 xcframework 并验证其切片**，暂不链接进 App。
      — 2026-10-25 落地：新增独立 job `tailscalekit-gate`（macos-15；选最高 Xcode；setup-go@v5 1.27.1 **cache: false**——源码由脚本运行时克隆，checkout 时无 go.sum；跑 `tools/build-tailscalekit.sh --force`；PlistBuddy+find 定位两切片，`lipo -archs` 断言 device=arm64、sim=arm64+x86_64；追加 **iOS 17.0 命令行覆盖探测**，非阻断只留证 IOS17_OVERRIDE=PASS/FAIL；上传 xcframework artifact，if-no-files-found: error）。原 `build` job 加 `needs: tailscalekit-gate`，其模拟器 test/未签名 ipa 流程不动。触发：push `feature/embedded-tsnet`、PR→main、手动、v* tag。Go 内置缓存按实况不适用（浅克隆单 commit），以脚本幂等复用 `.tailscalekit-src` 代替。
- [x] **1.3** `[Win/macOS]` 改 `.gitignore` 忽略 `Vendor/TailscaleKit.xcframework/`；新增并提交 `Vendor/TAILSCALEKIT.VERSION`（纯文本，SHA/版本/构建说明）。
      — 2026-10-25：`.gitignore` 加 `Vendor/TailscaleKit.xcframework/` 与 `.tailscalekit-src/`；新增 `.gitattributes` 钉 `*.sh text eol=lf`（本机 autocrlf=true，已验脚本工作区 0 个 CRLF、check-attr eol=lf）。
- [x] **1.4 闸门 A 验收（go/no-go）**：CI 上 `TailscaleKit.xcframework` 成功产出，含 `iphoneos/arm64` 与 `iphonesimulator/arm64`（如需要可加 x86_64 sim）切片；部署目标可压到 17.0 无构建错误；产物体积记录（对照社区 device .a ≈ 23 MB）。**若官方 Makefile 在当日 main 无法产出或强制 iOS 18，停点回报，评估 pin 旧 commit / 自建 xcframework 包装。**
      — 2026-10-25 CI run [40157605250](https://github.com/skyblade47/dsh-remote-ios/actions/runs/40157605250) 全绿（gate 2m11s，整链 3m40s，macos-15 / Xcode 26.3 / go1.27.1 darwin/arm64）：**SLICE_CHECK=PASS**（device=arm64、sim=x86_64+arm64）；**IOS17_OVERRIDE=PASS**（在 `swift/` 子目录 `xcodebuild build -scheme "TailscaleKit (iOS)" IPHONEOS_DEPLOYMENT_TARGET=17.0 CODE_SIGNING_ALLOWED=NO`，rc=0，无 iOS 18 only API 编译错误）；artifact `TailscaleKit-xcframework` 压缩后 24.6 MB，与社区 device .a ≈23 MB 同量级。正式产物 vtool minos 仍 18.1（脚本按上游原样构建），17.0 仅证明覆盖可行，**链接进 App 后的真实最低系统验证留待 3.1**。原 `build` job（macos-14 模拟器 test + 未签名 ipa）在 gate 之后同样通过，无回归。**闸门 A 结论：GO。**

### Phase 2 — 闸门 B：最小真机 spike（排两个最高风险，不做壳集成）

> 用最小独立 demo（可参考官方 TailscaleKitHello，但在本仓建一个临时 spike target 或独立小工程，**不入最终 target**），只回答四件事，每件要真机证据。

- [ ] **2.1** `[真机]` **免费 Apple ID 自签链接 Go c-archive**：TailscaleKit 以 Embed & Sign 嵌入最小 App，Personal Team 自动签名，真机启动无 entitlement/签名/`0x72613c21` 类错误。
      — 2026-10-25 启动注记：**执行形态确认为「CI 出真包 → Sideloadly 免费 Apple ID 重签 → 真机启动」**（无 Mac，不能走 Xcode 直装）。先解包 run 40164547825 的 ipa 取证：app 二进制仅 ~990KB、包内无任何 framework——彼时工程未链接 TailscaleKit，该包无法回答 2.1。故提前实施 3.1 的链接工作（仅链接、不入网）：①`project.yml` 给 DSHRemote 加 `Vendor/TailscaleKit.xcframework` 依赖（`embed: false` 静态链接）+ 按 sdk 切片的 `-force_load`（Go c-archive 单 fat binary，普通链接会按目标文件裁掉 cgo/Go 运行时）；②新增 `Sources/TailscaleSpike.swift` 编译期探针，只引用 iOS 17 可用符号（`kDefaultControlURL`、`NetProtocol.tcp`），**不构造 TailscaleNode、不碰 key**；③build job 改 macos-15（swiftinterface 由 Xcode 26/Swift 6.2.4 产出，macos-14 的 16.x 消费不了）、xcodegen 前 download-artifact 取 gate 的 xcframework、Release 后加硬自检（主二进制 ≥20MB 且 `nm -gU` 必须含 `_tailscale_dial`/`_tailscale_new`，否则判红——避免又出一个看似成功但没链 Go 的假包）。真机重签/启动结论仍待用户侧 Sideloadly 窗口，本条保持未勾选。
- [ ] **2.2** `[真机]` **auth key 非交互入网**：粘贴 key → `TailscaleNode` up → 控制台出现该节点、App 内显示 tailnet IP；杀进程重启登录态保留（状态目录 Documents/tailscale）；Tailscale 控制台可吊销验证失败上屏。
- [ ] **2.3** `[真机]` **进程内 dial tailnet 明文口**：用 `tailscale_dial("tcp","100.99.84.35:8080")`（或先 tailscaleSession 作对照）GET `/auth/login` 拿到 200，证明节点能到 dsh-cloud 网关明文口；记录在 WiFi/蜂窝分别表现。
- [ ] **2.4** `[真机]` **WKWebView 走本地桥（最高风险）**：起 `NWListener@127.0.0.1` → 每连接 `tailscale_dial` 桥到 `100.99.84.35:8080` → WKWebView 加载 `http://127.0.0.1:<port>/auth/login`，确认页面与 Cookie 可用；再用一个 WS 端点（或临时回声）验证 `Connection: Upgrade` 可逐字节双向。**这一步证伪/证实「WKWebView 不经 URLSession 代理、必须自建桥」的判断。**
- [ ] **2.5** `[真机]` **弱网三档**：①正常 WiFi 期望 P2P 直连（节点 status/延迟佐证）；②防火墙/路由器封 UDP 41641（或等价手段）期望自动回落 **DERP(sha/region 900)**；③关节点或登出期望明确失败态（为线路③留口）。记录切换耗时。
- [ ] **2.6** `[真机]` **后台挂起（issue #20060）**：进后台 ≥30s 回前台，测 loopback/数据面是否失效、需要何种重建（重 bind/重新 dial/节点重 up）与耗时；固化为 Task 6 的重建策略。
- [ ] **2.7 闸门 B 验收（go/no-go）**：2.1–2.6 全部有真机结论（成功或明确的失败+替代）。**若 2.4 自建桥在真机不可行或 WS 无法透传，停点评审**（替代：研究 WKWebView 网络层其他牵引手段，或接受内核页仅 Funnel、本地反代只服务同步 API —— 但那违背北极星的通道目标，需用户裁决）。spike 代码在结论固化后删除，经验回填本 plan 与 spec §5.6。

### Phase 3 — 入网认证与节点生命周期（工程化，非 spike）

- [ ] **3.1** `project.yml` 正式链接 `Vendor/TailscaleKit.xcframework`（Embed & Sign），部署目标统一 17.0；先保证现有 App 仍能构建（功能不变）。
- [ ] **3.2** 新增 `TailnetAuthStore`（Keychain）与 `TailnetNode`（状态机：idle/unauthenticated/starting/online(IP)/failed(reason)；配置 controlURL 默认官方、dir=Documents/tailscale、hostName 固定如 `dsh-ipad`、非 ephemeral）；阻塞 `up()` 放 detached/GCD。
- [ ] **3.3** 新增设置页「Tailscale 认证」：粘贴 key（安全输入框、不回显、不进日志）→ 存 Keychain → 启动节点 → 展示状态与 tailnet IP；支持登出/清除（吊销本地状态）。从现有标题/设置入口进入（沿用 App.swift 连点进 S1 附近的入口风格，不破坏现有网关设置）。
- [ ] **3.4** 单测：auth store（Keychain 替身）、状态机迁移、失败原因；不依赖真网络的部分进 CI 模拟器测试。
- [ ] **3.5 验收**：模拟器/真机构建通过；真机入网一次、杀进程保活、Keychain 之外 grep 不到明文 key（日志/沙盒 plist/UserDefaults 抽查）。

### Phase 4 — localhost 反代（本方案最大改动，HTTP+WS+资产）

- [ ] **4.1** `TailnetConnecter` 定稿：封装官方数据面 dial，GCD queue 接受/桥接，64KB 双向拷贝，处理 EINTR、对端半关闭、本地侧关闭联动、错误回收；单测用本地假 TCP 上游（不经 tailnet）验证字节无损与拆除。<!-- 2026-10-25 进度：纯逻辑层（DuplexChannel/UpstreamConnecter 协议 + ByteBridge 64KB 双向桥 + 单 FIN 拆除）与假上游字节无损单测已完成并 CI 跑绿；真机 NWConnection/tailscale_dial 实现留 2.4/3.1，本项待真机实现后勾选。 -->
- [x] **4.2** `ShellAssetRoutes`：18 件白名单（迁移 AssetManifest 映射）+ `/__shell__/shell.html` 本地应答，正确 content-type、`cache-control: no-store`、路径穿越防护（仅允许 manifest 内名字）。<!-- 2026-10-25 完成：loadData 注入式，穿越/陌生名 7 用例 + 18 资产 + HEAD/405 单测全绿。 -->
- [x] **4.3** `ShellHTMLInjector`：仅承担把 `ipad.css`（在 writing.css 锚点后）、`ipad.js`（在 sync-net.js 锚点后）注入 shell.html（锚点与现 ShellHTMLRewriter 一致）；**不做** dsh-asset 改写、**不做**全量内联（真 http origin 下子资源由本反代正常服务，2026-10-12 的自定义 scheme 拦截事故不适用，但需在 Task 5.2 真机确认 `<script src>/<link href>` 正常加载）。<!-- 2026-10-25 完成：两处注入 + 幂等 + 缺锚点原样，3 单测全绿。 -->
- [x] **4.4** `HttpBridge`：HTTP/1.1 解析与回写；路由分流（壳资产本地；其余全部桥到 `100.99.84.35:8080`）；转发 `Host`（按上游网关要求，参照 PC main.js createProxy 的 changeOrigin 处理）、`Cookie`/`Set-Cookie`、过滤 hop-by-hop 头；**WebSocket**：识别 `Connection: Upgrade` + `Upgrade: websocket`，回写 101 后进入裸 TCP 双向透传；**SSE/长响应**：不缓冲、流式回写、不设整体超时。<!-- 2026-10-25 完成（逻辑层）：HTTPHeadCodec 编解码 + HttpBridge 分流/502；Host 重写修复（先弃原 Host 再重写，避免双 Host）；WS/大响应经内存桥端到端单测覆盖。NWListener 接入留 4.5。 -->
- [x] **4.5** `LoopbackProxy`：`NWListener` 绑 `127.0.0.1:0` 取动态端口，仅 loopback；启动后把实际 base 持久化 UserDefaults（供冷启动直达）；节点离线时返回友好 502/状态页（接失败浮层信号），不挂起。<!-- 2026-10-25 完成（设备无关半边）：NWParameters.requiredLocalEndpoint 锁 127.0.0.1 + on:.any 动态端口；NWConnectionChannel（NWConnection→DuplexChannel，AsyncStream 续体化接收，读错误降级流终结）同时服务 listener 侧与未来 tailscale_dial 拨出侧；base 写 UserDefaults；502 经真实 TCP 回客户端。run 40164547825 模拟器 233 测试 0 失败（新增 5 例：真实 TCP API 往返+Host 重写/壳 ping 本地/502/端口持久化/300KB 跨片字节无损）。真机 dial 实现留 2.4/3.1，失败浮层 UI 接线留 Phase 5。 -->
- [ ] **4.6** Info.plist：加 `NSAllowsLocalNetworking`；按 spike 结论核对 ATS（WKWebView 加载 loopback http；netstack 内到 100.x 的明文是否完全不经 ATS，以 2.3/2.4 实测为准）。
- [x] **4.7** 单测（模拟器，不经真 tailnet，用本地起的 HTTP/WS 假上游顶替 `100.x`）：18 资产 200/content-type/防穿越；shell.html 含两处注入且幂等；普通 API 往返与头透传；大响应流式；WS echo 双向；上游拒绝时 502。把 spike 的 fd 桥接以协议抽象注入，保证可测。<!-- 2026-10-25 完成：DuplexChannel/UpstreamConnecter 协议注入 + InMemoryChannel/FakeConnecter（jsonEcho/largeResponse/webSocket 三模式）；run 40161659357 模拟器 228 测试 0 失败。 -->
- [ ] **4.8 验收**：反代在模拟器对假上游全绿；真机对真节点（Phase 3）能加载 `/auth/login` 与一个 WS 场景。

### Phase 5 — 壳架构收敛到 localhost（删除旧三件套）

- [ ] **5.1** `ShellWebView` 改为固定加载 `http://127.0.0.1:<port>/__shell__/shell.html`；保留 BridgeJS document-start（forMainFrameOnly:false）与 dshBridge；移除 dsh-asset scheme 注册与 loadHTMLString+rewrite 路径。
- [ ] **5.2** 真机确认 18 资产以普通 `<script src>/<link href>`（http origin）正常加载执行（推翻/确认 2026-10-12 自定义 scheme 拦截在真 http 下不复现）；shell.html `#diag` 自检首次真正满足「hostname=回环、iframe 同源」。
- [ ] **5.3** `GatewayURL` 契约重写：区分**内部主线 base**（localhost 反代，程序生成，非用户输入）与**应急 Funnel https**（用户手输，沿用现有校验）；删除 http 禁令对 localhost 主线的影响；同步改 AppDataStore gateway 正则/seed 口径与相关单测（GatewayURLTests、AppDataStoreTests gateway 组）。
- [ ] **5.4** 删除 `ShellOrigin.swift`、`ShellSchemeHandler.swift`、`ShellHTMLRewriter.swift`；删除/重写强耦合测试（ShellSchemeHandlerTests、ShellHTMLRewriterTests、ShellNavigationTests、ShellOriginTests）；AssetManifest 保留改由 ShellAssetRoutes 使用，AssetManifestTests 相应调整。
- [ ] **5.5** `S1ViewController`/`S1ProbePage`：登录种 Cookie 改经 localhost 反代（WebView 加载 loopback 的 `/auth/login`）；五探针重定义——①origin 期望 `http://127.0.0.1:<port>`；②`GET /auth/login` 经反代 200；③iframe `/app#/` CSP frame-ancestors 在同源成立；④壳资产本地可达；⑤dshBridge（同步写盘通道按 5.6 决策）。
- [ ] **5.6** 同步写盘通道决策：现状 `dsh-bridge://sync` 同步 XHR 在 https origin 真机可用（S1 探针⑤佐证），迁到 http loopback 后**先实测自定义 scheme XHR 是否仍可用**；可用则保留 BridgeSyncSchemeHandler（最小改动）；不可用则在 loopback 反代加一个仅本地的 `POST /__local__/sync` 同步端点直连 BridgeSyncBridge。二选一，以真机结论为准，避免无谓重写。
- [ ] **5.7** `App.swift`：去掉「改网关即重建 WebView 换 baseURL」；localhost origin 恒定，变化的是节点/反代上游状态；Funnel 应急切换才需要重建（或单独导航）。前后台事件预留 Task 6。
- [ ] **5.8** `ipad.js`：`gatewayConfigured()` 改读原生注入信号（BridgeJS 增加 `globalThis.__DSH_TAILNET__={state, base, reachable}` 或等价），替换 hostname 白名单；about:blank 撤回、会话探针、outbox drain 安装闸门（含 outbox 计划 Task 4.4 场景 9 语义）全部改用新信号；**不改 outbox 上报 URL（仍同源相对路径）**。同步更新受影响的注入/装配断言（原 ShellHTMLRewriterTests 删除后，注入保障改由 ShellHTMLInjector 单测承担）。
- [ ] **5.9 验收**：真机 localhost 主线加载壳 → 登录 → iframe `/app`（内核页）→ 18 资产、Cookie、WS 全通；模拟器 CI 测试全绿；旧三件套与死代码删净（grep 无 `local.dsh-remote.invalid`、无 `dsh-asset`、无 loadHTMLString 壳装载）。

### Phase 6 — 生命周期、三档通道与上传同步（北极星落点）

- [ ] **6.1** 前后台：前台节点常驻；进后台按 iOS 预算保活（复用 BackgroundFlusher 的 beginBackgroundTask 思路做一次 flush，不强保节点）；回前台按 Phase 2.6 结论**主动重建** loopback/数据面（必要时重 bind/重 dial/重 up），重建期间壳显示「tailnet 重连中」浮层，不假装在线；重连成功自动恢复。
- [ ] **6.2** 三档通道状态机：①内嵌节点 P2P（默认）②DERP(sha) 自动兜底（tsnet 内部，UI 只表现为①的连通/延迟）③Funnel https 应急（节点未认证/持续失败时，允许切到现有手输 Funnel 域，WKWebView 直连不经节点）。切换与失败文案沿用「失败上屏」；记录每档可达性与切换耗时。
- [ ] **6.3 上传同步端到端（北极星）**：弱网/断网编辑 → writeDoc 本地落盘 + outbox 入队（既有，零改）→ 回网/通道恢复后 outbox drain 经 localhost 反代 → `POST /writing-studio/api/clientZoneSave` 到 dsh-cloud → 成功出队。验证 P2P 与 DERP 两档下都能 drain；线路③应急时 drain 行为如实（Funnel 通则同路径，不通则留队不丢）。
- [ ] **6.4** 自动保存压力：长文连续编辑、切后台、弱网丢包/高延迟（弱网仪或 Network Link Conditioner）下无丢稿、无重复、无卡死；outbox 计数与服务端最终一致。
- [ ] **6.5** 内核可用性（在同步之后验证）：内核页插件批量加载、二次启动（同 rev 再开/弱网/断网回网）受益于方案 A 缓存 + 新通道；记录冷载/热启耗时，与 Funnel 基线（spec §8.1：冷 45s / 热 10s）对比（**不承诺突破 EIP 带宽物理上限**，只承诺成功率与冗余）。
- [ ] **6.6 验收**：三档切换、前后台重连、上传同步、自动保存全部有真机记录；失败态均有文案、无静默假在线。

### Phase 7 — 语音（方案 E-iOS，随 D 收尾）与打包/文档/验收

- [ ] **7.1** Info.plist 加 `NSMicrophoneUsageDescription`；接 AVAudioSession 录制授权回调（spec §7.1 两缺失）。
- [ ] **7.2** 真机 localhost 安全上下文下：授权弹窗 → 录音（波形有振幅）→ transcribe（服务端 SenseVoice 方案 C 期已验就绪）→ 文本回填；拒绝授权显示 permission 文案不白屏。Funnel https 通道回归一次麦克风（https 也是安全上下文）。
- [ ] **7.3** CI 产物：`CODE_SIGNING_ALLOWED=NO` 未签名 ipa 流程兼容新依赖；确认侧载装机步骤（Xcode 或重签工具）与 7 天重签节奏写入 README；记录包体增量。
- [ ] **7.4** README 架构回填（§0.1/§3/§4）、构建说明（libtailscale 版本/脚本/CI）、三档通道与已知限制（后台挂起、7 天重签、包体、issue #20060）；spec §5/§8 回填「已实施」注记（对齐方案 C 在 spec §4.6 的回填范式）。
- [ ] **7.5** 清理：删除 Phase 2 spike 临时 target/工程；grep 无密钥/无占位 origin/无死代码；全量 CI（模拟器 test + Release iphoneos build）绿。
- [ ] **7.6 总验收（对应 spec §5.7 九场景）**：自签真机；入网一次、杀进程/7 天重签登录态保留；Keychain 之外无明文；18 资产 + `/plugins`(combo/rev) + `/api` + 登录登出 Cookie + CSP iframe `/app` + WS；Secure/SameSite Cookie 在 http://127.0.0.1 实测；三档切换；弱网耗时对比；前后台重连；语音双通道。

---

## 3. 风险与对策（最高优先在前）

| 风险 | 等级 | 对策/闸门 |
|---|---|---|
| WKWebView 无法经自建 fd 桥走 tailnet，或 WS 不能透传 | **高** | Phase 2.4 真机 spike 先行；证伪即停点评审，不投入重构 |
| 免费 AppleID + Go c-archive 真机链接/7 天重签异常 | 高 | Phase 2.1 真机证据；必要时评估付费账号（用户决策） |
| 后台挂起 loopback 失效、回前台不恢复（#20060 未闭环） | 高 | Phase 2.6 摸清重建代价；Task 6.1 主动重建 + 重连浮层，不假设自愈 |
| 反代 HTTP/WS/SSE 透传复杂度（Cookie/Host/101/流式） | 高 | Task 4 单测用假上游全覆盖；参照 PC main.js createProxy 既有正确实现 |
| Cookie 种到 127.0.0.1 后 Secure/SameSite 行为变化致登录不同步 | 中高 | Task 4.4 头透传 + 5.5 真机登录/Cookie 专项；http loopback 是安全上下文但 Cookie 属性需实测 |
| TailscaleKit 强制 iOS 18 / 当日 main 构建漂移 | 中 | pin commit SHA；17.0 覆盖；闸门 A 不通过则 pin 可用旧版 |
| 删旧三件套波及 outbox/会话探针（ipad.js hostname 信号） | 中 | Task 5.8 用原生状态信号替代；outbox 计划场景 9 同步改语义；不改上报 URL |
| 包体 +十几 MB | 低 | 自用可接受（spec §5.2 已确认）；记录数值 |
| 无 Mac 导致无法真机迭代 | 中 | CI macos-15 承担构建真值；但首装/排障仍需 Mac，Phase 0.3 先确认 |

---

## 4. 回滚

- **代码层**：全程在 `feature/embedded-tsnet`，合入前主分支不受影响；每个 Phase 独立可回退；删除 `Vendor/`、还原 project.yml/Info.plist/工作流即回到方案 B 旧壳（git 回退即可，无数据迁移）。
- **节点层**：App 内登出/删除 Documents/tailscale；Tailscale 控制台吊销 auth key / 删除节点即可彻底下线，不影响 dsh-cloud、DERP、Funnel。
- **服务端**：本方案不部署服务端；方案 C 的 DERP 与 Funnel 保持不动，方案 D 失败时 iPad 仍可用现有 Funnel https 应急通道（线路③），不降级现状能力。
- **数据**：本地文档/草稿/outbox 不依赖网络形态，回滚不丢数据（红线，与方案 C 一致：回滚绝不动数据）。

---

## 5. 执行记录（随实施回填）

- 2026-10-24：方案 C 回归 v1–v5 全绿（derper/timer、home 钉官方区、Funnel 10/10 302、封 UDP 走 DERP(sha) 16ms、verify-clients 在位）后启动本计划；完成 libtailscale 技术调研与 iOS 壳现状盘点（见前置事实 1–10）。Phase 0 待评审与授权。
- 2026-10-25（Windows 侧文本作业，无 Xcode）：
  - 方案 C 已提交 dsh-remote `0b1503c`（8 files，+881/-1，未 push；gateway SW / sensevoice 无关改动按纪律留在工作区未夹带）。
  - 0.1：用户指令「先 commit，然后开始方案 d」授权开工；从 `feature/ipad-outbox-drain` 切出 `feature/embedded-tsnet`。
  - 0.4：当日核对 libtailscale main，pin `d1dc45d…` / binding 0.2.0 / 内核 v1.104.1 / Go 1.27.1；关键修正见 0.4 勾选注记（上游 CI 的 1.24 已过时；部署目标 18.1 写死）。
  - 1.1：`tools/build-tailscalekit.sh` 落地（Darwin-only；VERSION 驱动；浅克隆钉 SHA 并 rev-parse 校验；`.built-from` stamp 幂等；`make ios-fat`；lipo/vtool 取证；不持密钥）。
  - 1.2：CI 新增 `tailscalekit-gate` job（独立、先行，原 build job needs 它）：切片三断言 + iOS 17.0 覆盖探测（非阻断）+ artifact 上传；`feature/embedded-tsnet` push 即触发。
  - 1.3：`Vendor/TAILSCALEKIT.VERSION` 入 git；xcframework 与源码缓存 gitignore；新增 .gitattributes 钉 *.sh=LF（已验 0 CRLF）。
  - **下一步闸门**：1.4 必须在 macOS 实证——Windows 无法构建。需用户授权 push 本分支触发 CI（或自备 Mac 本地跑脚本）。1.4 过闸前不动 Phase 2/3 任何工程代码。Phase 0.2（专用 auth key + ACL）、0.3（Mac/真机/免费 Apple ID/侧载手段）仍待用户确认，是 Phase 2 的前置。
  - 用户授权 push（仅 iOS 分支；dsh-remote 方案 C 提交继续留本地）；0.3 确认**无 Mac，只靠 CI macos-15 出包 + 侧载装机**；0.2 auth key 等闸门 A 结果再建。
  - CI 三轮：①run 40156939141 构建步 18s `Permission denied`——Windows 提交的 .sh 无 +x 位（`04ab0a6` 改显式 `bash` 调用修复）；②run 40157200034 切片 PASS 但 17.0 探测 rc=66「directory does not contain an Xcode project」——探测误在源码根执行，xcodeproj 实际在 `swift/`（`a666f13` 改 `cd "$SRC/swift"`、derivedData 改 `build-ios17` 修复）；③run 40157605250 全绿。
  - **1.4 闸门 A 结论 GO**（证据见 1.4 勾选注记）。下一步是 Phase 2 闸门 B 真机 spike；在「无 Mac」前提下，2.1（免费 Apple ID 自签链接 Go c-archive）无法用 Xcode 直接装机，需先确定 CI 产物的重签/侧载工具链（Sideloadly 等）对含 Go c-archive 的 .app 是否可行——这本身就是 2.1 要回答的问题，建议把「CI 出 spike ipa → 侧载工具重签 → 真机启动」作为 2.1 的执行形态。0.2 auth key 现在可以开建。
  - **Phase 4.7（反代纯逻辑层先行）**：用户授权「用户并行建 0.2 auth key，助手先做 4.7，真机窗口就绪再切 Phase 2」。落地 5 源文件（`DuplexChannel`/`UpstreamConnecter` 协议 + `ByteBridge` 64KB 双向桥（withTaskGroup：任一 pump 结束即 cancelAll+双向 close，单 FIN 不死锁）、`ShellAssetRoutes`、`ShellHTMLInjector`、`HTTPHeadCodec`、`HttpBridge`）+ 5 测试文件（`InMemoryChannel` 通道对、`FakeConnecter` 假上游三模式、7 端到端 + 资产/注入/编解码/字节桥用例），全部不经真 tailnet 闭环。
  - CI 四轮（tailscalekit-gate 每轮全绿，未受影响）：①run 40160223356 rc=65——Swift 不为含 named-tuple 数组的 struct 合成 Equatable（`b6d2152` 移除两处 `: Equatable` 修复）；②run 40160714629 rc=65——测试 `out.range(...)` 缺 `of:` 标签（`a76e5e9` 修复）；③run 40160974956 编译通过、228 测试 3 断言失败——测试自身错误：headerEnd upperBound 期望 9 实为 8；含 Bool 的 JSON 误桥接为 `[String:String]`（`130a500` 修复）；④run 40161360550 余 1 失败暴露**生产 bug**：转发时原 Host 未丢弃导致双 Host 头、上游取到 `127.0.0.1:0`（`477435e` 改为先弃 Host 再重写）。
  - **run 40161659357 全绿**：闸门 A + iPad 模拟器 228 测试 0 失败（6.963s）+ Release iphoneos 未签名编译 + ipa artifact 均通过。4.2/4.3/4.4/4.7 勾选；4.1 仅纯逻辑桥完成（注记保留，真机 dial 实现待 2.4/3.1）；4.5/4.6 待真机阶段。
  - **下一步**：等用户 0.2 auth key 状态与 iPad/侧载窗口，进入 Phase 2（2.1 侧载可行性为最高优先未知）。期间不做真机/服务端改动；dsh-remote `0b1503c` 继续留本地。
  - **Phase 4.5（设备无关 loopback 半边）**：趁用户建 auth key 的窗口落地。新增 `NWConnectionChannel`（NWConnection→DuplexChannel；AsyncStream 续体化 receive 循环，init 即建无界流防首字节丢失；读错误/对端 FIN 统一 yield(nil)+finish）与 `LoopbackProxy`（`NWParameters.tcp` + `requiredLocalEndpoint=.hostPort(127.0.0.1, port 0)` 锁 loopback 取动态端口，`on:.any`；ready 续体取实际端口、base 持久化 UserDefaults；新连接包 channel 喂 bridge.handle，stop 关闭全部活动连接）；真机 tailscale_dial 上游半边仍留 2.4/3.1。
  - CI 两轮：①run 40164298376 rc=65 编译 4 错——误写 `NWListener(requiredLocalEndpoint:)`（公开 API 无此初始化器，endpoint 要放在 NWParameters 上；另两条是其级联推断错）+ AsyncIterator 是 mutating、`let iter` 不能 next（`24ed593` 修复）；②**run 40164547825 全绿**：闸门 A 2m6s + iPad 模拟器 **233 测试 0 失败**（新增 LoopbackProxyTests 5 例，真实 loopback TCP 栈闭环，上游仍 FakeConnecter）+ Release 编译 + ipa artifact。4.5 勾选（真机 dial/失败浮层 UI 留后续阶段）。
  - **0.2 完成**：用户确认 tag:ipad / reusable / 非 ephemeral 的专用 auth key 已生成（key 留用户本机，不入对话/仓）。
  - **Phase 2.1 出包改造**：解包 run 40164547825 的 artifact 取证（ipa 0.53MB、主二进制 989.5KB、无 framework），确认当时的包没链 TailscaleKit、不能用于侧载验证。最小改造（提前做 3.1 的链接、不做入网）：`project.yml` 加 xcframework 静态依赖 + sdk 分切片 `-force_load`；新增 `Sources/TailscaleSpike.swift` 仅引用 `kDefaultControlURL`/`NetProtocol.tcp` 两个 iOS 17 可用符号（兼作 swiftinterface 消费探针）；CI build job 升 macos-15（对齐 Xcode 26 / Swift 6.2.4）、xcodegen 前 download gate 的 artifact、Release 后硬断言二进制 ≥20MB 且 `nm` 含 `_tailscale_dial`/`_tailscale_new`。待 CI 出真包后下载交用户 Sideloadly 重签。
