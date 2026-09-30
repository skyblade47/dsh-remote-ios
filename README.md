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
| 签名 | Apple ID（Sideloadly / Xcode） | ✅ 能（但要拿到已编译的包） |
| 安装 | USB + Apple Mobile Device 服务 + Sideloadly | ✅ 能 |

⇒ 所以本仓的定位是：**把"除了编译器之外的一切"准备好**，编译走下面两条路之一。

### 编译链（二选一）

| 路 | 做法 | 代价 | 状态 |
|---|---|---|---|
| **① GitHub Actions（推荐）** | 推代码 → `.github/workflows/ios-build.yml` 在 **macOS runner** 上 `xcodegen` + `xcodebuild`，产出**未签名** `.ipa` → 下载回 Windows | 免费额度按 **10×** 计（private 仓免费额度 2000 min/月 ⇒ 约 200 分钟 macOS 时长）；产物未签名 ⇒ 需本机 Sideloadly 用你的 Apple ID 重签 | ✅ **已实测通过**（2026-09-30，run 36663990921：`DSHRemote-unsigned.ipa` 29,957 B，工件已上传） |
| ② iPad 上的 Swift Playgrounds | 在 iPad 上建 `.swiftpm` 工程直接运行 | 无需 Mac；工程结构受限、调试弱 | ❓ 未实测 |

> ⚠️ **① 的路上有两个已踩过的坑**（都已修在仓库里，别再踩）：
> 1. **Xcode 版本配对**：`macos-14` 默认 Xcode 是 **15.4**，而 XcodeGen 2.46.0 产出的工程是
>    `objectVersion 77`（Xcode 16 格式）⇒ 报 `future Xcode project file format (77)`。
>    **修法**：workflow 里 `xcode-select` 到镜像中版本最高的 `Xcode_*.app`（该镜像有 15.0–15.4 与 **16.1/16.2**）。
> 2. **XcodeGen 钉不住格式**：`options.objectVersion` 数字/字符串两种写法**生成出来都是 77** ⇒ 该键是死配置，
>    已在 `project.yml` 注明并移除。
> 📌 另：CI **不给任何 Apple ID 凭据**（签名凭据不离开你的电脑）。


---

## 1. 本机环境现状（2026-09-30）

| 项 | 状态 |
|---|---|
| `Apple Mobile Device Service`（usbmuxd，USB 通信地基） | ✅ 已装（`Apple.AppleMobileDeviceSupport` 19.4.0.10）· 服务 Running / Automatic |
| `go-ios` v1.3.2（`ios.exe`，设备信息 / syslog / 截图 / 装包） | ✅ 已就绪：`E:\项目\_ios-tools\go-ios\ios.exe`；`ios list` 已通（`{"deviceList":[]}` ⇒ 未插设备） |
| Sideloadly（Apple ID 重签 + 侧载） | ❌ 未装（要用时再装） |
| **macOS / Xcode** | ❌ 没有（见 §0） |
| iPad | ⏳ 未连接（插上即可用 `tools/ios-observ.ps1`） |

---

## 2. 一键观测/装包（插上 iPad 后）

```powershell
powershell -File tools/ios-observ.ps1 -Action List        # 设备列表（型号 / iPadOS 版本 / UDID）
powershell -File tools/ios-observ.ps1 -Action Syslog      # 实时系统日志（排查白屏/证书失败）
powershell -File tools/ios-observ.ps1 -Action Shot        # 截屏到 .\shots\（把图发我即可，我看到真实渲染）
powershell -File tools/ios-observ.ps1 -Action Crash       # 拉崩溃日志
powershell -File tools/ios-observ.ps1 -Action Install -Ipa .\build\dsh.ipa
```

---

## 3. 工程骨架（现在就能生成 .xcodeproj，只是编译不了）

```
project.yml                 XcodeGen 工程描述（CI 里 xcodegen generate 生成 .xcodeproj）
Sources/App.swift           SwiftUI 入口 + 配置（网关地址从 UserDefaults 读，**不写死**）
Sources/ShellWebView.swift  WKWebView 封装：① ownsHost 注入 ② wcStorage 消息桥占位
Resources/Info.plist        ATS 放行（tailnet 是明文 http）+ iPad 机型
.github/workflows/          macOS runner 编译（未签名产物）
tools/ios-observ.ps1        观测脚本（见 §2）
```

本机验证工程描述（可选，需要 Node/brew 装 xcodegen —— Windows 上装不了，**跳过，交给 CI**）。

---

## 4. 🔴 两个必须在写代码前拍定的点

### 4.1 「回环权威门」走哪条路

内核 UI 在**非回环权威**下会把整个设置面板降级为内存态（PC 端为此做了本地反代）。两条路：

| | A 真回环（app 内起反代） | **B 注入 `ownsHost`（推荐）** |
|---|---|---|
| 做法 | app 进程内起 HTTP 反代（HTTP+WS+SSE+Host 改写），页面加载 `http://127.0.0.1:<port>/` | `WKUserScript(atDocumentStart, forMainFrameOnly: false)` 注入 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` |
| 量级 | 中～大 | **一行 + 时序** |
| iOS 难点 | **后台会被挂起**；要自己写全套转发 | 依赖上游内部接口名（`__DSH_TRANSPORT__`）不被改 |

➡️ 骨架里已按 **B** 写好注入（`ShellWebView.swift`）。

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
**这条要在 P2 之前拍。**

---

## 5. 装机流程（拿到未签名 .ipa 之后）

1. Windows 装 **Sideloadly** → 连 iPad → 拖入 `.ipa` → 填 Apple ID → 签名安装
2. iPad 上：设置 → 通用 → VPN与设备管理 → 信任该开发者证书
3. **免费 Apple ID 签名有效期 7 天** ⇒ 到期需重签重装（想做长期就 99 USD/年 + TestFlight）
4. ⚠️ iPad 上需先装 **Tailscale** 并登录同一账号（走 tailnet 线路，免客户端证书；见设计方案 §7.5）
