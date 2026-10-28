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

- [x] **2.1** `[真机]` **免费 Apple ID 自签链接 Go c-archive**：TailscaleKit 以 Embed & Sign 嵌入最小 App，Personal Team 自动签名，真机启动无 entitlement/签名/`0x72613c21` 类错误。
      — 2026-10-25 ✅ **真机结论 GO**（run 40168019618，commit `643f6b4`，CI gate+build 全绿）：ipa 8.6MB（旧包 0.53MB），解包实证 `Payload/DSHRemote.app/Frameworks/TailscaleKit.framework/TailscaleKit` = 22,355,856 字节、主二进制 1,025,944 字节且 `otool -L` 含 `@rpath/TailscaleKit.framework/TailscaleKit`、dylib 导出 `_tailscale_dial/new/up/listen/close`。用户侧 Sideloadly + 免费 Apple ID 重签装机，**iPadOS 27.0.1**（≥ dylib minos 18.1，无版本矛盾）：安装成功、启动正常出界面、前台/后台切换不崩、Sideloadly 日志零报错（未出现 entitlement/`0x72613c21`）——证明免费账号侧载含 22MB Go **动态**框架的包可行，且 Sideloadly 对 app + Frameworks 一并重签。本 spike 仅链接未入网，2.2 起接入网逻辑。
      — 2026-10-25 启动注记：**执行形态确认为「CI 出真包 → Sideloadly 免费 Apple ID 重签 → 真机启动」**（无 Mac，不能走 Xcode 直装）。先解包 run 40164547825 的 ipa 取证：app 二进制仅 ~990KB、包内无任何 framework——彼时工程未链接 TailscaleKit，该包无法回答 2.1。故提前实施 3.1 的链接工作（仅链接、不入网）：①`project.yml` 给 DSHRemote 加 `Vendor/TailscaleKit.xcframework` 依赖（`embed: false` 静态链接）+ 按 sdk 切片的 `-force_load`（Go c-archive 单 fat binary，普通链接会按目标文件裁掉 cgo/Go 运行时）；②新增 `Sources/TailscaleSpike.swift` 编译期探针，只引用 iOS 17 可用符号（`kDefaultControlURL`、`NetProtocol.tcp`），**不构造 TailscaleNode、不碰 key**；③build job 改 macos-15（swiftinterface 由 Xcode 26/Swift 6.2.4 产出，macos-14 的 16.x 消费不了）、xcodegen 前 download-artifact 取 gate 的 xcframework、Release 后加硬自检（主二进制 ≥20MB 且 `nm -gU` 必须含 `_tailscale_dial`/`_tailscale_new`，否则判红——避免又出一个看似成功但没链 Go 的假包）。
      — 2026-10-25 **链接形态修正（run 40167137252 实证）**：Ld 命令确含 `-force_load .../TailscaleKit -dead_strip`，但主二进制仍仅 1,025,944 字节——对本地 device 切片读 magic bytes：`CF FA ED FE`（Mach-O 64 thin arm64）、offset 12 filetype=`06`=**MH_DYLIB**，即 TailscaleKit 是**动态 framework**（21MB Go 在 dylib 内，与本条原文「Embed & Sign」一致，先前 `embed:false`+`-force_load` 是错误假设，dylib 无法 force_load 进主二进制）。第三次修复：`project.yml` 改 `embed: true`、删除两行按 sdk 切片的 `OTHER_LDFLAGS`；自检口径改为断言 `.app/Frameworks/TailscaleKit.framework/TailscaleKit` 存在且 ≥20MB、`otool -L` 主二进制含 TailscaleKit 的 LC_LOAD_DYLIB、dylib 自身 `nm -gU` 含 `_tailscale_dial`/`_tailscale_new`。未签名 CI 包 embed 只拷贝不签名，Sideloadly 重签须覆盖 app 与 Frameworks 内全部二进制（真机验证点）。真机重签/启动结论仍待用户侧 Sideloadly 窗口，本条保持未勾选。
- [x] **2.2** `[真机]` **auth key 非交互入网**：粘贴 key → `TailscaleNode` up → 控制台出现该节点、App 内显示 tailnet IP；杀进程重启登录态保留（状态目录 Documents/tailscale）；Tailscale 控制台可吊销验证失败上屏。
      — 2026-10-25 ✅ **真机结论 GO**（run 40171960310，commit `268cd05`，CI gate+build 全绿、233 模拟器测试不回归；ipa 8,658,876 字节、dylib 22,355,856 字节在 Frameworks/、主二进制 1,314,936）。用户 iPadOS 27.0.1：TS 面板粘贴本机生成的 `tag:ipad / reusable / 非 ephemeral` auth key（key 全程不入对话/仓，内存即用即焚）→ up 成功，tailnet IPv4 **100.83.159.13**，Tailscale 控制台 Machines 出现节点 **dsh-ipad**，Go 日志区无错误；杀进程重开后「Documents/tailscale 已存在」，空 key 点入网恢复成功、IP 不变——状态目录保活得证，以后重启不再需要 key。key 为 reusable：保留可应对删 App 重装（沙盒随之删除），不用时控制台可随时 Revoke。
- [x] **2.3** `[真机]` **进程内 dial tailnet 明文口**：用 `tailscale_dial("tcp","100.99.84.35:8080")`（或先 tailscaleSession 作对照）GET `/auth/login` 拿到 200，证明节点能到 dsh-cloud 网关明文口；记录在 WiFi/蜂窝分别表现。
      — 2026-10-26 ✅ **真机结论 GO（WiFi 档；蜂窝档 N/A）**（run 40262315390，commit `5569e4f`，gate+build 全绿、233 测试不回归；ipa 8,684,118，主二进制 1,414,928，dylib 22,355,856）。关键 API 事实：swiftinterface 里 Swift 层 `OutgoingConnection` 只有 `connect/send/close`，**`receive` 仅存在于 iOS18+ 独占的 `IncomingConnection`**；iOS17 目标下收发双向必须走 C API——`node.tailscale`（`TailscaleHandle`）→ `tailscale_dial` 返回的 conn 是可 `read/write/poll/close` 的 fd（header 明言 "a pipe(2)"）。探针在 `Task.detached` 里阻塞执行：dial → 手写 `GET /auth/login HTTP/1.1`（Host/Connection: close）→ poll 20s 总预算收响应 → 解析状态行/耗时/字节/头预览。用户 iPadOS 27.0.1 WiFi 实测：**HTTP/1.1 200 OK，1370ms**（含首次路径发现）。蜂窝档因设备无蜂窝模块 **N/A**，2.5 的线路差异改由「不同 WiFi 出口（手机热点）+ 封 UDP 41641 逼 DERP」覆盖。此 C-fd 形态即 2.4 本地桥每连接的转发基础。
- [x] **2.4** `[真机]` **WKWebView 走本地桥（最高风险）**：起 `NWListener@127.0.0.1` → 每连接 `tailscale_dial` 桥到 `100.99.84.35:8080` → WKWebView 加载 `http://127.0.0.1:<port>/auth/login`，确认页面与 Cookie 可用；再用一个 WS 端点（或临时回声）验证 `Connection: Upgrade` 可逐字节双向。**这一步证伪/证实「WKWebView 不经 URLSession 代理、必须自建桥」的判断。**
      — 2026-10-26 ✅ **真机结论 GO（四项取证全过，最高风险排除）**（run 40283647521，commit `e9c0119`，gate+build 全绿、233 模拟器测试不回归；ipa 8,781,747，dylib 22,355,856，主二进制 1,806,640）。用户 iPadOS 27.0.1 WiFi 实测：①**页面**——WKWebView 经 `http://127.0.0.1:<port>/auth/login` 真实渲染网关登录页（导航轨迹「完成」；途中一行 `NSURLErrorDomain -999` 是登录页重定向链的良性取消）；②**未登录 WS**——页面 JS 上下文 `new WebSocket(ws://127.0.0.1:<port>/api/remote.mux)` 回 `CLOSE code=1006`（网关 401 拒升级，但 Upgrade 请求字节已逐字节透传到 tailnet 网关）；③**Cookie**——WebView 内完成登录后读 WKWebsiteDataStore，`dsh_session` 存在（localhost origin 下 Cookie 可写可读）；④**登录后 WS**——`OPEN 101`，双向通道建立。**「WKWebView 不经 URLSession 代理、必须自建桥」判断证实；WS Upgrade 经 C-fd 桥逐字节双向透传证实。**
      — 2026-10-26 实现注记（spike 三件：`TailscaleSpikeProxy.swift`（`tailscale_dial` pipe fd → `TailscaleFDChannel: DuplexChannel`，专用队列 poll(1s)/read 循环喂 AsyncStream、阻塞全量写；`TailscaleDialConnecter: UpstreamConnecter`）+ manager 挂 `LoopbackProxy(HttpBridge(routes: ShellAssetRoutes(Bundle.main), connecter:))`（4.1–4.5 设备无关层零改动直接复用，Host 重写/hop-by-hop 剥离/WS `Connection: Upgrade` 重发均已在 HTTPHeadCodec）+ `TailscaleSpikeWebView.swift` 取证件：页面渲染导航轨迹、WKWebsiteDataStore 读 cookie、页面 JS 上下文 WS 探测）。ATS 无需改：现有 `NSAllowsArbitraryLoadsInWebContent` 已覆盖 WKWebView 的 loopback http，真机加载/WS 全程无 ATS 拦截（4.6 产品化时核对 `NSAllowsLocalNetworking`）。
      — 2026-10-26 **踩坑固化（回填 §5.6 候选）**：①`evaluateJavaScript(_:completionHandler:)` 对「脚本返回 Promise、且 Promise 在后续 runloop 的 WebSocket 事件回调里才 resolve」解包不可靠，必回 `WKErrorDomain Code=5 "JavaScript execution returned a result of an unsupported type"`（与页面是否 about:blank/origin=null 无关）；正解是 iOS 14+ 的 `callAsyncJavaScript`（函数体包成 async function 原生 await；completionHandler 是 `Result<Any,Error>` **单参**；两个标签都写 `in:`；Xcode 26 SDK 该重载 `arguments` 为非可选，无参传 `[:]` 不能传 nil）。②JS Promise executor 体内须整体 try/catch 且 `resolve(String(m))` 强制字符串；WebKit 里 WS onerror 必被随后 onclose 跟随，以 onclose code 为准（1006=未登录 401，101=登录态）。③`URL.appendingPathComponent("auth/login")` 会追加尾斜杠成 `/auth/login/` 触发网关重定向，用 `URL(string:"auth/login",relativeTo:base)!.absoluteURL`。
- [x] **2.5** `[真机]` **弱网三档**：①正常 WiFi 期望 P2P 直连（节点 status/延迟佐证）；②防火墙/路由器封 UDP 41641（或等价手段）期望自动回落 **DERP(sha/region 900)**；③关节点或登出期望明确失败态（为线路③留口）。记录切换耗时。
      — 2026-10-26 **真机取证（①② 完成 GO；③ 用户裁决免测）**（run 40293383483，commit `7e0ba13`；观测接口 `tailscale_status_json` 走 tsnet 内存 LocalAPI）。①**正常 WiFi 稳定 P2P**：网关 peer（100.99.84.35）CurAddr 非空（cur=106.15.153.132:41641），连续 30s 快照 6/6 绿色 P2P，backend=Running、Tx 字节随握手后持续增长。②**封 UDP 41641 自动回落 DERP ≤2s、解封恢复 P2P ≤2s**（17:44:22 P2P → 17:44:24 DERP → 17:44:34 DERP → 17:44:36 P2P）；但 **relay=`tok`（官方东京 region 5），不是预期的自建上海 region 900**——兜底流量出境日本，闸门 B 必须裁决：接受东京 DERP（延迟/稳定性风险）还是补自建上海 DERP。**重大判定修正：tsnet/iOS 上 `Self.Online` 不可靠**——线路切换瞬间 self=off，但网关 peer 始终 Online、Relay 有值、握手年龄与 Tx 字节照涨；故线路判定一律以**网关 peer 的 CurAddr（非空=P2P）/Relay（空 CurAddr+非空 Relay=DERP）/Online=false=offline/peer 缺失=missing/有 relay 无握手=idle** 为准（parseStatus 即此口径，回填固化）。③**免测（用户 2026-10-26 裁决）**：实际使用中网关节点为常驻服务，不会故意下线/退网，offline/missing 不代表真实场景；parseStatus 五档判定分支已在代码中保留，不再专门真机制造。
- [x] **2.6** `[真机]` **后台挂起（issue #20060）**：进后台 ≥30s 回前台，测 loopback/数据面是否失效、需要何种重建（重 bind/重新 dial/节点重 up）与耗时；固化为 Task 6 的重建策略。
      — 2026-10-26 ✅ **真机结论 GO**（最终包 run 40335355762，commit `2775eee`；用户 iPadOS 27.0.1）。**生命周期坑（核心）**：初版 manager 由 TS 调试 sheet 的 `@StateObject` 拥有，点「完成」关窗即释放，tsnet node 与 127.0.0.1 桥连带销毁（表现为"关窗口即断联"，曾被误判为锁屏 jetsam）；修复为 `TailscaleSpikeManager.shared` 全局单例（`private init`）、View 改 `@ObservedObject`——**产品铁律：节点生命周期必须独立于任何页面**。单例后真机实证：关窗状态下**锁屏 40s+/123s 进程均未被杀、节点与登录态保持**（in-app tsnet 无 NetworkExtension 后台常驻，此结论仅限该设备短时锁屏；更久后台/内存压力仍可能被 jetsam，冷启动诊断横幅+`recoverAfterColdStart()` 保留）。触发链路：scenePhase onChange 绑在已销毁的窗口上不触发，改为 manager `init` 注册 `UIApplication.didEnterBackground/didBecomeActiveNotification`（内存时间戳+UserDefaults 持久戳双打点，≥30s 且 phase==.up 自动复查）——**关着 TS 窗口锁屏 123s 解冻，自动出报告**。
      — 2026-10-26 **123s 挂起四项复查结果（重建策略据此固化）**：①C 内存 LocalAPI：**DERP**（挂起后 NAT 映射失效，P2P 落 DERP；tsnet 节点本身存活）；②自建 127.0.0.1 桥端口：**已失效，自动 stop/start 重建 355ms**（iOS 挂起期回收的是我们外挂的 NWListener）；③重建后 tailscale_dial GET 网关：**HTTP/1.1 200 OK，667ms，4275b**（端到端同步通道恢复）；④Swift `node.statusJSON()`（tsnet 自带内存 loopback）：**OK 1ms**（对照组——tsnet 自身 loopback 存活，被回收的仅限外挂桥）。**Task 6 重建策略：回前台不重 up 节点，只需探活 127.0.0.1 桥端口，失效则重建（实测 355ms），重建后端到端 <1s 恢复；北极星 outbox 补传等"桥活"信号即可 drain。** 挂起后线路为 DERP，回前台后是否自行打回 P2P 待观察。
- [x] **2.7 闸门 B 验收（go/no-go）**：2.1–2.6 全部有真机结论（成功或明确的失败+替代）。**若 2.4 自建桥在真机不可行或 WS 无法透传，停点评审**（替代：研究 WKWebView 网络层其他牵引手段，或接受内核页仅 Funnel、本地反代只服务同步 API —— 但那违背北极星的通道目标，需用户裁决）。spike 代码在结论固化后删除，经验回填本 plan 与 spec §5.6。
      — 2026-10-26 ✅ **闸门 B 裁决：GO（用户拍板）**：2.1–2.6 真机结论齐全（2.4 最高风险「WKWebView 不经代理必须自建桥 + WS 逐字节透传」已证实可行；2.6 后台恢复代价量化为重建本地桥 355ms、端到端 <1s，不需重 up 节点），进入 Phase 3 工程化。**DERP 决策：先东京（relay=tok/region 5）上线，自建上海 region 900 后补**（P2P 为常态、DERP 仅兜底且 ≤2s 自动切换；Phase 3/4 不阻塞，上海 DERP 列后续运维任务，上线后量到东京延迟/稳定性不可接受再补）。spike 四件（TailscaleSpikeManager/View/WebView/Proxy + RootView 入口）**保留至 Phase 3.3 产品设置页/节点状态机落地后删除**（过渡期作实现参照与回归取证工具），删除时同步确认 4.1–4.5 桥层已无 spike 专属耦合。

### Phase 3 — 入网认证与节点生命周期（工程化，非 spike）

- [x] **3.1** `project.yml` 正式链接 `Vendor/TailscaleKit.xcframework`（Embed & Sign），部署目标统一 17.0；先保证现有 App 仍能构建（功能不变）。
      <!-- 2026-10-26 完成（commit f181435 + 修复 30de721，run 40348072732 全绿）。链接在 2.1 已提前落地（embed:true），3.1 转正的实际工作量是把上游 xcframework 的 minos 从写死的 18.1 压到本工程 17.0：首版 export IPHONEOS_DEPLOYMENT_TARGET 被 run 40345456800 证伪（xcodebuild 优先级「命令行 > pbxproj > 环境变量」），改构建前 BSD sed patch pbxproj 6 处 18.1→17.0（grep BEFORE/AFTER=6/6 守卫）；gate vtool 三切片（IOS+IOSSIMULATOR×2）均 minos 17.0、MINOS17_CHECK=PASS；build 233 测试 0 失败、Release 链接目标 arm64-apple-ios17.0 零部署目标 warning、LINK_CHECK=PASS、dylib 22,356,392B、ipa 8,862,807B。 -->
- [x] **3.2** 新增 `TailnetAuthStore`（Keychain）与 `TailnetNode`（状态机：idle/unauthenticated/starting/online(IP)/failed(reason)；配置 controlURL 默认官方、dir=Documents/tailscale、hostName 固定如 `dsh-ipad`、非 ephemeral）；阻塞 `up()` 放 detached/GCD。
      <!-- 2026-10-27 完成（bbaaec3 + 修复 6a15b8b；run 40443921886 首轮暴露 3 处编译错误，40448271361 全绿）。`Sources/TailnetAuthStore.swift`：AuthKeyStoring 协议 + Keychain generic password 单条 item（service 固定无个人字面量，SecItemUpdate→errSecItemNotFound 才 Add，kSecAttrAccessibleAfterFirstUnlock，不进 iCloud/备份），只写不读显。`Sources/TailnetNode.swift`：@MainActor App 级 static let shared 单例（DSHRemoteApp.init 触碰并 autoStart，生命周期独立于页面）；TailnetBackending 协议 + actor TailnetBackend 生产实现（createDirectory→Configuration(hostName:"dsh-ipad", path:, authKey:, controlURL:kDefaultControlURL, ephemeral:false)→up() 与 addrs() 10×0.5s 轮询全部 Task.detached(userInitiated)；LogSink 回调派主队列，logFileHandle 见证，日志只进 os_log 且绝不含 key）；冷启动按 Documents/tailscale 目录态恢复（nil key），仅 Keychain 有 key 的边缘情况带 key 重入网；signIn/retry/signOut（保留下线状态目录）/wipeState（再删目录）；backendFactory 闭包注入为 3.4 假后端铺路。两处 CI 教训：①private static hasPersistedState 在实例方法内须 Self. 限定；②带关联值 enum 成员不能 `== .online` 比较（解析为柯里化函数），统一 if case。 -->
- [x] **3.3** 新增设置页「Tailscale 认证」：粘贴 key（安全输入框、不回显、不进日志）→ 存 Keychain → 启动节点 → 展示状态与 tailnet IP；支持登出/清除（吊销本地状态）。从现有标题/设置入口进入（沿用 App.swift 连点进 S1 附近的入口风格，不破坏现有网关设置）。
      <!-- 2026-10-27 完成（7f538eb + 修复 237b644；run 40445046827 首轮 1 处编译错误，run 40448271361 全绿）。产品页落 `Sources/Settings/TailnetSettingsView.swift`（plan 文件表命名一致）：NavigationStack+List，状态区（状态文案/配色、online 显 ip4+ip6、failed 显可选择复制的 reason）、SecureField 粘贴 tskey-auth（autocapitalization 关、提交后 @State 立即清空「用后即焚」、不回显已存 key）、提交并入网/重试/登出（删 Keychain 保目录）/彻底清除（confirmationDialog 二次确认，再删 Documents/tailscale）；只 @ObservedObject TailnetNode.shared，不持有节点。入口：RootView 标题栏右侧「TS」胶囊原位换 sheet（连点 5 次进 S1 的网关设置一行未动）。spike 四件 TailscaleSpikeManager/View/WebView/Proxy 全删（-1433 行净删），Sources 与 Tests grep 无残留引用；产品桥（tailscale_dial 数据面）按 plan 留 Phase 4 重建。CI：gate 三切片+MINOS17 PASS、233 模拟器测试 0 失败、LINK_CHECK=PASS、未签名 ipa 8.3M（artifact 12708889708）。 -->
- [x] **3.4** 单测：auth store（Keychain 替身）、状态机迁移、失败原因；不依赖真网络的部分进 CI 模拟器测试。
      <!-- 2026-10-27 完成（3a8d676 + 4 轮 CI 修复 7894767/4758a77/37d2471/2be7525；run 40478058197 全绿）。233→**255 测试 0 失败**、LINK_CHECK=PASS、未签名 ipa 8.3M。两个新文件 +22 用例：①`Tests/DSHRemoteTests/TailnetNodeTests.swift`（15 例，@MainActor + async setUp/tearDown、临时状态目录 UUID 隔离）——autoStart 4 例（无凭据→unauthenticated 不触后端；有 tailscaled.state→authKey=nil 恢复且 stateDir/hostName=dsh-ipad 入参断言；仅 Keychain 有 key→带 key 入网；online 后二次 autoStart 幂等不新建后端）；signIn 5 例（空白 key 直接 failed 不存 key 不触后端；trim 后存 Keychain、双栈 IP、入参与 https controlURL；仅 IPv6 时 ip4 显「—」；401 失败 reason 透传且绝不含入参 key、key 保留供 retry；up 成功但双空地址→failed「未取得 tailnet 地址」）；retry 2 例（队列两后端 failure→online，二次 bringUp 用 Keychain key；有历史态时 retry authKey=nil）；signOut/wipe 2 例（shutdown 一次+删 key+回未认证；状态目录真实被删）；starting 守卫 2 例（hang 假后端 CheckedContinuation 挂起，starting 中第二次 signIn/retry 被忽略：key 不被覆盖、不新建第二次调用；收尾 releaseHang→online→signOut 释放孤立 Task）。②`TailnetAuthStoreTests.swift`（7 例）——trim、空串拒绝、往返、二次保存覆盖非重复、删除幂等、不同 service 不串读。产品可测试性改造（生产行为零变化，全默认参数）：TailnetNode.init 增 stateDirectory 注入（hasPersistedState 由 static 改实例 var）；TailnetAuthStore 抽 KeychainBackending（四个 SecItem C API 封装），生产默认 SecItemBackend 直透。四轮 CI 教训固化：①Swift 5「属性类型是 private 则属性必须 fileprivate/private」犯两次（测试类替身属性一律 private）；②XCTAssert 的 autoclosure 不支持并发，`XCTAssertEqual(await actor.x(), …)` 双报错，先取本地常量再断言；③**模拟器逻辑测试宿主无 keychain-access-groups entitlement，真 SecItemAdd 必返 -34018 errSecMissingEntitlement**——Keychain 往返不能进 CI，改注入后端测逻辑，真 Keychain 往返留 3.5 真机验收；④@MainActor 类的 static let 作 init 默认参数触发 nonisolated 引用预警，stateDir 标 nonisolated（initializer 只碰 FileManager）。 -->
- [x] **3.5 验收**：模拟器/真机构建通过；真机入网一次、杀进程保活、Keychain 之外 grep 不到明文 key（日志/沙盒 plist/UserDefaults 抽查）。
      <!-- 2026-10-28 ✅ 真机结论 GO（用户复验通过）。最终包 run 40510830461，commit ef0b031（含修复链 c26e955/f6fb82d/4cbb6ac/3d0e2d4/07a4afd）；CI gate+build 双 success：节点 17 测试、全量 257 测试 0 失败，LINK_CHECK=PASS，未签名 ipa 8,692,931B。用户 iPadOS 27.0.1 + Sideloadly 免费 Apple ID 重签：清旧态装机后入网一次成功、状态机到 online 显 tailnet IP、杀进程保活登录态不丢、沙盒/日志/UserDefaults 抽查无明文 tskey-auth（Keychain 之外零落地），弱网 45s 入网看门狗超时上屏、starting 中「取消入网」可打断、节点日志（最近 50 条）设置页可见均经真机确认。
           真机阻断缺陷「节点一直显示启动中、按钮无响应」修复三件套（c26e955）：①入网看门狗——生产 45s/测试注入 0.3s，到点 backend.shutdown() 即 node.down() 打断无限阻塞的 up()，catch 按「入网超时」上屏（弱网不再永久卡死）；②starting 中可「取消入网」——generation 代际令牌（bringUp/cancelBringUp/signOut 时 generation &+= 1，回调比对捕获 gen，迟到旧结果丢弃；timedOutGenerations 先查后删）；③节点日志内存环形缓冲上屏（50 条、不落盘、绝不记 key）。f6fb82d 修 TimeStyle.medium→.shortened（CI 编译）。
           日志实例化重构（4cbb6ac 起，4 轮 CI）：初版断言失败根因是日志环形缓冲写死 nonisolated static log/appendLog→TailnetNode.shared，注入测试实例收不到日志；删 static 三件套改为 @MainActor 实例 log(_:)（os_log + 写 self.recentLogs），TailnetBackend 增 onLog: @Sendable (String)->Void 回调承接 Go 侧 TailnetLogSink 日志由节点实例注入。连续踩 Swift 两阶段初始化三坑：init 内把捕获 self 的逃逸闭包赋给存储属性报 used-before-initialized、先占位再赋 let 报只能初始化一次、if/else 两分支各赋一次仍报 used-before-init（DI checker 对「被赋值属性所在闭包捕获 self」的鸡生蛋限制）；最终落点 ef0b031：init 只存 injectedBackendFactory: (()->TailnetBackending)?（外部工厂不捕获 self），新增运行期实例方法 makeBackendInstance() 在 self 完整后建生产 TailnetBackend 并以 [weak self] 绑实例日志（防 backend→闭包→node 环），bringUp 改调它。教训：Swift init 里不要建捕获 self 的默认逃逸闭包工厂，延迟到实例方法。 -->

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
  - **Phase 2.1 出包改造**：解包 run 40164547825 的 artifact 取证（ipa 0.53MB、主二进制 989.5KB、无 framework），确认当时的包没链 TailscaleKit、不能用于侧载验证。最小改造（提前做 3.1 的链接、不做入网）：初版按静态假设写 `project.yml` xcframework 依赖 + sdk 分切片 `-force_load`；新增 `Sources/TailscaleSpike.swift` 仅引用 `kDefaultControlURL`/`NetProtocol.tcp`（兼作 swiftinterface 消费探针）；CI build job 升 macos-15（对齐 Xcode 26 / Swift 6.2.4）、xcodegen 前 download gate 的 artifact、Release 后硬自检。
  - **2.1 CI 三轮收敛**：①run 40166859237 build 挂在切片验收——download-artifact 上传目录时 artifact 根即目录内容（无外层 xcframework 包装），`path: Vendor/` 平铺错位（`b5595ec` 改显式落 `Vendor/TailscaleKit.xcframework` 修复）；②run 40167137252 Ld 命令确含 `-force_load .../TailscaleKit`，但主二进制仍仅 1,025,944 字节——读本地 device 切片 magic bytes（`CF FA ED FE` Mach-O 64 thin arm64，offset12 filetype=`06`=**MH_DYLIB**）证实 TailscaleKit 是**动态 framework**，dylib 无法 force_load 进主二进制（`643f6b4` 改 `embed:true`、删 OTHER_LDFLAGS、自检改查 `.app/Frameworks/`+`otool -L`+dylib `nm`）；③**run 40168019618 全绿**：自检 PASS（embed 的 TailscaleKit 22,355,856 字节、主二进制 LC_LOAD_DYLIB 指向 @rpath、`_tailscale_dial/new/up/listen/close` 齐全），ipa 8.6MB（233 模拟器测试不受影响）。
  - **2.1 真机闸门 GO**：用户 Sideloadly + 免费 Apple ID 重签 8.6MB ipa，iPadOS 27.0.1 安装成功、启动正常、前后台切换不崩、日志零 entitlement/签名错误（无 `0x72613c21`），证实免费侧载含 Go **动态**框架的包可行、Sideloadly 覆盖 app+Frameworks 一并重签。2.1 勾选。下一未知是 2.2 非交互入网（key 在用户本机注入一次）。
  - **Phase 2.2 出包（CI 三轮收敛）**：新增 `TailscaleSpikeManager`（@MainActor ObservableObject：`Documents/tailscale` 状态目录、auth key 内存即用即焚、`TailscaleNode.up()` 后最多 10×0.5s 轮询 `addrs()`、down 保留状态目录）+ `TailscaleSpikeView`（标题栏「TS」面板：SecureField 粘 key、阶段/IPv4/IPv6/登录态、Go 日志最近 300 行），删旧 2.1 链接探针 `TailscaleSpike.swift`（commit eab8488）。CI 连续三轮：①run 40170520876 语法错——stateDir 立即执行闭包误写 `})()`（f8ed7a5 修）；②run 40171234256 `SpikeLogSink does not conform to LogSink`——swiftinterface 里 `#if $NonescapableTypes` 包着的 `var logFileHandle: Int32?` 在 Xcode 26 工具链下是**必需**协议见证（f5ca53d 补 `= nil`，日志只走回调不用文件句柄）；③run 40171562140 `call to main actor-isolated appendLog in synchronous nonisolated context`——LogSink 回调自 Go 线程，`@Sendable` 闭包同步触达 MainActor 方法（268cd05 把 appendLog 改 nonisolated、内部自行派主队列）。④**run 40171960310 全绿**：gate+build 双成功、233 模拟器测试不受影响；ipa 8,658,876 字节，解包确认 `Frameworks/TailscaleKit` 仍 22,355,856 字节、主二进制 1,314,936（2.2 代码已编入）。
  - **2.2 真机闸门 GO**：用户在 iPad 本机控制台生成同款 key（免去 Windows→iPad 传输），TS 面板粘贴 up 一次成功：阶段绿、IPv4=100.83.159.13、控制台出现 dsh-ipad、日志零错误；随后杀进程重开，Documents/tailscale 状态目录在、空 key 恢复登录态拿到同一 IP。进程内 tsnet 非交互入网 + 凭据沙盒保活两个关键未知同时落地。2.2 勾选。下一未知 2.3：进程内 dial `100.99.84.35:8080` GET `/auth/login` 200（WiFi/蜂窝各记一次）。
  - **Phase 2.3 一次过**：swiftinterface 取证确认 `OutgoingConnection` 无 receive（iOS13+ 只能发），`IncomingConnection.receive` 要 iOS18+——故 iOS17 目标的数据面收发走 C fd：Manager 新增 `runDialProbe`（取 `await node.tailscale` 句柄 → `Task.detached` 内阻塞式 `tailscale_dial`/`write`/`poll`(20s 预算)/`read` → 裸 HTTP 解析状态行/耗时/字节/头预览；非 200 也按「数据面通」记录并标注），View 加 2.3 Section。commit `5569e4f`，**run 40262315390 首次即全绿**（无并发/互操作返工），ipa 8,684,118、主二进制 1,414,928。真机 WiFi：**HTTP/1.1 200 OK / 1370ms**。iPad 无蜂窝模块，蜂窝档 N/A，线路差异留 2.5（热点出口 + 封 UDP 逼 DERP）。2.3 勾选。下一未知 **2.4（最高风险）**：NWListener@127.0.0.1 每连接桥到 tailscale_dial fd，WKWebView 加载 http://127.0.0.1 验证页面/Cookie，再验 WS Upgrade 双向。
  - **账单变更（2026-10-26）**：私有仓 macOS runner 按 10x 计分钟，免费额度 2000/2000 用尽（run 40265850012 gate 不调度，annotation 报支付/限额）。用户拍板**仓库转 public**（公开仓 macOS Actions 分钟免费）：转前扫密（工作树 grep + 全 88 提交 `git log --all -G` + git ls-files）仅见占位文案与测试假 token（`Bearer x`），确认无密钥后 `gh repo edit --visibility public`，rerun 即正常调度。
  - **Phase 2.4 实现（commit `503eeee`）+ 三轮 CI 收敛**：①`var iter` 编译错（AsyncStream.Iterator.next() 是 mutating，run 40265850012，`057ab12`）；②自查发现 `appendingPathComponent("auth/login")` 追加尾斜杠触发网关重定向，改 relative URL 拼接（`3834b9d`，cancel 旧 run），**run 40267288096 全绿**出包，真机登录页渲染成功（页面取证先过）；③用户报未登录点 WS 探测显示 `WKErrorDomain Code=5`，初版按「页面未加载 origin=null」加前置 guard+JS 加固（`89140cd`，CI 绿但根因未解），截图证伪后定位真因：`evaluateJavaScript` 无法回传跨 runloop（WS 事件回调）才 resolve 的 Promise——改用 `callAsyncJavaScript`（iOS14+，原生 await；`aed08a6`），run 40282613116 编译失败：Xcode 26 SDK 该重载 `arguments` 非可选，`nil` 报错，改 `[:]`（`e9c0119`）。
  - **2.4 真机闸门 GO（最高风险排除）**：**run 40283647521 全绿**（build 4m17s，233 测试不回归；ipa 8,781,747 / dylib 22,355,856 / 主二进制 1,806,640，embed 自检 PASS）。用户真机四项取证全过：页面（/auth/login 真实渲染）→ 未登录 WS `CLOSE 1006`（401 拒升级，Upgrade 字节已透传）→ WebView 内登录 → Cookie `dsh_session 有 ✅` → 登录后 WS `OPEN 101`（双向通道建立）。**核心命题证实：WKWebView 不经 URLSession 代理、走自建 127.0.0.1→tailscale_dial 桥可行；Cookie 与 WS Upgrade 逐字节双向透传。**2.4 勾选；踩坑（callAsyncJavaScript、URL 尾斜杠等）固化于勾选注记，备 §5.6 回填。下一未知 **2.5 弱网三档**（异出口 WiFi/P2P、封 UDP 41641 逼 DERP(sha)、节点失败态；需用户配合网络环境）与 **2.6 后台挂起重建**；2.7 闸门 B 待 2.5/2.6 有真机结论后评审，届时删全部 spike。
  - **Phase 3.1 完成（2026-10-26，闸门 B GO 后首个工程化 Phase）**：正式链接在 2.1 已提前落地（`project.yml` xcframework 依赖 `embed:true`），本 Phase 实际收口两件事——①workflow 转正表述（gate 不再叫「spike/提前」，build 自检 marker 改 `LINK_CHECK=PASS`，删冗余的独立 iOS17 覆盖探测步，gate 新增 MINOS17 硬断言）；②把上游 xcframework 的 minos 从写死的 iOS 18.1 压到本工程 17.0，消除 `minos 18.1 > target 17.0` 链接 warning。
    - 首版 commit `f181435` 用 `export IPHONEOS_DEPLOYMENT_TARGET=17.0` 透传，**run 40345456800 gate 红证伪**：脚本与 gate 的 vtool 取证三切片全部仍 minos 18.1。根因：xcodebuild build setting 优先级「命令行参数 > pbxproj 工程显式值 > 环境变量」，上游 pbxproj 6 处显式 18.1 压制环境变量；上游 Makefile 钉死在 libtailscale 仓内、命令行不可注入。另经 gh api 核查 Go c-archive 侧由 `clangwrap-ios*.sh -mios-version-min=12.0` 编译（minos 12.0），压 Swift 侧到 17.0 无版本冲突。
    - 修复 commit `30de721`：checkout 后、`make ios-fat` 前用 BSD `sed -i ''` 把 pbxproj 6 处 `IPHONEOS_DEPLOYMENT_TARGET = 18.1;` 批量改 17.0，grep BEFORE/AFTER 计数守卫（BEFORE=0 或 AFTER<BEFORE 即 exit 1，上游改写法时 CI 直接红而非静默回退）；脚本头/VERSION/workflow 注释同步改为 sed 口径并留痕失败方案。
    - **run 40348072732 全绿**（gate 4m3s）：日志「替换前 18.1 行数=6，替换后 17.0 行数=6」；vtool IOS + IOSSIMULATOR×2 三切片均 `minos 17.0`，`SLICE_CHECK=PASS`/`MINOS17_CHECK=PASS`；build 233 模拟器测试 0 失败（20.860s）、Release iphoneos 链接行 `arm64-apple-ios17.0` 且全日志零 deployment target warning、`LINK_CHECK=PASS`（embed dylib 22,356,392B、`_tailscale_dial/new` 导出齐全）、ipa 8,862,807B（留档 `E:\项目\dsh-spike\run40348072732\`）。3.1 勾选。下一 Phase **3.2**：`TailnetAuthStore`（Keychain）+ App 级 `TailnetNode` 单例状态机（产品铁律：节点生命周期独立于任何页面，不再挂 spike sheet 的 @StateObject）。
