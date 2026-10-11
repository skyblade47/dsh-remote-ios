# iPad 离线写作与文档同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 iPad（iPadOS 27.0.1，「周晓晨的iPad」）的 DSHRemote 中，原样内置 PC 写作客户端 `shell.html` 与全部 JS/CSS，实现 PC 客户端已有的离线写作（断网可加载/编辑/自动保存/草稿兜底/重开内容还在）与写作文档多端同步（保存即推、打开比对、回网补推、冲突手选不盲盖）。

**Architecture:** 沿用已真机验证的安卓「虚拟同源 + 薄原生壳 + web 核心零改动」：App 请求网关 `/__shell__/shell.html`，`WKNavigationDelegate` 取消该主框架导航并以 `loadHTMLString(_:baseURL:)`（baseURL = 网关 shellURL）载入本地改写后的壳 HTML，使 origin / document.URL / Cookie / fetch 同源域全部等于真实网关；壳内 12 个本地 JS/CSS 引用运行时改写为 `dsh-asset://local/<name>` 由 `WKURLSchemeHandler` 应答；iframe `/app#/`、`/api/*`、`/writing-studio/*`、`/auth/*` 保持直连网关。原生桥双通道：异步 `window.webkit.messageHandlers.dshBridge.postMessage({id,method,args})`（args 为位置参数数组）配对回包，同步仅 `writeDocSync`/`writeDraftSync` 经 `dsh-bridge://sync` 同步 XHR。本地存储一比一复刻安卓 PathGuard/Workspace/AppData/OutboxStore 语义，落在 App 沙盒 `Documents/`。**保留** `outbox.json`（writeDoc 成功后内部分发器自动入队，暴露 outboxList/outboxRemove，无 outboxAdd 桥方法，对齐 spec §5.2/§6.2）；**不移植**安卓提醒/通知/deviceId/nativeOnline，**不移植** android-shell.js 的手机 UI；iPad 保留 PC 三栏与 PC 横幅四动作冲突处理。

**Tech Stack:** Swift 5.9 · SwiftUI(@main) + UIKit(WKWebView) · `JSONSerialization` · FileManager · iOS 17.0 目标 / iPad（`TARGETED_DEVICE_FAMILY=2`）· XcodeGen（`project.yml` 生成工程）· GitHub Actions `macos-14` 模拟器 `xcodebuild test` + 未签名 IPA · SideStore 真机签名。

**设计依据（权威文档）：**
- spec：`e:\项目\dsh-remote\docs\superpowers\specs\2026-09-30-ios-client-design.md`（下称 spec §x）
- 安卓语义蓝本：`e:\项目\dsh-remote\dsh-remote-android\app\src\main\java\com\skyblade47\dshremote\`（PathGuard.java / Workspace.java / AppData.java / WcStorageBridge.java / MainActivity.java）
- PC web 核心源：`e:\项目\dsh-remote\writing-client\`（shell.html / writing.js / *.js / *.css，**原样复制、一字不改**）

---

## 全局约定（每个 Task 都适用）

1. 所有新增/修改文本文件一律 **UTF-8 无 BOM**；行尾跟随仓库现状（Swift 为 LF）。
2. 复制的 web 核心资产**不得改一个字节**（含空白/注释/行尾）。复制后用哈希比对校验。
3. 每个 commit 仅为检查点；**实际执行 commit 前必须征得用户同意**，默认不 commit、不 push；推 CI 前须同意。
4. 不动 web 共享核心源仓库、不动服务端（零服务端改动）。
5. 不复制安卓个人常量：`AppData.java` 的 `DEFAULT_GATEWAY`（`http://100.99.84.35:8080`）与 `DEFAULT_PROOF_SESSION`（`session-41bcb5c2-…`）**禁止**进入 iOS；Swift 对应缺省一律为**空串 `""`**。
6. 本机（Windows）无 Xcode，Swift 单测只能在 GitHub Actions 的 iPad 模拟器跑；因此每个含 Swift 代码的 Task 的「验证通过」步骤都给出同一条模拟器测试命令（见下）。本地可做的验证只有：文件存在性、UTF-8/BOM、哈希、`xcodegen` 不可用故跳过。
7. 包内资产放 `e:\项目\dsh-remote-ios\ShellAssets\`（已在 `project.yml` 以 folder reference 作为 resource 打入 Bundle，根运行时路径为 Bundle 根，`Bundle.main.url(forResource:name,withExtension:nil)` 可直接取到）。

**模拟器测试命令（CI / mac 上执行，每个 Swift Task 复用）：**

```bash
xcodegen generate
DEST_ID=$(python3 -c "import json,subprocess;d=json.loads(subprocess.check_output(['xcrun','simctl','list','devices','available','-j']));devs=[v for u in d['devices'].values() for v in u if v['name'].lower().startswith('ipad')];print(sorted(devs,key=lambda x:x['name'])[-1]['udid'])")
xcodebuild test -project DSHRemote.xcodeproj -scheme DSHRemote -destination "id=$DEST_ID" CODE_SIGNING_ALLOWED=NO
```

预期：`** TEST SUCCEEDED **`。

---

## File Structure（先界定每个文件的职责边界）

本计划只在 iOS 仓 `e:\项目\dsh-remote-ios\` 内新增/修改下列文件。**不新增**超出此清单的文件。

| 文件 | 职责 | 本计划动作 |
|---|---|---|
| `ShellAssets/shell.html` | PC 壳 HTML 原样副本（Bundle 资源，运行时读取改写） | 新增（复制） |
| `ShellAssets/dsw-tokens.css` `writing.css` | PC 样式原样副本 | 新增（复制） |
| `ShellAssets/send.js` `watch.js` `editor-plain.js` `proofread.js` `sync-core.js` `writing-count-core.js` `writing.js` `send-net.js` `proofread-net.js` `sync-net.js` | PC 核心 JS 原样副本（共 10） | 新增（复制） |
| `ShellAssets/ipad.css` | **iOS 壳侧附加**样式：触控热区/touch-action/按 id 隐藏选目录 UI/软键盘；不改核心 | 新增 |
| `ShellAssets/ipad.js` | **iOS 壳侧附加**脚本：visualViewport 键盘兜底/点空白收键盘（回网补推由 writing.js 核心已有 online 钩子承接，此处不重复绑定）；不改核心 | 新增 |
| `Sources/AssetManifest.swift` | 资产白名单 + Content-Type | 改：白名单 11→12（Task 2）再 12→14（Task 12 加 ipad.css/ipad.js） |
| `Sources/ShellHTMLRewriter.swift` | 壳 HTML 运行时改写（运行时 14 处命中） | Task 12 改：viewport meta 增补 `interactive-widget=resizes-content`、writing.css link 后注入 ipad.css、sync-net.js script 后注入 ipad.js（先插 `/__shell__/ipad.*` 字面量再复用既有正则，命中数自洽为 14） |
| `Sources/ShellSchemeHandler.swift` | 应答 `dsh-asset://local/<name>` | 不改代码（仅注册） |
| `Sources/PathGuard.swift` | 段名校验/相对路径解析/符号链接逃逸/回收站戳/唯一名 | 新增 |
| `Sources/WorkspaceStore.swift` | 作品·文档·回收站全部文件操作，返回键照抄 Workspace.java | 新增 |
| `Sources/AppDataStore.swift` | config merge+clamp、drafts、proofread、baseline、last-session、hash12/SHA-1 | 新增 |
| `Sources/OutboxStore.swift` | 根级 `outbox.json`：去重入队/移除/列表（writeDoc 成功后由分发器内部调用） | 新增 |
| `Sources/BridgeDispatcher.swift` | 全方法位置参数分发（含 appendPomodoro 与 outbox 内部入队）；getState 沙盒 root + platform:"ipad" | 新增 |
| `Sources/NativeBridge.swift` | 异步 postMessage 收包/后台串行 IO/回主线程回包/10s 超时表 | 新增 |
| `Sources/BridgeSyncSchemeHandler.swift` | `dsh-bridge://sync` 同步 XHR，仅两 *Sync 当场分发 | 新增 |
| `Sources/BridgeJS.swift` | document-start 注入 JS 字符串（ownsHost + wcStorage Promise 包装 + wcWriting.hash12 + 同步 XHR 包装）；**ipad 资产引用不经此注入**，由 ShellHTMLRewriter 在 HTML 字符串上插入（见该文件行） | 新增 |
| `Sources/BackgroundFlusher.swift` | 切后台触发 `__wcFlushOnSessionEnd()`（beginBackgroundTask 续命；注入式可测内核 + WKWebView 薄绑定） | 新增 |
| `Sources/ShellWebView.swift` | 主 WebView：注册两个 scheme、主框架导航接管、注入、生命周期、后台 flush 绑定 | 改 |
| `Sources/S1ViewController.swift` | S1 探针宿主 | 改：注册 dsh-asset/dsh-bridge，加第五探针 |
| `Sources/S1ProbePage.swift` | 五探针页 | 改：加 dsh-bridge 探针，allGreen 计数 5 |
| `Sources/App.swift` | @main / RootView / ShellSession 共享会话 / ScenePhase 后台 flush | 改：RootView 持有 ShellSession，`.background` 调 flusher，ShellWebView 接 session |
| `Tests/DSHRemoteTests/AssetManifestTests.swift` | 白名单计数 | 改：11→12（Task 2）再 12→14（Task 12） |
| `Tests/DSHRemoteTests/ShellHTMLRewriterTests.swift` | 改写命中 + ipad 资产注入 | Task 2 改：内联引用加 writing-count-core.js；Task 12 再改：内联引用补 writing.css 锚点、加注入位置/顺序/幂等/14 命中全链路断言 |
| `Tests/DSHRemoteTests/ShellNavigationTests.swift` | Bundle 真实 shell 改写计数 + 导航判定 | Task 4 新增（12 命中）；Task 12 随注入升级为 14 命中并断言两 ipad 资产 |
| `Tests/DSHRemoteTests/PathGuardTests.swift` | PathGuard 单测 | 新增 |
| `Tests/DSHRemoteTests/WorkspaceStoreTests.swift` | WorkspaceStore 单测 | 新增 |
| `Tests/DSHRemoteTests/AppDataStoreTests.swift` | AppDataStore 单测 | 新增 |
| `Tests/DSHRemoteTests/OutboxStoreTests.swift` | OutboxStore 单测 | 新增 |
| `Tests/DSHRemoteTests/BridgeDispatcherTests.swift` | 分发单测 | 新增 |
| `Tests/DSHRemoteTests/NativeBridgeTests.swift` | 异步桥解包/分发/串行队列/应答字面量单测 | 新增 |
| `Tests/DSHRemoteTests/BridgeJSTests.swift` | 注入 JS 结构与行为单测（JavaScriptCore 桩 postMessage/XHR） | 新增 |
| `Tests/DSHRemoteTests/BridgeSyncSchemeHandlerTests.swift` | 同步 XHR handler 单测 | 新增 |
| `Tests/DSHRemoteTests/BackgroundFlusherTests.swift` | 后台 flush 内核单测（脚本字面量/续命 token 配对/重入/解绑/无 web 静默） | 新增 |

**职责边界铁律：**
- `shell.html` 与 10 个 JS、2 个 CSS 是**只读副本**，任何平台差异都不得改它们，只能经 `ipad.css`/`ipad.js`（壳侧附加）与运行时改写承接。
- `BridgeDispatcher` 是唯一接触业务方法分发的地方；`NativeBridge`（异步）与 `BridgeSyncSchemeHandler`（同步）都只做「收包 → 调 dispatcher → 回包」，不含业务分支。
- `WorkspaceStore` 只管 `workspace/` 内；`AppDataStore` 只管 Documents 根级各 JSON 与 drafts/proofread/sync；二者互不嵌套。

---

## Task 1：复制 13 个 PC 壳资产到 ShellAssets（原样、一字不改）

资产清单（源在 `e:\项目\dsh-remote\writing-client\`，目标在 `e:\项目\dsh-remote-ios\ShellAssets\`）：`shell.html`、`dsw-tokens.css`、`writing.css`、`send.js`、`watch.js`、`editor-plain.js`、`proofread.js`、`sync-core.js`、`writing-count-core.js`、`writing.js`、`send-net.js`、`proofread-net.js`、`sync-net.js`。共 **13** 个（其中 12 个被 shell.html 外链；shell.html 自身不被外链）。

- [ ] **1.1 复制前先确认源目录 13 个文件都存在**

执行（PowerShell）：

```powershell
$names = 'shell.html','dsw-tokens.css','writing.css','send.js','watch.js','editor-plain.js','proofread.js','sync-core.js','writing-count-core.js','writing.js','send-net.js','proofread-net.js','sync-net.js'
$src = 'e:\项目\dsh-remote\writing-client'
$names | ForEach-Object { "{0} {1}" -f (Test-Path (Join-Path $src $_)), $_ }
```

预期：13 行全部以 `True` 开头。若有 `False`，停止本 Task，先核对文件是否被重命名/移动。

- [ ] **1.2 逐字节复制 13 个文件到 ShellAssets（保留原字节，不重编码）**

`Copy-Item` 为字节直拷，不解析/不改编码，满足“一字不改”。执行：

```powershell
$dst = 'e:\项目\dsh-remote-ios\ShellAssets'
$names | ForEach-Object { Copy-Item -LiteralPath (Join-Path $src $_) -Destination (Join-Path $dst $_) -Force }
```

预期：无输出（成功）。

- [ ] **1.3 哈希比对，确认 13 个副本与源逐字节一致**

执行：

```powershell
$names | ForEach-Object {
  $h1 = (Get-FileHash -LiteralPath (Join-Path $src $_) -Algorithm SHA256).Hash
  $h2 = (Get-FileHash -LiteralPath (Join-Path $dst $_) -Algorithm SHA256).Hash
  "{0} {1}" -f ($h1 -eq $h2), $_
}
```

预期：13 行全部 `True <name>`。若有 `False`，删除该目标文件后重做 1.2。

- [ ] **1.4 确认所有副本无 UTF-8 BOM（web 核心源本就无 BOM；哈希一致即可证明，此处再独立扫一次）**

执行：

```powershell
$names | ForEach-Object {
  $b = [System.IO.File]::ReadAllBytes((Join-Path $dst $_))
  $bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  "{0} {1}" -f (-not $bom), $_
}
```

预期：13 行全部 `True <name>`。

> 说明：本 Task 不写 Swift 代码，无可跑单测。资产来源 commit 记录在执行总结中（不写入仓库文件，避免新增文档）。

---

## Task 2：AssetManifest 白名单 11→12 并同步两处测试（TDD）

- [ ] **2.1 先改测试：AssetManifest 计数断言改为 12 并改名**

编辑 `Tests/DSHRemoteTests/AssetManifestTests.swift`。把当前的

```swift
    func testWhitelistContainsElevenAssets() {
        XCTAssertEqual(AssetManifest.names.count, 11)
```

替换为

```swift
    func testWhitelistContainsTwelveAssets() {
        XCTAssertEqual(AssetManifest.names.count, 12)
        XCTAssertTrue(AssetManifest.isAsset("writing-count-core.js"))
```

（同文件内对 contentType/ping/`../writing.js` 的既有断言保持不变。）

- [ ] **2.2 同步改 ShellHTMLRewriterTests：内联引用列表加 writing-count-core.js**

编辑 `Tests/DSHRemoteTests/ShellHTMLRewriterTests.swift`。该测试目前在一个内联 HTML 字符串里列出 **11** 个 `/__shell__/x.js|css` 引用。在其中 `sync-core.js` 引用之后、`writing.js` 之前，加入一行

```html
  <script src="/__shell__/writing-count-core.js"></script>
```

使内联引用总数为 12；这样既有的 `hits == names.count`（12）断言才成立。文件内其它断言（含 `dsh-asset://local/writing.css`、`writing.js`、不含 `/__shell__/writing.`、iframe `/app#/`、`/auth/login` 保持）不动。

- [ ] **2.3 运行测试，验证新测试失败（Red）**

在 mac/CI 上执行「模拟器测试命令」。预期：编译通过但测试失败——

```
XCTAssertEqual failed: ("11") is not equal to ("12")
```

且 ShellHTMLRewriterTests 因命中数（12）与白名单数（11）不符而抛错。若测试已通过，说明 2.1/2.2 未真正生效，不要继续。

- [ ] **2.4 最小实现：白名单加入 writing-count-core.js**

编辑 `Sources/AssetManifest.swift`，在 `static let names: Set<String> = [` 的列表中，把

```swift
        "sync-core.js", "writing.js", "send-net.js",
```

替换为

```swift
        "sync-core.js", "writing-count-core.js", "writing.js", "send-net.js",
```

（集合元素顺序对计数/判定无影响；放在 sync-core 与 writing 之间仅为与 shell.html 外链顺序一致，便于阅读。）

- [ ] **2.5 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`，AssetManifestTests 与 ShellHTMLRewriterTests 全绿。

- [ ] **2.6 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/AssetManifest.swift Tests/DSHRemoteTests/AssetManifestTests.swift Tests/DSHRemoteTests/ShellHTMLRewriterTests.swift ShellAssets
git commit -m "feat(assets): 内置 PC 壳 13 资产并把白名单扩到 12（含 writing-count-core）"
```

---

## Task 3：S1 注册 dsh-asset / dsh-bridge，新增第五探针并真机验证

本 Task 是写业务存储代码前的最高优先级真机 Spike（spec §3.6）。探针④当前必失败，根因是 `S1ViewController` 从未 `setURLSchemeHandler`。本 Task 先补齐两个 scheme 的注册与第五探针。

- [ ] **3.1 先改探针页：新增第五探针（dsh-bridge 同步 XHR）并把 allGreen 计数改为 5**

编辑 `Sources/S1ProbePage.swift`。该文件当前在探针④（同步 XHR `dsh-asset://local/ping`，是一个同步函数 `probeSyncXHR`）之后汇总 `results`。在④对应函数之后、`render` 之前，加入第五探针。探针⑤与④一样是同步函数；方法名放在 **URL query**（`?m=__ping__`），不依赖请求体——这是刻意的，原因见 3.4。逐字插入：

```javascript
        function probe5SyncXHR(){
          try {
            const x = new XMLHttpRequest();
            x.open('POST', 'dsh-bridge://sync?m=__ping__', false);
            x.send(JSON.stringify({method:'__ping__', args:[]}));
            const o = JSON.parse(x.responseText);
            record('⑤ 同步 XHR dsh-bridge',
                   x.status === 200 && o.ok === true && o.echo === 'bridge-pong',
                   'status=' + x.status + ' body=' + x.responseText);
          } catch (e) { record('⑤ 同步 XHR dsh-bridge', false, String(e)); }
        }
```

并把探针汇总处的

```javascript
          const allGreen = results.length === 4 && results.every(r => r.pass);
```

替换为

```javascript
          const allGreen = results.length === 5 && results.every(r => r.pass);
```

同时把页面标题与 `render` 末尾「四项全绿才进入 M1。」分别改为「S1 五探针报告」与「五项全绿才进入 M1。」；并在文件末尾的 IIFE 中，在 `probeSyncXHR();` 之后加一行 `probe5SyncXHR();`（同步调用，不进 await 链）：

```javascript
        (async () => {
          await probeCookie();
          await probeIframe();
          probeSyncXHR();
          probe5SyncXHR();
          render();
        })();
```

报告上报 `s1Report` 的结构 `{allGreen, results}` 不变（results 现为 5 项）。

- [ ] **3.2 在 S1ViewController 注册 dsh-asset 与 dsh-bridge 两个自定义 scheme**

编辑 `Sources/S1ViewController.swift`。在创建 `WKWebViewConfiguration` 处（`let cfg = WKWebViewConfiguration()` 之后、`WKWebView(frame:configuration:)` 之前）加入：

```swift
        cfg.setURLSchemeHandler(ShellSchemeHandler(loadData: { name in
            guard let url = Bundle.main.url(forResource: name, withExtension: nil) else { return nil }
            return try? Data(contentsOf: url)
        }), forURLScheme: "dsh-asset")
        cfg.setURLSchemeHandler(S1BridgePingHandler(), forURLScheme: "dsh-bridge")
```

- [ ] **3.3 新增 S1 专用 dsh-bridge 回显 handler（仅探针用，最小实现）**

在 `Sources/S1ViewController.swift` 同文件末尾（文件内类型作用域之外）新增一个最小 handler 类型。判定**只读 URL query 的 `m`**，不读请求体（原因见 3.4），逐字新增：

```swift
final class S1BridgePingHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let req = urlSchemeTask.request
        let fallback = URL(string: "dsh-bridge://sync")!
        let m = URLComponents(url: req.url ?? fallback, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "m" })?.value ?? ""
        let payload: [String: Any] = m == "__ping__"
            ? ["ok": true, "echo": "bridge-pong"]
            : ["ok": false, "error": "s1-only-ping"]
        let out = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
        let headers: [String: String] = [
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": String(out.count),
            "Access-Control-Allow-Origin": "*"
        ]
        guard let resp = HTTPURLResponse(url: req.url ?? fallback,
                                        statusCode: 200, httpVersion: "HTTP/1.1",
                                        headerFields: headers) else {
            urlSchemeTask.didFailWithError(NSError(domain: "dsh-bridge", code: -1))
            return
        }
        urlSchemeTask.didReceive(resp)
        urlSchemeTask.didReceive(out)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
```

> `S1ViewController.swift` 现仅 `import UIKit` / `import WebKit`；iOS 上 UIKit 已透传 Foundation，JSONSerialization/URLComponents 可直接用，无需另加 import。

- [ ] **3.4 记录 Spike 边界：为什么探针用 query 而不用请求体（正式通道在 Task 10 据真机结论落地）**

`WKURLSchemeTask` **不提供请求体读取 API**：自定义 scheme 下 `urlSchemeTask.request.httpBody` 常为 nil，`httpBodyStream` 也未必可用。因此探针⑤刻意把方法名放在 URL query，只验证与请求体无关的一件事——**「自定义 scheme + 同步 XHR 能当场回包」**，与 spec §3.6 探针④「同步行为与具体 scheme 名无关」的定位一致。这样无论请求体在真机上是否可读，本 Spike 都有确定结论，不留占位代码。

真机五探针跑完后，把「同步 XHR 请求体是否可读」作为附带观察记入 syslog（可在 handler 里临时加 `NSLog("httpBody bytes=\(String(describing

- [ ] **3.5 跑模拟器测试，确认工程编译通过、既有测试不回归**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`（探针页本身无单测断言，此处仅保证编译与既有 4 个测试文件通过）。

- [ ] **3.6 真机验证（SideStore 装机后，用户在场）**

推 CI 产出新 IPA 前**须征得用户同意**；用户在 iPad 上：连接 Tailscale → 打开 DSHRemote → 网关配置页连点标题 5 次进入 S1 → 先登录一次 → 运行探针。预期五探针全绿（results 五项 ok，allGreen=true）：

1. origin = 网关 origin；
2. fetch `/auth/login` 带 Cookie 200；
3. iframe `/app#/` 不被 frame-ancestors 拒；
4. 同步 XHR `dsh-asset://local/ping` 拿到 `{ok:true,echo:"pong"}`；
5. 同步 XHR `dsh-bridge://sync?m=__ping__` 拿到 `{ok:true,echo:"bridge-pong"}`。

任一变红：按 spec §3.6 回退顺位处理（origin 破裂→Funnel HTTPS 重跑；仅同步 XHR 不成立→记录现象并在 Task 10 改退路，不改动 writing.js）。**截图 + syslog 归档结果**，再进入后续 Task。

- [ ] **3.7 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/S1ProbePage.swift Sources/S1ViewController.swift
git commit -m "feat(s1): 注册 dsh-asset/dsh-bridge 并新增第五同步 XHR 探针"
```

---

## Task 4：接管 `/__shell__/shell.html` 主框架导航（虚拟同源）

目标（spec §3.2 A）：App 直连网关 shellURL 发起请求；导航策略对“主框架 + 路径前缀 `/__shell__/`”回 `.cancel`，随即读取 Bundle 内 `shell.html` → `ShellHTMLRewriter.rewrite` → `loadHTMLString(_:baseURL:)`（baseURL = 该次请求的 shellURL）。

- [ ] **4.1 先写失败测试：壳 HTML 读取与改写的集成断言**

新增 `Tests/DSHRemoteTests/ShellNavigationTests.swift`：

```swift
import XCTest
@testable import DSHRemote

final class ShellNavigationTests: XCTestCase {
    func testBundleShellHTMLRewritesTwelveReferences() throws {
        let url = try XCTUnwrap(Bundle(for: ShellNavigationTests.self)
            .url(forResource: "shell", withExtension: "html"))
        let raw = try String(contentsOf: url, encoding: .utf8)
        let out = try ShellHTMLRewriter.rewrite(raw)
        XCTAssertEqual(out.components(separatedBy: "dsh-asset://local/").count - 1, 12)
        XCTAssertFalse(out.contains("/__shell__/"))
        XCTAssertTrue(out.contains("src=\"/app#/\""))
    }
}
```

说明：测试 bundle 是否包含 `shell.html` 取决于测试 host 对资源的拷贝。为避免依赖测试 target 的 resource 拷贝，若运行时取不到该资源，改用如下不依赖 Bundle 的断言（二选一，本计划采用 Bundle 版；若 4.2 验证发现测试 target 无该资源，则把测试体改为读取 Sources 无关的内联 12 引用字符串并断言改写结果，与 ShellHTMLRewriterTests 同构）。

- [ ] **4.2 确认测试 target 能取到 shell.html；运行测试验证失败（Red）**

执行「模拟器测试命令」。预期此时失败：`XCTUnwrap` 报资源为 nil（测试 target 默认不拷 ShellAssets），或命中数相关断言失败。**据此落实资源取法**：在 `project.yml` 的 `DSHRemoteTests` target 增加对 ShellAssets 的 resource 依赖。编辑 `project.yml`，在测试 target（`DSHRemoteTests:`）下加入：

```yaml
    dependencies:
      - target: DSHRemote
    resources:
      - path: ShellAssets
        type: folder
        group: ""
```

重新 `xcodegen generate` 后再跑，预期测试进入对改写结果的断言；因尚未接管导航（不影响本断言），此处失败点应是「取不到资源」已解除、断言针对改写——实际 `ShellHTMLRewriter.rewrite` 已存在且白名单为 12，故该断言此刻即可通过。若如此，本 Task 的 Red 由 4.3 的导航行为单测承接。

- [ ] **4.3 新增导航判定纯函数并先写其测试（Red）**

为让“哪些导航要接管”可单测，在 `Sources/ShellWebView.swift` 内先定义一个纯判定（暂不接线到 WKNavigationDelegate）。新增测试到 `ShellNavigationTests.swift`：

```swift
    func testShouldTakeOverShellNavigation() {
        XCTAssertTrue(ShellNavPolicy.shouldTakeOver(mainFrame: true,
            url: URL(string: "https://gw.example.com/__shell__/shell.html")!))
        XCTAssertFalse(ShellNavPolicy.shouldTakeOver(mainFrame: false,
            url: URL(string: "https://gw.example.com/__shell__/shell.html")!))
        XCTAssertFalse(ShellNavPolicy.shouldTakeOver(mainFrame: true,
            url: URL(string: "https://gw.example.com/app#/")!))
        XCTAssertFalse(ShellNavPolicy.shouldTakeOver(mainFrame: true,
            url: URL(string: "https://gw.example.com/auth/login")!))
    }
```

运行测试，预期编译失败：`ShellNavPolicy` 不存在（Red）。

- [ ] **4.4 最小实现 ShellNavPolicy 并接线到导航委托**

在 `Sources/ShellWebView.swift` 中，在 `ShellWebView` 类型之外新增：

```swift
enum ShellNavPolicy {
    static func shouldTakeOver(mainFrame: Bool, url: URL) -> Bool {
        guard mainFrame else { return false }
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return c.path.hasPrefix("/__shell__/")
    }
}
```

然后在该文件的 Coordinator（`WKNavigationDelegate`）中加入导航接管方法。在 Coordinator 内新增：

```swift
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              ShellNavPolicy.shouldTakeOver(
                mainFrame: navigationAction.targetFrame?.isMainFrame ?? false, url: url) else {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        Self.loadLocalShell(into: webView, baseURL: url)
    }

    static func loadLocalShell(into webView: WKWebView, baseURL: URL) {
        guard let u = Bundle.main.url(forResource: "shell", withExtension: "html"),
              let raw = try? String(contentsOf: u, encoding: .utf8),
              let rewritten = try? ShellHTMLRewriter.rewrite(raw) else {
            NSLog("[DSH] 本地壳读取/改写失败，回退网络加载")
            if let wv = webView as WKWebView? { webView.load(URLRequest(url: baseURL)) }
            return
        }
        webView.loadHTMLString(rewritten, baseURL: baseURL)
    }
```

> 若 Coordinator 当前已有 `decidePolicyFor`（仅有 mTLS challenge 相关的是 `didReceive challenge`，不同方法），确保只新增此方法、不重复定义。

- [ ] **4.5 改 App 入口：让主 WebView 直连网关 shellURL（而非 `/app#/`）**

编辑 `Sources/App.swift`。当前在网关已配置处承载：

```swift
ShellWebView(urlString: Cfg.gateway + Cfg.entryPath).ignoresSafeArea(edges: .bottom)
```

将其替换为：

```swift
ShellWebView(urlString: shellURLString).ignoresSafeArea(edges: .bottom)
```

并在 `RootView` 内（`Cfg.gateway` 非空判定通过的作用域）取得 shell URL。把入口判定的网关有效性复用 `GatewayURL.normalize`，新增一个局部常量：

```swift
        let normalized = try? GatewayURL.normalize(Cfg.gateway)
```

将承载 WebView 处的条件由“网关非空”改为“normalize 成功”，并以 `normalized?.shell ?? (Cfg.gateway + Cfg.entryPath)` 作为 `shellURLString`。最小改法：在 RootView body 中，`if Cfg.gateway.isEmpty { ... } else { ... }` 的 `else` 分支里用：

```swift
                let shell = (try? GatewayURL.normalize(Cfg.gateway))?.shell
                    ?? (Cfg.gateway + Cfg.entryPath)
                ShellWebView(urlString: shell).ignoresSafeArea(edges: .bottom)
```

（连点 5 次进 S1 的既有判定 `(try? GatewayURL.normalize(Cfg.gateway)) != nil` 保持不变。`Cfg.entryPath` 仍被 S1 与兜底使用，不删。）

- [ ] **4.6 更正 ShellWebView.swift 顶部过时注释**

该文件头注释（约 15–16 行）断言 WKURLSchemeHandler 不能拦 http/https 故「这条路走不通」。这是针对“用 scheme handler 拦 http”的旧结论；本方案改为“主框架导航接管 + 自定义 scheme 供资产”。把该结论句替换为：

```swift
// 本地应答路线：WKURLSchemeHandler 不能拦 http/https，故主框架 /__shell__/ 经
// decidePolicyFor 取消 + loadHTMLString(baseURL:网关) 虚拟同源；本地资产走自定义
// dsh-asset://（见 ShellSchemeHandler）。iframe 与 /api 等保持直连网关。
```

（仅改注释，不改其它逻辑。）

- [ ] **4.7 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`，含 ShellNavigationTests 全部断言与既有测试。

- [ ] **4.8 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/ShellWebView.swift Sources/App.swift project.yml Tests/DSHRemoteTests/ShellNavigationTests.swift
git commit -m "feat(shell): 接管 /__shell__/ 主框架导航并以网关 baseURL 虚拟同源载入本地壳"
```

---

## Task 5：PathGuard —— 段名校验 / 相对路径解析 / 逃逸防护 / 唯一名

目标（蓝本 `PathGuard.java`，一比一复刻）：作为 `WorkspaceStore` 的安全底座，提供段名校验、相对路径拆分、`.md` 判定、回收站戳、canonical 逃逸防护与重名唯一位。本 Task 只做规则与文件系统判定，不做任何业务操作。

错误模型：Java 侧抛 `IllegalArgumentException`；Swift 侧统一抛 `PathGuardError.bad(msg)`，其 `errorDescription` 为逐字相同的中文消息，保证错误信息跨端一致、可被测试逐片段断言。

- [ ] **5.1 先写失败测试 `Tests/DSHRemoteTests/PathGuardTests.swift`（Red）**

新增文件，完整内容：

```swift
import XCTest
@testable import DSHRemote

final class PathGuardTests: XCTestCase {

    func assertBad<T>(_ expression: @autoclosure () throws -> T,
                      _ fragment: String,
                   file: StaticString = #filePath,
                   line: UInt = #line) {
        XCTAssertThrowsError(try expression(), file: file, line: line) { err in
            let desc = (err as? LocalizedError)?.errorDescription ?? String(describing: err)
            XCTAssertTrue(desc.contains(fragment),
                          "预期错误信息含「\(fragment)」，实际：\(desc)",
                          file: file, line: line)
        }
    }

    func makeTempRoot() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("PathGuardTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testConstants() {
        XCTAssertEqual(PathGuard.trashDir, "_回收")
        XCTAssertEqual(PathGuard.workTrashSub, "_作品")
        XCTAssertEqual(PathGuard.maxSegment, 120)
    }

    func testValidateSegmentAccepts() throws {
        XCTAssertEqual(try PathGuard.validateSegment("作品A"), "作品A")
        XCTAssertEqual(try PathGuard.validateSegment("我的文档.md"), "我的文档.md")
        let boundary = String(repeating: "a", count: 120)
        XCTAssertEqual(try PathGuard.validateSegment(boundary), boundary)
    }

    func testValidateSegmentRejects() {
        assertBad(try PathGuard.validateSegment(nil), "名称必须是字符串")
        assertBad(try PathGuard.validateSegment(""), "名称不得为空")
        assertBad(try PathGuard.validateSegment("."), "路径段不得为")
        assertBad(try PathGuard.validateSegment(".."), "路径段不得为")
        assertBad(try PathGuard.validateSegment("a/b"), "禁用字符")
        assertBad(try PathGuard.validateSegment("a\\b"), "禁用字符")
        assertBad(try PathGuard.validateSegment("a:b"), "禁用字符")
        assertBad(try PathGuard.validateSegment("a*?"), "禁用字符")
        assertBad(try PathGuard.validateSegment("a|<>\""), "禁用字符")
        assertBad(try PathGuard.validateSegment("a\u{0}b"), "禁用字符")
        assertBad(try PathGuard.validateSegment(" a"), "首尾不得有空白")
        assertBad(try PathGuard.validateSegment("a\t"), "首尾不得有空白")
        assertBad(try PathGuard.validateSegment("a "), "首尾不得有空白")
        assertBad(try PathGuard.validateSegment("a."), "不得以点或空格结尾")
        assertBad(try PathGuard.validateSegment(String(repeating: "a", count: 121)),
                  "名称过长")
        assertBad(try PathGuard.validateSegment("CON"), "保留设备名")
        assertBad(try PathGuard.validateSegment("prn"), "保留设备名")
        assertBad(try PathGuard.validateSegment("Com1"), "保留设备名")
        assertBad(try PathGuard.validateSegment("lpt9.md"), "保留设备名")
        assertBad(try PathGuard.validateSegment("nul.txt"), "保留设备名")
    }

    func testSplitRel() throws {
        XCTAssertEqual(try PathGuard.splitRel("作品A/文档.md"), ["作品A", "文档.md"])
        XCTAssertEqual(try PathGuard.splitRel("作品A\\文档.md"), ["作品A", "文档.md"])
        XCTAssertEqual(try PathGuard.splitRel("a//b/"), ["a", "b"])
        assertBad(try PathGuard.splitRel(nil), "路径为空")
        assertBad(try PathGuard.splitRel(""), "路径为空")
        assertBad(try PathGuard.splitRel("/a/b"), "绝对路径")
        assertBad(try PathGuard.splitRel("\\a"), "绝对路径")
        assertBad(try PathGuard.splitRel("C:/a"), "盘符路径")
        assertBad(try PathGuard.splitRel("d:\\a"), "盘符路径")
    }

    func testMdHelpers() throws {
        XCTAssertTrue(PathGuard.hasMdExt("a.md"))
        XCTAssertTrue(PathGuard.hasMdExt("A.MD"))
        XCTAssertFalse(PathGuard.hasMdExt("a.txt"))
        XCTAssertFalse(PathGuard.hasMdExt(nil))
        XCTAssertEqual(try PathGuard.assertMd("作品/a.md"), "a.md")
        assertBad(try PathGuard.assertMd("作品/a.txt"), "只允许 .md")
        XCTAssertEqual(PathGuard.ensureMd("a"), "a.md")
        XCTAssertEqual(PathGuard.ensureMd("a.MD"), "a.MD")
        XCTAssertEqual(PathGuard.ensureMd(nil), ".md")
    }

    func testTrashStamp() {
        XCTAssertEqual(
            PathGuard.trashStamp(year: 2026, month: 3, day: 5, hour: 9, minute: 7, second: 1),
            "20260305-090701")
        XCTAssertNotNil(PathGuard.trashStampNow().range(of: #"^\d{8}-\d{6}$"#,
                                                        options: .regularExpression))
        XCTAssertEqual(PathGuard.stripTrashStamp("日记-20260305-090701"), "日记")
        XCTAssertEqual(PathGuard.stripTrashStamp("日记"), "日记")
    }

    func testQuote() {
        XCTAssertEqual(PathGuard.quote("a"), "\"a\"")
        XCTAssertEqual(PathGuard.quote("a\"b"), "\"a\\\"b\"")
        XCTAssertEqual(PathGuard.quote("a\\b"), "\"a\\\\b\"")
    }

    func testResolveInRootAcceptsAndBlocksEscape() throws {
        let root = try makeTempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let resolved = try PathGuard.resolveInRoot(root: root, relPath: "作品/a.md")
        XCTAssertEqual(resolved.path,
                       root.appendingPathComponent("作品").appendingPathComponent("a.md").path)

        assertBad(try PathGuard.resolveInRoot(root: root, relPath: "../escape.md"),
                  "路径段不得为")

        let outside = root.deletingLastPathComponent()
            .appendingPathComponent("PathGuardOutside-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }

        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        assertBad(try PathGuard.resolveInRoot(root: root, relPath: "link/x.md"), "路径越界")

        assertBad(try PathGuard.resolveInRoot(root: root, relPath: "."), "路径为空")
    }

    func testUniquePath() throws {
        let root = try makeTempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let f = root.appendingPathComponent("a.md")
        XCTAssertEqual(try PathGuard.uniquePath(f, isDir: false).lastPathComponent, "a.md")

        FileManager.default.createFile(atPath: f.path, contents: Data())
        XCTAssertEqual(try PathGuard.uniquePath(f, isDir: false).lastPathComponent, "a-2.md")

        FileManager.default.createFile(
            atPath: root.appendingPathComponent("a-2.md").path, contents: Data())
        XCTAssertEqual(try PathGuard.uniquePath(f, isDir: false).lastPathComponent, "a-3.md")

        let dotless = root.appendingPathComponent("README")
        FileManager.default.createFile(atPath: dotless.path, contents: Data())
        XCTAssertEqual(try PathGuard.uniquePath(dotless, isDir: false).lastPathComponent,
                       "README-2")

        let d = root.appendingPathComponent("作品")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        XCTAssertEqual(try PathGuard.uniquePath(d, isDir: true).lastPathComponent, "作品-2")
    }
}
```

> **主控裁决（Task 13.3 第五次 CI，2026-10-11）**：上方 `assertBad` 围栏原样声明为 `@autoclosure () throws -> Void`，但调用点传入的表达式返回 `String`（validateSegment/assertMd）、`[String]`（splitRel）、`URL`（resolveInRoot），autoclosure 返回类型与 `Void` 不匹配——第五次 CI（run 38127620807）在 NativeBridge 错误清除后编译深入本文件，一次报 33 条 `cannot convert value of type 'String'/'[String]'/URL' to expected argument type 'Void'`（均列 33，指向首个实参）。`XCTAssertThrowsError` 本身是泛型 API，辅助函数同步泛型化：双侧改为 `func assertBad<T>(_ expression: @autoclosure () throws -> T, _ fragment: String, ...)`，丢弃返回值即可捕获错误。6.1 WorkspaceStoreTests 的同名辅助原声明为 `() throws -> [String: Any]`（仅适配字典返回，本轮侥幸未报）一并统一为 `<T>`，消除同类隐患。

- [ ] **5.2 运行模拟器测试，验证失败（Red）**

执行「模拟器测试命令」。预期编译失败，关键报错形如：`error: cannot find 'PathGuard' in scope`（测试中所有引用均未定义）。该失败即 Red，停止继续，进入实现。

- [ ] **5.3 新增 `Sources/PathGuard.swift`（完整实现）**

新增文件，完整内容：

```swift
import Foundation

enum PathGuardError: LocalizedError {
    case bad(String)

    var errorDescription: String? {
        switch self {
        case .bad(let msg): return msg
        }
    }
}

enum PathGuard {
    static let trashDir = "_回收"
    static let workTrashSub = "_作品"
    static let maxSegment = 120

    private static let forbiddenChars = try! NSRegularExpression(
        pattern: "[\\\\/:*?\"<>|\u{00}-\u{1f}]")
    private static let reservedNames = try! NSRegularExpression(
        pattern: "^(con|prn|aux|nul|com[1-9]|lpt[1-9])$",
        options: [.caseInsensitive])
    private static let mdExt = try! NSRegularExpression(
        pattern: "\\.md$", options: [.caseInsensitive])
    private static let tsSuffix = try! NSRegularExpression(pattern: "-\\d{8}-\\d{6}$")
    private static let lastExt = try! NSRegularExpression(pattern: "\\.[^.]*$")
    private static let drivePrefix = try! NSRegularExpression(pattern: "^[a-zA-Z]:.*")

    static func bad(_ msg: String) -> PathGuardError { .bad(msg) }

    @discardableResult
    static func validateSegment(_ seg: String?) throws -> String {
        guard let seg = seg else { throw bad("名称必须是字符串") }
        if seg.isEmpty { throw bad("名称不得为空") }
        if seg == "." || seg == ".." {
            throw bad("拒绝：路径段不得为 \".\" 或 \"..\"（疑似路径逃逸）: \(seg)")
        }
        if forbiddenChars.hasMatch(seg) {
            throw bad("名称含禁用字符（/ \\ : * ? \" < > | 及控制字符）: \(seg)")
        }
        if seg != javaTrim(seg) { throw bad("名称首尾不得有空白: \(quote(seg))") }
        if seg.hasSuffix(".") || seg.hasSuffix(" ") {
            throw bad("名称不得以点或空格结尾: \(quote(seg))")
        }
        if seg.utf16.count > maxSegment {
            throw bad("名称过长（> \(maxSegment) 字符）: \(seg)")
        }
        let stem = lastExt.replaceAll(in: seg)
        if reservedNames.hasMatch(seg) || reservedNames.hasMatch(stem) {
            throw bad("名称是 Windows 保留设备名: \(seg)")
        }
        return seg
    }

    static func splitRel(_ relPath: String?) throws -> [String] {
        guard let relPath = relPath, !relPath.isEmpty else { throw bad("路径为空") }
        if relPath.hasPrefix("/") || relPath.hasPrefix("\\") {
            throw bad("拒绝绝对路径: \(relPath)")
        }
        if drivePrefix.hasMatch(relPath) { throw bad("拒绝盘符路径: \(relPath)") }
        let segs = relPath.replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        if segs.isEmpty { throw bad("路径为空: \(relPath)") }
        return segs
    }

    static func hasMdExt(_ name: String?) -> Bool {
        guard let name = name else { return false }
        return mdExt.hasMatch(name)
    }

    @discardableResult
    static func assertMd(_ relPath: String) throws -> String {
        let segs = try splitRel(relPath)
        let last = segs[segs.count - 1]
        guard hasMdExt(last) else { throw bad("只允许 .md 文件: \(last)") }
        return last
    }

    static func ensureMd(_ name: String?) -> String {
        let n = name ?? ""
        return hasMdExt(n) ? n : n + ".md"
    }

    static func trashStamp(year: Int, month: Int, day: Int,
                           hour: Int, minute: Int, second: Int) -> String {
        pad4(year) + pad2(month) + pad2(day) + "-"
            + pad2(hour) + pad2(minute) + pad2(second)
    }

    static func trashStampNow(date: Date = Date()) -> String {
        let c = Calendar(identifier: .gregorian)
        let v = c.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return trashStamp(year: v.year ?? 1970, month: v.month ?? 1, day: v.day ?? 1,
                          hour: v.hour ?? 0, minute: v.minute ?? 0, second: v.second ?? 0)
    }

    static func stripTrashStamp(_ s: String) -> String {
        tsSuffix.replaceAll(in: s)
    }

    @discardableResult
    static func resolveInRoot(root: URL, relPath: String) throws -> URL {
        let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath()
        let segs = try splitRel(relPath)
        var cur = canonicalRoot
        for seg in segs {
            try validateSegment(seg)
            cur.appendPathComponent(seg)
        }
        let real = cur.standardizedFileURL.resolvingSymlinksInPath()
        let c = real.path
        let r = canonicalRoot.path
        let inside = c == r || c.hasPrefix(r + "/")
        if !inside {
            throw bad("拒绝：路径越界。输入=\(relPath) 解析后=\(c) 不在根 \(r) 之内")
        }
        if c == r { throw bad("拒绝：路径指向根目录本身: \(relPath)") }
        return real
    }

    static func uniquePath(_ abs: URL, isDir: Bool) throws -> URL {
        if !FileManager.default.fileExists(atPath: abs.path) { return abs }
        let dir = abs.deletingLastPathComponent()
        let name = abs.lastPathComponent
        let stem: String
        let ext: String
        if isDir {
            stem = name
            ext = ""
        } else if let m = lastExt.firstMatch(in: name), m.range.location > 0 {
            let dot = name.index(name.startIndex, offsetBy: m.range.location)
            stem = String(name[name.startIndex..<dot])
            ext = String(name[dot...])
        } else {
            stem = name
            ext = ""
        }
        for k in 2..<1000 {
            let cand = dir.appendingPathComponent("\(stem)-\(k)\(ext)")
            if !FileManager.default.fileExists(atPath: cand.path) { return cand }
        }
        throw bad("目标重名过多，无法落位: \(abs.path)")
    }

    static func javaTrim(_ s: String) -> String {
        var scalars = s.unicodeScalars
        while let first = scalars.first, first.value <= 0x20 { scalars.removeFirst() }
        while let last = scalars.last, last.value <= 0x20 { scalars.removeLast() }
        return String(scalars)
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for ch in s {
            if ch == "\"" || ch == "\\" { out.append("\\") }
            out.append(ch)
        }
        out.append("\"")
        return out
    }

    private static func pad2(_ n: Int) -> String { String(format: "%02d", n) }
    private static func pad4(_ n: Int) -> String { String(format: "%04d", n) }
}

private extension NSRegularExpression {
    func hasMatch(_ s: String) -> Bool {
        firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    func firstMatch(in s: String) -> NSTextCheckingResult? {
        firstMatch(in: s, range: NSRange(s.startIndex..., in: s))
    }

    func replaceAll(in s: String, template: String = "") -> String {
        stringByReplacingMatches(in: s,
                                 range: NSRange(s.startIndex..., in: s),
                                 withTemplate: template)
    }
}
```

移植要点（与 Java 行为对齐，执行时不得偏离）：

- 长度口径用 `utf16.count`（Java `String.length()` 是 UTF-16 code units）。
- `javaTrim` 复刻 Java `String.trim()`：只去除首尾 `U+0020` 及以下（`\u{0000}…\u{0020}`）的标量；**不使用** Swift `trimmingCharacters`（其空白集合不同）。
- `resolveInRoot` 用 `standardizedFileURL.resolvingSymlinksInPath()` 对应 Java `getCanonicalFile()`；边界判定用 `c == r || c.hasPrefix(r + "/")`，对应 Java 的 `File.separator`（iOS 上即 `/`）。
- 正则全部静态预编译，模式串与 `PathGuard.java` 逐字相同（`\u{00}-\u{1f}` 在 Swift 字符串内即以真实控制字符嵌入，等价 Java 的 `\u0000-\u001f`）。

- [ ] **5.4 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`，PathGuardTests 全绿且既有测试不受影响。

- [ ] **5.5 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/PathGuard.swift Tests/DSHRemoteTests/PathGuardTests.swift
git commit -m "feat(pathguard): 一比一移植安卓 PathGuard 段名校验与逃逸防护"
```

---

## Task 6：WorkspaceStore —— 作品·文档·回收站全部文件操作

目标（蓝本 `Workspace.java`，一比一复刻）：在给定根目录内实现 list/read/write/create/rename/move/trash/restore/purge，返回键逐字相同；全部方法经同一把锁串行；2 MiB 上限；`.tmp-N` 临时文件 + 原子移动（失败回退替换）；读取去 BOM；mtime 为毫秒。

返回模型：Java `Map<String,Object>` → Swift `[String: Any]`，值仅用 `String`/`Int64`/`Bool`/`NSNull`/数组/字典（可直接 `JSONSerialization`）；Java 的 `null` 值用 `NSNull()`。键顺序在 JS 侧按键读取，无影响。

- [ ] **6.1 先写失败测试 `Tests/DSHRemoteTests/WorkspaceStoreTests.swift`（Red）**

新增文件，完整内容：

```swift
import XCTest
@testable import DSHRemote

final class WorkspaceStoreTests: XCTestCase {

    var root: URL!
    var ws: WorkspaceStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("WorkspaceTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        ws = WorkspaceStore(root: root)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        ws = nil
        root = nil
        try super.tearDownWithError()
    }

    func assertBad<T>(_ expression: @autoclosure () throws -> T,
                      _ fragment: String,
                   file: StaticString = #filePath,
                   line: UInt = #line) {
        XCTAssertThrowsError(try expression(), file: file, line: line) { err in
            let desc = (err as? LocalizedError)?.errorDescription ?? String(describing: err)
            XCTAssertTrue(desc.contains(fragment),
                          "预期错误信息含「\(fragment)」，实际：\(desc)",
                          file: file, line: line)
        }
    }

    @discardableResult
    func mkDoc(_ work: String, _ name: String, _ content: String = "") throws -> [String: Any] {
        try ws.createWork(work)
        return try ws.writeDoc(relPath: "\(work)/\(name)", content: content)
    }

    func works(_ r: [String: Any]) -> [[String: Any]] {
        (r["works"] as? [[String: Any]]) ?? []
    }

    func testEmptyWorkspace() throws {
        let r = try ws.listWorkspace()
        XCTAssertTrue((r["ok"] as? Bool) == true)
        XCTAssertEqual(r["root"] as? String, root.path)
        XCTAssertEqual(works(r).count, 0)
    }

    func testListIgnoresHiddenDotFilesAndTrashAndNonMd() throws {
        _ = try mkDoc("作品A", "a.md", "你好")
        FileManager.default.createFile(atPath: root.appendingPathComponent(".secret").path,
                                      contents: Data())
        FileManager.default.createFile(atPath: root.appendingPathComponent("loose.txt").path,
                                      contents: Data())
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(".hiddenDir"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(PathGuard.trashDir), withIntermediateDirectories: true)

        let r = try ws.listWorkspace()
        XCTAssertEqual(works(r).map { $0["name"] as? String }, ["作品A"])
        let docs = works(r)[0]["docs"] as? [[String: Any]]
        XCTAssertEqual(docs?.map { $0["name"] as? String }, ["a.md"])
        XCTAssertEqual(docs?[0]["relPath"] as? String, "作品A/a.md")
        XCTAssertTrue((docs?[0]["mtime"] as? NSNumber)?.int64Value ?? 0 > 0)

        FileManager.default.createFile(
            atPath: root.appendingPathComponent("作品A/note.txt").path, contents: Data())
        let r2 = try ws.listWorkspace()
        let docs2 = works(r2)[0]["docs"] as? [[String: Any]]
        XCTAssertEqual(docs2?.count, 1)
    }

    func testWriteThenRead() throws {
        _ = try mkDoc("作品A", "a.md", "正文内容")
        let r = try ws.readDoc(relPath: "作品A/a.md")
        XCTAssertTrue((r["ok"] as? Bool) == true)
        XCTAssertEqual(r["content"] as? String, "正文内容")
        XCTAssertTrue((r["mtime"] as? NSNumber)?.int64Value ?? 0 > 0)
    }

    func testWriteResultKeys() throws {
        try ws.createWork("作品A")
        let r = try ws.writeDoc(relPath: "作品A/a.md", content: "abc")
        XCTAssertTrue((r["ok"] as? Bool) == true)
        XCTAssertTrue((r["mtime"] as? NSNumber)?.int64Value ?? 0 > 0)
        XCTAssertEqual(r["bytes"] as? Int, 3)
    }

    func testWriteStripsBomOnReadButPreservesWrittenUtf8() throws {
        try ws.createWork("作品A")
        try ws.writeDoc(relPath: "作品A/a.md", content: "\u{FEFF}带BOM")
        let r = try ws.readDoc(relPath: "作品A/a.md")
        XCTAssertEqual(r["content"] as? String, "带BOM")
    }

    func testWriteOversizeRejected() throws {
        try ws.createWork("作品A")
        let big = String(repeating: "a", count: 2 * 1024 * 1024 + 1)
        assertBad(try ws.writeDoc(relPath: "作品A/a.md", content: big), "文档过大")
    }

    func testWriteNullContentAndBadExt() throws {
        try ws.createWork("作品A")
        assertBad(try ws.writeDoc(relPath: "作品A/a.md", content: nil as String?),
                  "内容必须是字符串")
        assertBad(try ws.writeDoc(relPath: "作品A/a.txt", content: "x"), "只允许 .md")
    }

    func testCreateWorkDuplicate() throws {
        _ = try ws.createWork("作品A")
        assertBad(try ws.createWork("作品A"), "已存在")
    }

    func testCreateDocEmptyFileAndDuplicate() throws {
        try ws.createWork("作品A")
        let r = try ws.createDoc(work: "作品A", name: "新文档")
        XCTAssertTrue((r["ok"] as? Bool) == true)
        XCTAssertEqual(r["relPath"] as? String, "作品A/新文档.md")
        let read = try ws.readDoc(relPath: "作品A/新文档.md")
        XCTAssertEqual(read["content"] as? String, "")
        assertBad(try ws.createDoc(work: "作品A", name: "新文档"), "已存在")
    }

    func testRenameWork() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let r = try ws.renameWork(oldName: "作品A", newName: "作品B")
        XCTAssertEqual(r["work"] as? String, "作品B")
        let same = try ws.renameWork(oldName: "作品B", newName: "作品B")
        XCTAssertEqual(same["work"] as? String, "作品B")
        XCTAssertNoThrow(try ws.readDoc(relPath: "作品B/a.md"))
        assertBad(try ws.renameWork(oldName: "作品B", newName: "作品C/.."), "禁用字符")
    }

    func testRenameDoc() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let r = try ws.renameDoc(work: "作品A", oldName: "a.md", newName: "b.md")
        XCTAssertEqual(r["relPath"] as? String, "作品A/b.md")
        let same = try ws.renameDoc(work: "作品A", oldName: "b.md", newName: "b.md")
        XCTAssertEqual(same["relPath"] as? String, "作品A/b.md")
        assertBad(try ws.renameDoc(work: "作品A", oldName: "b.txt", newName: "x.md"),
                  "只允许")
    }

    func testMoveDoc() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        try ws.createWork("作品B")
        let r = try ws.moveDoc(fromWork: "作品A", name: "a.md", toWork: "作品B")
        XCTAssertEqual(r["relPath"] as? String, "作品B/a.md")
        XCTAssertEqual(r["moved"] as? Bool, true)
        assertBad(try ws.readDoc(relPath: "作品A/a.md"), "不是文件")
        let back = try ws.moveDoc(fromWork: "作品B", name: "a.md", toWork: "作品B")
        XCTAssertEqual(back["moved"] as? Bool, false)
        assertBad(try ws.moveDoc(fromWork: "作品B", name: "missing.md", toWork: "作品A"),
                  "文档不存在")
    }

    func testTrashDocListRestore() throws {
        _ = try mkDoc("作品A", "日记.md", "x")
        let t = try ws.trashDoc(work: "作品A", name: "日记.md")
        XCTAssertTrue((t["ok"] as? Bool) == true)
        XCTAssertTrue((t["relPath"] as? String ?? "").hasPrefix("\(PathGuard.trashDir)/作品A/日记-"))

        let lr = try ws.listTrash()
        let items = (lr["items"] as? [[String: Any]]) ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0]["kind"] as? String, "doc")
        XCTAssertEqual(items[0]["name"] as? String, "日记.md")
        XCTAssertEqual(items[0]["work"] as? String, "作品A")
        XCTAssertTrue(items[0]["trashName"] as? String ?? "" ~= #"^日记-\d{8}-\d{6}\.md$"#)
        XCTAssertEqual(items[0]["relPath"] as? String, t["relPath"] as? String)

        let restored = try ws.restoreTrash(relPath: t["relPath"] as! String)
        XCTAssertEqual(restored["kind"] as? String, "doc")
        XCTAssertEqual(restored["relPath"] as? String, "作品A/日记.md")
        XCTAssertNoThrow(try ws.readDoc(relPath: "作品A/日记.md"))
    }

    func testTrashWorkListRestore() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let t = try ws.trashWork(name: "作品A")
        let lr = try ws.listTrash()
        let items = (lr["items"] as? [[String: Any]]) ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0]["kind"] as? String, "work")
        XCTAssertEqual(items[0]["name"] as? String, "作品A")
        XCTAssertEqual(items[0]["work"] as? NSNull, NSNull())

        let restored = try ws.restoreTrash(relPath: t["relPath"] as! String)
        XCTAssertEqual(restored["kind"] as? String, "work")
        XCTAssertEqual(restored["work"] as? String, "作品A")
        XCTAssertNoThrow(try ws.readDoc(relPath: "作品A/a.md"))
    }

    func testListTrashSortedByMtimeDesc() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        _ = try ws.trashDoc(work: "作品A", name: "a.md")
        Thread.sleep(forTimeInterval: 0.02)
        _ = try mkDoc("作品A", "b.md", "y")
        _ = try ws.trashDoc(work: "作品A", name: "b.md")
        let items = (try ws.listTrash())["items"] as? [[String: Any]]
        XCTAssertEqual(items?.map { $0["name"] as? String }, ["b.md", "a.md"])
    }

    func testRestoreErrors() throws {
        assertBad(try ws.restoreTrash(relPath: "作品A/a.md"), "回收站条目不存在")
        _ = try mkDoc("作品A", "a.md", "x")
        assertBad(try ws.restoreTrash(relPath: "作品A/a.md"), "不是回收站内的条目")
    }

    func testRestoreWorkConflict() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let t = try ws.trashWork(name: "作品A")
        _ = try ws.createWork("作品A")
        assertBad(try ws.restoreTrash(relPath: t["relPath"] as! String), "无法恢复")
    }

    func testPurgeTrash() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let t = try ws.trashDoc(work: "作品A", name: "a.md")
        let rel = t["relPath"] as! String
        let p = try ws.purgeTrash(relPath: rel)
        XCTAssertEqual(p["relPath"] as? String, rel)
        XCTAssertTrue(((try ws.listTrash())["items"] as? [[String: Any]])?.isEmpty ?? true)
        assertBad(try ws.purgeTrash(relPath: rel), "回收站条目不存在")
        assertBad(try ws.purgeTrash(relPath: "作品A/a.md"), "只能彻底删除")
    }

    func testReadMissingIsNotFile() throws {
        try ws.createWork("作品A")
        assertBad(try ws.readDoc(relPath: "作品A/missing.md"), "不是文件")
    }
}
```

> **主控裁决（Task 13.3 第三次 CI，2026-10-11）**：上方 testPurgeTrash 末段的 `XCTAssertEqual((try ws.listTrash())["items"] as? [[String: Any]], [])` 与 7.6 OutboxStoreTests 是**围栏原样同款缺陷**——`[[String: Any]]?` 的元素含 `Any`，不满足 `Equatable`，与 `[]` 比较必报 `type 'Any' cannot conform to 'Equatable'`。该测试方法在第三轮 CI 因错误分批短路尚未编译到，属主动扫雷发现（Grep `as? [[String` 全 Tests 扩排 16 处，仅此一处断言违规，其余为赋值/`.count`/`.map { $0[...] as? String }` 均合法）。双侧同步改为 `XCTAssertTrue(((try ws.listTrash())["items"] as? [[String: Any]])?.isEmpty ?? true)`，nil 时按空列表处理（仅出现在 JSON 结构损坏的不可能路径），语义等价。

- [ ] **6.2 运行模拟器测试，验证失败（Red）**

执行「模拟器测试命令」。预期编译失败：`error: cannot find 'WorkspaceStore' in scope`。即 Red，进入实现。

- [ ] **6.3 新增 `Sources/WorkspaceStore.swift`（完整实现）**

新增文件，完整内容：

```swift
import Foundation

final class WorkspaceStore {
    static let maxDocBytes = 2 * 1024 * 1024

    private let root: URL
    private let lock = NSLock()
    private var tmpSeq: Int64 = 0

    private let mdEndCaseInsensitive = try! NSRegularExpression(
        pattern: "\\.[mM][dD]$")

    init(root: URL) {
        self.root = root
    }

    func listWorkspace() throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        var works: [[String: Any]] = []
        let entries = (try? FileManager.default.contentsOfDirectory(at: realRoot,
                                                                    includingPropertiesForKeys: nil)) ?? []
        for ent in entries {
            let name = ent.lastPathComponent
            if name.hasPrefix(".") { continue }
            if name == PathGuard.trashDir { continue }
            let isDir = directoryFlag(ent)
            guard isDir else { continue }
            var docs: [[String: Any]] = []
            let files = (try? FileManager.default.contentsOfDirectory(at: ent,
                                                                      includingPropertiesForKeys: nil)) ?? []
            for f in files {
                let fname = f.lastPathComponent
                guard !directoryFlag(f), !fname.hasPrefix("."),
                      PathGuard.hasMdExt(fname) else { continue }
                docs.append([
                    "name": fname,
                    "relPath": name + "/" + fname,
                    "mtime": mtimeMillis(f)
                ])
            }
            sortByName(&docs)
            works.append(["name": name, "docs": docs])
        }
        sortByName(&works)
        return ["ok": true, "root": realRoot.path, "works": works]
    }

    func readDoc(relPath: String) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = try resolve(realRoot, relPath)
        guard !directoryFlag(abs) else { throw PathGuard.bad("不是文件: \(relPath)") }
        let content = try readText(abs)
        return ["ok": true, "content": content, "mtime": mtimeMillis(abs)]
    }

    func writeDoc(relPath: String, content: String?) throws -> [String: Any] {
        guard let content = content else { throw PathGuard.bad("内容必须是字符串") }
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        try PathGuard.assertMd(relPath)
        let abs = try resolve(realRoot, relPath)
        let data = Data(content.utf8)
        if data.count > Self.maxDocBytes {
            throw PathGuard.bad("文档过大（> 2 MiB）: \(relPath)")
        }
        try mkdir(abs.deletingLastPathComponent())
        try atomicWrite(abs, data)
        return ["ok": true, "mtime": mtimeMillis(abs), "bytes": data.count]
    }

    func createWork(_ name: String) throws -> [String: Any] {
        try PathGuard.validateSegment(name)
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = realRoot.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: abs.path) {
            throw PathGuard.bad("已存在: \(name)")
        }
        try mkdir(abs)
        return ["ok": true, "work": name]
    }

    func createDoc(work: String, name: String?) throws -> [String: Any] {
        try PathGuard.validateSegment(work)
        let docName = try PathGuard.validateSegment(PathGuard.ensureMd(name))
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = try resolve(realRoot, work + "/" + docName)
        if FileManager.default.fileExists(atPath: abs.path) {
            throw PathGuard.bad("已存在: \(work)/\(docName)")
        }
        try mkdir(abs.deletingLastPathComponent())
        try atomicWrite(abs, Data())
        return ["ok": true, "relPath": work + "/" + docName]
    }

    func renameWork(oldName: String, newName: String) throws -> [String: Any] {
        try PathGuard.validateSegment(oldName)
        try PathGuard.validateSegment(newName)
        lock.lock()
        defer { lock.unlock() }
        if oldName == newName { return ok("work", oldName) }
        let realRoot = try ensureRoot()
        let from = try resolve(realRoot, oldName)
        guard directoryFlag(from) else { throw PathGuard.bad("不是作品目录: \(oldName)") }
        let to = try resolve(realRoot, newName)
        if FileManager.default.fileExists(atPath: to.path) {
            throw PathGuard.bad("已存在同名作品: \(newName)")
        }
        try rename(from, to)
        return ok("work", newName)
    }

    func renameDoc(work: String, oldName: String, newName: String?) throws -> [String: Any] {
        try PathGuard.validateSegment(work)
        let to = try PathGuard.validateSegment(PathGuard.ensureMd(newName))
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let fromName = try PathGuard.assertMd(work + "/" + oldName)
        if fromName == to { return ok("relPath", work + "/" + to) }
        let fromAbs = try resolve(realRoot, work + "/" + fromName)
        guard !directoryFlag(fromAbs) else {
            throw PathGuard.bad("文档不存在: \(work)/\(fromName)")
        }
        let toAbs = try resolve(realRoot, work + "/" + to)
        if FileManager.default.fileExists(atPath: toAbs.path) {
            throw PathGuard.bad("已存在同名文档: \(to)")
        }
        try rename(fromAbs, toAbs)
        return ok("relPath", work + "/" + to)
    }

    func moveDoc(fromWork: String, name: String, toWork: String) throws -> [String: Any] {
        try PathGuard.validateSegment(fromWork)
        try PathGuard.validateSegment(toWork)
        let doc = try PathGuard.assertMd(fromWork + "/" + name)
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        if fromWork == toWork {
            var r = ok("relPath", toWork + "/" + doc)
            r["moved"] = false
            return r
        }
        let fromAbs = try resolve(realRoot, fromWork + "/" + doc)
        guard !directoryFlag(fromAbs) else {
            throw PathGuard.bad("文档不存在: \(fromWork)/\(doc)")
        }
        let toAbs = try resolve(realRoot, toWork + "/" + doc)
        if FileManager.default.fileExists(atPath: toAbs.path) {
            throw PathGuard.bad("目标作品里已有同名文档: \(doc)")
        }
        try mkdir(toAbs.deletingLastPathComponent())
        try rename(fromAbs, toAbs)
        var r = ok("relPath", toWork + "/" + doc)
        r["moved"] = true
        return r
    }

    func trashDoc(work: String, name: String) throws -> [String: Any] {
        try PathGuard.validateSegment(work)
        let doc = try PathGuard.assertMd(work + "/" + name)
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let fromAbs = try resolve(realRoot, work + "/" + doc)
        guard !directoryFlag(fromAbs) else {
            throw PathGuard.bad("文档不存在: \(work)/\(doc)")
        }
        let trashDir = realRoot.appendingPathComponent(PathGuard.trashDir)
            .appendingPathComponent(work)
        let stem = mdEndCaseInsensitive.replaceAll(in: doc)
        let initial = trashDir.appendingPathComponent(
            stem + "-" + PathGuard.trashStampNow() + ".md")
        let target = try PathGuard.uniquePath(initial, isDir: false)
        try mkdir(target.deletingLastPathComponent())
        try rename(fromAbs, target)
        return ok("relPath", relOf(realRoot, target))
    }

    func trashWork(name: String) throws -> [String: Any] {
        try PathGuard.validateSegment(name)
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let fromAbs = try resolve(realRoot, name)
        guard directoryFlag(fromAbs) else { throw PathGuard.bad("不是作品目录: \(name)") }
        let trashBase = realRoot.appendingPathComponent(PathGuard.trashDir)
            .appendingPathComponent(PathGuard.workTrashSub)
        let initial = trashBase.appendingPathComponent(
            name + "-" + PathGuard.trashStampNow())
        let target = try PathGuard.uniquePath(initial, isDir: true)
        try mkdir(target.deletingLastPathComponent())
        try rename(fromAbs, target)
        return ok("relPath", relOf(realRoot, target))
    }

    func listTrash() throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        var items: [[String: Any]] = []
        let base = realRoot.appendingPathComponent(PathGuard.trashDir)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: base.path, isDirectory: &isDir),
              isDir.boolValue else {
            return trashResult(realRoot, items)
        }
        let tops = (try? FileManager.default.contentsOfDirectory(at: base,
                                                                 includingPropertiesForKeys: nil)) ?? []
        for ent in tops {
            let topName = ent.lastPathComponent
            guard directoryFlag(ent), !topName.hasPrefix(".") else { continue }
            if topName == PathGuard.workTrashSub {
                let subs = (try? FileManager.default.contentsOfDirectory(at: ent,
                                                                         includingPropertiesForKeys: nil)) ?? []
                for s in subs {
                    guard directoryFlag(s), !s.lastPathComponent.hasPrefix(".") else { continue }
                    items.append([
                        "kind": "work",
                        "name": PathGuard.stripTrashStamp(s.lastPathComponent),
                        "trashName": s.lastPathComponent,
                        "work": NSNull(),
                        "relPath": relOf(realRoot, s),
                        "mtime": mtimeMillis(s)
                    ])
                }
                continue
            }
            let files = (try? FileManager.default.contentsOfDirectory(at: ent,
                                                                      includingPropertiesForKeys: nil)) ?? []
            for f in files {
                let fname = f.lastPathComponent
                guard !directoryFlag(f), !fname.hasPrefix("."),
                      PathGuard.hasMdExt(fname) else { continue }
                let stem = PathGuard.stripTrashStamp(mdEndCaseInsensitive.replaceAll(in: fname))
                items.append([
                    "kind": "doc",
                    "name": stem + ".md",
                    "trashName": fname,
                    "work": topName,
                    "relPath": relOf(realRoot, f),
                    "mtime": mtimeMillis(f)
                ])
            }
        }
        items.sort { ln($0["mtime"]) > ln($1["mtime"]) }
        return trashResult(realRoot, items)
    }

    func restoreTrash(relPath: String) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = try resolve(realRoot, relPath)
        guard FileManager.default.fileExists(atPath: abs.path) else {
            throw PathGuard.bad("回收站条目不存在: \(relPath)")
        }
        let segs = try PathGuard.splitRel(relOf(realRoot, abs))
        guard segs[0] == PathGuard.trashDir, segs.count >= 3 else {
            throw PathGuard.bad("不是回收站内的条目: \(relPath)")
        }
        if segs[1] == PathGuard.workTrashSub {
            guard directoryFlag(abs) else {
                throw PathGuard.bad("回收站条目类型不符: \(relPath)")
            }
            let name = PathGuard.stripTrashStamp(segs[2])
            if name.isEmpty || name == segs[2] {
                throw PathGuard.bad("条目名没有软删时间戳，无法还原原名: \(segs[2])")
            }
            try PathGuard.validateSegment(name)
            let toAbs = try resolve(realRoot, name)
            if FileManager.default.fileExists(atPath: toAbs.path) {
                throw PathGuard.bad("已存在同名作品，无法恢复: \(name)")
            }
            try rename(abs, toAbs)
            return ["ok": true, "kind": "work", "work": name]
        }
        guard !directoryFlag(abs) else {
            throw PathGuard.bad("回收站条目类型不符: \(relPath)")
        }
        let work = segs[1]
        try PathGuard.validateSegment(work)
        let stem = PathGuard.stripTrashStamp(mdEndCaseInsensitive.replaceAll(in: segs[2]))
        if stem.isEmpty {
            throw PathGuard.bad("条目名没有软删时间戳，无法还原原名: \(segs[2])")
        }
        let docName = stem + ".md"
        try PathGuard.validateSegment(docName)
        let toAbs = try resolve(realRoot, work + "/" + docName)
        if FileManager.default.fileExists(atPath: toAbs.path) {
            throw PathGuard.bad("原位置已有同名文档，无法恢复: \(work)/\(docName)")
        }
        try mkdir(toAbs.deletingLastPathComponent())
        try rename(abs, toAbs)
        return ["ok": true, "kind": "doc", "relPath": work + "/" + docName]
    }

    func purgeTrash(relPath: String) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = try resolve(realRoot, relPath)
        let rel = relOf(realRoot, abs)
        let segs = try PathGuard.splitRel(rel)
        guard segs[0] == PathGuard.trashDir, segs.count >= 2 else {
            throw PathGuard.bad("只能彻底删除回收站内的条目: \(relPath)")
        }
        guard FileManager.default.fileExists(atPath: abs.path) else {
            throw PathGuard.bad("回收站条目不存在: \(relPath)")
        }
        do {
            try FileManager.default.removeItem(at: abs)
        } catch {
            throw PathGuard.bad("彻底删除失败: \(error.localizedDescription)")
        }
        return ok("relPath", rel)
    }

    private func ensureRoot() throws -> URL {
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: root.path, isDirectory: &isDir)
        if !exists {
            do {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("工作区根无法创建: \(root.path)")
            }
        } else if !isDir.boolValue {
            throw PathGuard.bad("工作区根不是目录: \(root.path)")
        }
        return root.standardizedFileURL.resolvingSymlinksInPath()
    }

    private func resolve(_ realRoot: URL, _ relPath: String) throws -> URL {
        do {
            return try PathGuard.resolveInRoot(root: realRoot, relPath: relPath)
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            throw PathGuard.bad("路径解析失败: \(msg)")
        }
    }

    private func mkdir(_ d: URL) throws {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: d.path, isDirectory: &isDir) { return }
        do {
            try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        } catch {
            throw PathGuard.bad("无法创建目录: \(d.path)")
        }
    }

    private func atomicWrite(_ abs: URL, _ data: Data) throws {
        tmpSeq += 1
        let tmp = abs.deletingLastPathComponent()
            .appendingPathComponent(abs.lastPathComponent + ".tmp-\(tmpSeq)")
        do {
            try data.write(to: tmp, options: .atomic)
            try move(tmp, abs)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw PathGuard.bad("写入失败: \(error.localizedDescription)")
        }
    }

    private func move(_ src: URL, _ dst: URL) throws {
        do {
            if FileManager.default.fileExists(atPath: dst.path) {
                try FileManager.default.removeItem(at: dst)
            }
            try FileManager.default.moveItem(at: src, to: dst)
        } catch {
            do {
                let bytes = try Data(contentsOf: src)
                try bytes.write(to: dst, options: .atomic)
                try FileManager.default.removeItem(at: src)
            } catch {
                throw PathGuard.bad("写入失败: \(error.localizedDescription)")
            }
        }
    }

    private func rename(_ src: URL, _ dst: URL) throws {
        do {
            try move(src, dst)
        } catch {
            throw PathGuard.bad("重命名失败: \(error.localizedDescription)")
        }
    }

    private func readText(_ abs: URL) throws -> String {
        let raw: Data
        do {
            raw = try Data(contentsOf: abs)
        } catch {
            throw PathGuard.bad("读取失败: \(error.localizedDescription)")
        }
        var s = String(decoding: raw, as: UTF8.self)
        if s.first == "\u{FEFF}" { s.removeFirst() }
        return s
    }

    private func relOf(_ realRoot: URL, _ abs: URL) -> String {
        let base = realRoot.standardizedFileURL.path
        var target = abs.standardizedFileURL.path
        if target.hasPrefix(base) {
            target.removeFirst(base.count)
            if target.hasPrefix("/") { target.removeFirst() }
        }
        return target
    }

    private func trashResult(_ realRoot: URL, _ items: [[String: Any]]) -> [String: Any] {
        ["ok": true, "root": realRoot.path, "items": items]
    }

    private func ok(_ key: String, _ value: Any) -> [String: Any] {
        ["ok": true, key: value]
    }

    private func sortByName(_ list: inout [[String: Any]]) {
        list.sort { str($0["name"]) < str($1["name"]) }
    }

    private func str(_ o: Any?) -> String {
        if let s = o as? String { return s }
        return o.map { String(describing: $0) } ?? ""
    }

    private func ln(_ o: Any?) -> Int64 {
        (o as? NSNumber)?.int64Value ?? 0
    }

    private func mtimeMillis(_ u: URL) -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: u.path),
              let date = attrs[.modificationDate] as? Date else { return 0 }
        return Int64((date.timeIntervalSince1970 * 1000.0).rounded())
    }

    private func directoryFlag(_ u: URL) -> Bool {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir) {
            return isDir.boolValue
        }
        return false
    }
}

private extension NSRegularExpression {
    func replaceAll(in s: String, template: String = "") -> String {
        stringByReplacingMatches(in: s,
                                 range: NSRange(s.startIndex..., in: s),
                                 withTemplate: template)
    }
}
```

移植要点（执行时不得偏离）：

- `mtimeMillis` 对应 Java `File.lastModified()`（epoch 毫秒，Int64）。
- `atomicWrite` 临时名 `<name>.tmp-N`，写入后 `move`；`move` 先尝试移动（目标存在先删），失败（如跨卷）回退“读出字节 → atomic 写目标 → 删源”，对应 Java `ATOMIC_MOVE` 失败回退 `REPLACE_EXISTING`。
- 读取去 BOM：首个字符为 `U+FEFF` 则移除（对应 Java `startsWith("\uFEFF")`）。
- 隐藏判定只看段名是否以 `.` 开头（Unix 下 `isHidden` 的实际语义即点前缀，与 `name.startsWith(".")` 合并等价）。
- `relOf` 以根路径为前缀做字符串相对化，结果只用 `/`。

- [ ] **6.4 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`，WorkspaceStoreTests 全绿且既有测试不受影响。

- [ ] **6.5 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/WorkspaceStore.swift Tests/DSHRemoteTests/WorkspaceStoreTests.swift
git commit -m "feat(workspace): 一比一移植安卓 Workspace 作品文档与回收站操作"
```

---

## Task 7：AppDataStore + OutboxStore —— 配置/草稿/校对/基线/会话与发件箱

目标（蓝本 `AppData.java` 1045 行、`OutboxStore.java` 153 行，一比一复刻）：

- `AppDataStore`：`config.json` 全分支 merge + clamp（番茄钟/UI/校对/send 意图/autosave/drafts/theme/general/editor/preview/remote/writingPrefs）、`drafts/` 草稿读写与剪枝、`proofread/` 校对缓存（500 截断写 / 200 个剪枝）、`sync/baseline.json` 宽容读写、`last-session.json` 宽容读写、SHA-1/`hash12`/`draftKey`/`proofCacheKey`。
- `OutboxStore`：根级 `outbox.json` 去重入队 / 移除 / 列表 / 按作品计数，normalize 逐段校验，固定临时名 `outbox.json.tmp`。
- **iOS 差异（已锁定，不得偏离）**：
  - `settings.remote.gateway` 非法/缺省时回落为**空串 `""`**（安卓回落 `DEFAULT_GATEWAY`，**禁止**复制其个人网关 `http://100.99.84.35:8080`）；`proofread.sessionId` 非法/缺省同样回落 **`""`**（**禁止**复制 `DEFAULT_PROOF_SESSION`）。
  - **不移植** `getDeviceId`、写作提醒查询（`writingReminderActive/Time`）；`normalizeWritingPrefs` 仍保留（配置保存/状态需要）。
  - `AppDataStore` **不组合** `OutboxStore`（安卓构造器里持有，iOS 组合点改在 Task 8 的 `BridgeDispatcher`：`writeDoc` 成功后内部入队）。因此不实现 `outboxAdd/Remove/List/CountByDoc` 四个委托方法。
- 错误语义与 `AppData.java` 一致：**业务方法不抛异常**，所有失败返回 `fail` map（`["ok": false, "error": msg]`）；`hash12`/`proofCacheKey(for:)` 为无磁盘纯函数，对外 `static`。仅底层 IO 工具在内部以 `throw` 传播并被各业务方法 `catch` 转成 fail。
- 数值全部以 `Int64`/`Double` 承载；`Double.nan`/非有限数判法对应 Java `Double.isFinite`。

- [ ] **7.1 先写失败测试 `Tests/DSHRemoteTests/AppDataStoreTests.swift`（Red）**

新增文件，完整内容：

```swift
import XCTest
@testable import DSHRemote

final class AppDataStoreTests: XCTestCase {

    var dir: URL!
    var data: AppDataStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("AppDataTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        data = AppDataStore(dataDir: dir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        data = nil
        dir = nil
        try super.tearDownWithError()
    }

    // MARK: - 读取工具

    func dict(_ r: [String: Any], _ key: String) -> [String: Any] {
        (r[key] as? [String: Any]) ?? [:]
    }

    func arr(_ r: [String: Any], _ key: String) -> [Any] {
        (r[key] as? [Any]) ?? []
    }

    @discardableResult
    func save(_ patch: [String: Any]) -> [String: Any] {
        let r = data.saveConfig(patch)
        XCTAssertTrue((r["ok"] as? Bool) == true, "saveConfig 失败：\(r["error"] ?? "")")
        return r
    }

    func writeRawConfig(_ text: String) {
        let f = dir.appendingPathComponent("config.json")
        try? text.data(using: .utf8)!.write(to: f)
    }

    // MARK: - getState 默认值（iOS 个人常量缺省为空串）

    func testGetStateDefaults() {
        let s = data.getState()
        XCTAssertTrue((s["ok"] as? Bool) == true)
        XCTAssertTrue(s["root"] is NSNull)
        XCTAssertFalse((s["rootExists"] as? Bool) == true)
        XCTAssertEqual(s["draftsDir"] as? String, dir.appendingPathComponent("drafts").path)

        let pomo = dict(s, "pomodoro")
        XCTAssertEqual(pomo["focusMin"] as? Int64, 25)
        XCTAssertEqual(pomo["breakMin"] as? Int64, 5)
        XCTAssertEqual(pomo["autoNext"] as? Bool, true)

        let settings = dict(s, "settings")
        XCTAssertEqual(dict(settings, "autosave")["debounceMs"] as? Int64, 1000)
        let d = dict(settings, "drafts")
        XCTAssertEqual(d["maxFiles"] as? Int64, 200)
        XCTAssertEqual(d["maxBytes"] as? Int64, 5 * 1024 * 1024)
        XCTAssertEqual(d["maxTotalBytes"] as? Int64, 128 * 1024 * 1024)
        XCTAssertEqual(d["notifyOnStartup"] as? Bool, true)
        XCTAssertEqual(settings["theme"] as? String, "auto")
        XCTAssertEqual(dict(settings, "general")["autoStart"] as? Bool, false)
        XCTAssertEqual(dict(settings, "general")["tray"] as? Bool, true)
        XCTAssertEqual(arr(dict(settings, "send"), "intents") as? [String],
                       ["错字/病句检查", "结构诊断", "续写"])
        let remote = dict(settings, "remote")
        XCTAssertEqual(remote["mode"] as? String, "auto")
        XCTAssertEqual(remote["gateway"] as? String, "")
        XCTAssertEqual(remote["port"] as? Int64, 18080)

        XCTAssertEqual(dict(s, "proofread")["sessionId"] as? String, "")
        let wp = dict(s, "writingPrefs")
        XCTAssertEqual(wp["dailyGoal"] as? Int64, 1000)
        XCTAssertEqual(wp["reminderEnabled"] as? Bool, true)
        XCTAssertEqual(wp["reminderTime"] as? String, "20:00")
    }

    func testGetStateWithWorkspaceRoot() {
        writeRawConfig("{\"workspaceRoot\":" + jsonString(dir.path) + "}")
        let s = data.getState()
        XCTAssertEqual(s["root"] as? String, dir.path)
        XCTAssertEqual(s["rootExists"] as? Bool, true)
    }

    func jsonString(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
        let arr = String(decoding: data, as: UTF8.self)
        return String(arr.dropFirst().dropLast())
    }

    // MARK: - saveConfig：未知键/番茄钟/草稿/autosave/theme/general

    func testSaveConfigIgnoresUnknownKeys() {
        let r = data.saveConfig(["unknownTopLevel": ["nested": 1]])
        XCTAssertTrue((r["ok"] as? Bool) == true)
        let raw = (try? String(contentsOf: dir.appendingPathComponent("config.json"),
                               encoding: .utf8)) ?? ""
        XCTAssertFalse(raw.contains("unknownTopLevel"), "未知顶层键必须丢弃，不落盘")
    }

    func testSavePomodoroClamps() {
        save(["pomodoro": ["focusMin": 0, "breakMin": 999, "autoNext": false, "junk": 1]])
        let pomo = dict(data.getState(), "pomodoro")
        XCTAssertEqual(pomo["focusMin"] as? Int64, 1)
        XCTAssertEqual(pomo["breakMin"] as? Int64, 60)
        XCTAssertEqual(pomo["autoNext"] as? Bool, false)
        save(["pomodoro": ["focusMin": 999, "breakMin": -3]])
        let p2 = dict(data.getState(), "pomodoro")
        XCTAssertEqual(p2["focusMin"] as? Int64, 180)
        XCTAssertEqual(p2["breakMin"] as? Int64, 1)
        XCTAssertEqual(p2["autoNext"] as? Bool, false, "未提供的键沿用上次合并值")
    }

    func testSaveDraftsClampsAndNotifyDefault() {
        save(["drafts": ["maxFiles": 0, "maxBytes": 10, "maxTotalBytes": 10,
                         "notifyOnStartup": false]])
        let d = dict(dict(data.getState(), "settings"), "drafts")
        XCTAssertEqual(d["maxFiles"] as? Int64, 1)
        XCTAssertEqual(d["maxBytes"] as? Int64, 1024)
        XCTAssertEqual(d["maxTotalBytes"] as? Int64, 1024 * 1024)
        XCTAssertEqual(d["notifyOnStartup"] as? Bool, false)

        save(["drafts": ["maxFiles": 99999, "maxTotalBytes": "x"]])
        let d2 = dict(dict(data.getState(), "settings"), "drafts")
        XCTAssertEqual(d2["maxFiles"] as? Int64, 10000)
        XCTAssertEqual(d2["maxTotalBytes"] as? Int64, 1024 * 1024,
                       "非法值回落为该字段缺省，而非旧值")
        XCTAssertEqual(d2["notifyOnStartup"] as? Bool, false, "未提供则沿用旧值")
    }

    func testSaveAutosaveThemeGeneral() {
        save(["autosave": ["debounceMs": 50],
              "theme": "dark",
              "general": ["autoStart": true, "tray": false]])
        let settings = dict(data.getState(), "settings")
        XCTAssertEqual(dict(settings, "autosave")["debounceMs"] as? Int64, 200)
        XCTAssertEqual(settings["theme"] as? String, "dark")
        XCTAssertEqual(dict(settings, "general")["autoStart"] as? Bool, true)
        XCTAssertEqual(dict(settings, "general")["tray"] as? Bool, false)

        save(["autosave": ["debounceMs": 20000], "theme": "neon", "general": [:]])
        let s2 = dict(data.getState(), "settings")
        XCTAssertEqual(dict(s2, "autosave")["debounceMs"] as? Int64, 10000)
        XCTAssertEqual(s2["theme"] as? String, "auto")
        XCTAssertEqual(dict(s2, "general")["autoStart"] as? Bool, false)
        XCTAssertEqual(dict(s2, "general")["tray"] as? Bool, true)
    }

    // MARK: - saveConfig：remote（gateway 失败立即返回且不写盘）

    func testSaveRemoteModePort() {
        save(["remote": ["mode": "manual", "port": 80]])
        let r = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(r["mode"] as? String, "manual")
        XCTAssertEqual(r["port"] as? Int64, 1024)
        save(["remote": ["mode": "weird", "port": 70000]])
        let r2 = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(r2["mode"] as? String, "auto")
        XCTAssertEqual(r2["port"] as? Int64, 65535)
    }

    func testSaveGatewayValidTrimsAndPersists() {
        let r = save(["remote": ["gateway": "  https://example.com:9000/x  "]])
        let remote = dict(r, "settings")
        _ = remote
        let onDisk = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(onDisk["gateway"] as? String, "https://example.com:9000/x")
    }

    func testSaveGatewayInvalidFailsAndDoesNotWrite() {
        save(["theme": "dark"])
        let before = (try? String(contentsOf: dir.appendingPathComponent("config.json"),
                                  encoding: .utf8)) ?? ""
        let r = data.saveConfig(["remote": ["gateway": "ftp://nope"]])
        XCTAssertFalse((r["ok"] as? Bool) == true)
        XCTAssertTrue((r["error"] as? String ?? "").contains("gateway"))
        let after = (try? String(contentsOf: dir.appendingPathComponent("config.json"),
                                 encoding: .utf8)) ?? ""
        XCTAssertEqual(before, after, "gateway 非法时不得写盘")
        XCTAssertEqual(dict(dict(data.getState(), "settings"), "remote")["gateway"] as? String, "")
    }

    func testSettingsGatewayFallsBackToEmptyWhenConfigMalformed() {
        writeRawConfig("{\"remote\":{\"gateway\":\"not-a-url\"}}")
        XCTAssertEqual(dict(dict(data.getState(), "settings"), "remote")["gateway"] as? String, "")
    }

    // MARK: - saveConfig：proofread / writingPrefs / ui / intents / editor / preview

    func testSaveProofreadSessionValidation() {
        save(["proofread": ["sessionId": "session-abc123"]])
        XCTAssertEqual(dict(data.getState(), "proofread")["sessionId"] as? String,
                       "session-abc123")
        save(["proofread": ["sessionId": "nope"]])
        XCTAssertEqual(dict(data.getState(), "proofread")["sessionId"] as? String, "")
    }

    func testSaveWritingPrefs() {
        save(["writingPrefs": ["dailyGoal": 200000, "reminderEnabled": false,
                               "reminderTime": "09:05"]])
        let wp = dict(data.getState(), "writingPrefs")
        XCTAssertEqual(wp["dailyGoal"] as? Int64, 100000)
        XCTAssertEqual(wp["reminderEnabled"] as? Bool, false)
        XCTAssertEqual(wp["reminderTime"] as? String, "09:05")

        save(["writingPrefs": ["dailyGoal": -5, "reminderTime": "99:99"]])
        let wp2 = dict(data.getState(), "writingPrefs")
        XCTAssertEqual(wp2["dailyGoal"] as? Int64, 0)
        XCTAssertEqual(wp2["reminderTime"] as? String, "09:05", "非法时间不覆盖旧值")
        XCTAssertEqual(wp2["reminderEnabled"] as? Bool, false, "未提供沿用旧值")
    }

    func testSaveUISplitDeepMerge() {
        save(["ui": ["split": ["ratio": 0.25, "on": true], "custom": 7]])
        save(["ui": ["split": ["ratio": 0.95]]])
        let ui = dict(data.getState(), "ui")
        let split = dict(ui, "split")
        XCTAssertEqual(split["ratio"] as? Double, 0.8)
        XCTAssertEqual(split["on"] as? Bool, true, "split 深合并保留 on")
        XCTAssertEqual(ui["custom"] as? Int64, 7, "ui 其余自定义键原样保留")
    }

    func testSaveIntentsNormalizeDedupeCap() {
        let r = save(["send": ["intents": [" A ", "A", "多\n行", "a\r\n\r\nb", String(repeating: "x", count: 50)]]])
        let intents = arr(dict(r, "settings"), "intents") as? [String] ?? []
        XCTAssertEqual(intents[0], "A")
        XCTAssertEqual(intents[1], "多 行")
        // Java replaceAll("[\\r\\n]+", " ")：连续换行只折叠成一个空格
        XCTAssertEqual(intents[2], "a b")
        XCTAssertEqual(intents[3].count, 40)
        XCTAssertEqual(intents.count, 4)

        let many = (0..<30).map { "意图\($0)" }
        let r2 = save(["send": ["intents": many]])
        XCTAssertEqual((arr(dict(r2, "settings"), "intents") as? [String])?.count, 20)
    }

    func testSaveEditorNormalization() {
        save(["editor": ["fontSize": 40, "fontFamily": "bogus", "lineHeight": 3,
                         "letterSpacing": 1, "measure": 9, "colorPreset": "sepia",
                         "extra": "keep"]])
        let e = dict(dict(data.getState(), "settings"), "editor")
        XCTAssertEqual(e["fontSize"] as? Int64, 32)
        XCTAssertEqual(e["fontFamily"] as? String, "kai")
        XCTAssertEqual(e["lineHeight"] as? Double, 2.4)
        XCTAssertEqual(e["letterSpacing"] as? Double, 0.1)
        XCTAssertEqual(e["measure"] as? Int64, 20)
        XCTAssertEqual(e["colorPreset"] as? String, "sepia")
        XCTAssertEqual(e["extra"] as? String, "keep")

        save(["editor": ["fontSize": 15.4]])
        XCTAssertEqual(dict(dict(data.getState(), "settings"), "editor")["fontSize"] as? Int64, 15)
        save(["editor": [:]])
        XCTAssertEqual(dict(dict(data.getState(), "settings"), "editor")["fontSize"] as? Int64, 0,
                       "非法/非正 fontSize 归一为 0")
    }

    func testSavePreviewNormalization() {
        save(["preview": ["fontSize": 12, "lineHeight": 1.8, "fontFamily": "serif",
                          "paraSpacing": 3, "indent": 9]])
        let p = dict(dict(data.getState(), "settings"), "preview")
        XCTAssertEqual(p["fontSize"] as? Int64, 12)
        XCTAssertEqual(p["lineHeight"] as? Double, 1.8)
        XCTAssertEqual(p["fontFamily"] as? String, "serif")
        XCTAssertEqual(p["paraSpacing"] as? Double, 2)
        XCTAssertEqual(p["indent"] as? Int64, 2)

        save(["preview": ["paraSpacing": "auto", "fontFamily": "nope"]])
        let p2 = dict(dict(data.getState(), "settings"), "preview")
        XCTAssertEqual(p2["paraSpacing"] as? String, "auto")
        XCTAssertEqual(p2["fontFamily"] as? String, "auto")
    }

    func testCorruptConfigFallsBackToEmpty() {
        writeRawConfig("{not json")
        let s = data.getState()
        XCTAssertTrue((s["ok"] as? Bool) == true)
        XCTAssertEqual(dict(s, "pomodoro")["focusMin"] as? Int64, 25)
    }
```

- [ ] **7.1（续）测试文件下半：草稿 / 校对 / 基线 / 会话 / 哈希**

```swift
    // MARK: - 草稿

    func testWriteReadClearDraft() {
        let w = data.writeDraft(root: dir.path, relPath: "作品A/文档一.md", content: "正文")
        XCTAssertTrue((w["ok"] as? Bool) == true)
        XCTAssertEqual(w["bytes"] as? Int64, 6)
        let key = w["key"] as? String
        XCTAssertEqual(key?.count, 24)

        let r = data.readDraft(root: dir.path, relPath: "作品A/文档一.md")
        XCTAssertEqual(r["content"] as? String, "正文")

        let cleared = data.clearDraft(root: dir.path, relPath: "作品A/文档一.md")
        XCTAssertEqual(cleared["cleared"] as? Int64, 2)
        let again = data.clearDraft(root: dir.path, relPath: "作品A/文档一.md")
        XCTAssertEqual(again["cleared"] as? Int64, 0)
    }

    func testWriteDraftRejectsOversize() {
        save(["drafts": ["maxBytes": 1024]])
        let big = String(repeating: "字", count: 2000)
        let r = data.writeDraft(root: dir.path, relPath: "w/big.md", content: big)
        XCTAssertFalse((r["ok"] as? Bool) == true)
        XCTAssertTrue((r["error"] as? String ?? "").contains("草稿过大"))
    }

    func testDraftsUsageCountsOnlyMd() throws {
        _ = data.writeDraft(root: dir.path, relPath: "a/x.md", content: "1234")
        let draftsDir = dir.appendingPathComponent("drafts")
        try "junk".data(using: .utf8)!.write(to: draftsDir.appendingPathComponent("note.txt"))
        let u = data.draftsUsage()
        XCTAssertEqual(u["files"] as? Int64, 1)
        XCTAssertEqual(u["bytes"] as? Int64, 4)
        XCTAssertEqual(u["limitFiles"] as? Int64, 200)
        XCTAssertEqual(u["limitBytes"] as? Int64, 128 * 1024 * 1024)
        XCTAssertEqual(u["dir"] as? String, draftsDir.path)
    }

    func testListPendingDraftsExpiresAgainstFormal() throws {
        _ = data.writeDraft(root: dir.path, relPath: "作品A/新.md", content: "草稿内容")
        let pending1 = data.listPendingDrafts(root: dir.path)
        XCTAssertEqual((arr(pending1, "drafts") as? [[String: Any]])?.count, 1)
        let entry = (arr(pending1, "drafts") as? [[String: Any]])?[0]
        XCTAssertEqual(entry?["relPath"] as? String, "作品A/新.md")
        XCTAssertEqual(entry?["work"] as? String, "作品A")
        XCTAssertEqual(entry?["name"] as? String, "新.md")
        XCTAssertEqual(entry?["formalExists"] as? Bool, false)

        let formal = dir.appendingPathComponent("作品A/新.md")
        try FileManager.default.createDirectory(at: formal.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try "更新的正式".data(using: .utf8)!.write(to: formal)
        Thread.sleep(forTimeInterval: 0.02)
        let formalMtime = Int64((try FileManager.default.attributesOfItem(atPath: formal.path)[
            .modificationDate] as! Date).timeIntervalSince1970 * 1000)

        let pending2 = data.listPendingDrafts(root: dir.path)
        XCTAssertEqual((arr(pending2, "drafts") as? [[String: Any]])?.count, 0,
                       "正式文档不旧时草稿应过期清除")
        _ = formalMtime
    }

    func testPruneDraftsByMaxFiles() {
        save(["drafts": ["maxFiles": 2, "maxTotalBytes": 4 * 1024 * 1024 * 1024]])
        _ = data.writeDraft(root: dir.path, relPath: "w/a.md", content: "aaaa")
        Thread.sleep(forTimeInterval: 0.01)
        _ = data.writeDraft(root: dir.path, relPath: "w/b.md", content: "bbbb")
        Thread.sleep(forTimeInterval: 0.01)
        _ = data.writeDraft(root: dir.path, relPath: "w/c.md", content: "cccc")
        let u = data.draftsUsage()
        XCTAssertEqual(u["files"] as? Int64, 2, "最旧一条应被剪枝")
        let pending = (arr(data.listPendingDrafts(root: dir.path), "drafts")
                       as? [[String: Any]])?.map { $0["relPath"] as? String } ?? []
        XCTAssertFalse(pending.contains("w/a.md"))
        XCTAssertTrue(pending.contains("w/c.md"))
    }

    // MARK: - 校对缓存

    func testProofSaveTruncates500AndLoad() {
        let items: [Any] = (0..<600).map { ["i": $0] }
        let s = data.proofSave(root: dir.path,
                               payload: ["relPath": " 作品/x.md ",
                                         "docHash": "h1", "requestId": "r1", "items": items])
        XCTAssertTrue((s["ok"] as? Bool) == true)
        XCTAssertEqual(s["count"] as? Int64, 500)

        let load = data.proofLoad(root: dir.path, relPath: "作品/x.md")
        let report = dict(load, "report")
        XCTAssertEqual(report["relPath"] as? String, "作品/x.md", "relPath trim 后落盘")
        XCTAssertEqual(report["docHash"] as? String, "h1")
        XCTAssertEqual(report["requestId"] as? String, "r1")
        XCTAssertEqual((report["items"] as? [Any])?.count, 500)
    }

    func testProofSaveRejectsBadPayload() {
        XCTAssertFalse((data.proofSave(root: dir.path, payload: ["items": []])["ok"] as? Bool) == true)
        XCTAssertFalse((data.proofSave(root: dir.path, payload: [String: Any]())["ok"] as? Bool) == true)
    }

    func testProofLoadMissingReportIsNull() {
        let r = data.proofLoad(root: dir.path, relPath: "none/x.md")
        XCTAssertTrue(r["report"] is NSNull)
    }

    func testProofPruneKeepsNewest200() {
        for i in 0..<205 {
            _ = data.proofSave(root: dir.path,
                               payload: ["relPath": "w/p\(i).md", "items": [["i": i]]])
            Thread.sleep(forTimeInterval: 0.003)
        }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir.appendingPathComponent("proofread"), includingPropertiesForKeys: nil)) ?? []
        XCTAssertEqual(files.count, 200)
        let oldestLoad = data.proofLoad(root: dir.path, relPath: "w/p0.md")
        XCTAssertTrue(oldestLoad["report"] is NSNull)
        let newestLoad = data.proofLoad(root: dir.path, relPath: "w/p204.md")
        XCTAssertFalse(newestLoad["report"] is NSNull)
    }

    // MARK: - baseline / last-session

    func testBaselineDefaultAndBadFile() throws {
        let d = data.readBaseline()
        let b = dict(d, "baseline")
        XCTAssertEqual(b["version"] as? Int64, 1)
        XCTAssertTrue(b["items"] is [String: Any])

        let syncDir = dir.appendingPathComponent("sync")
        try FileManager.default.createDirectory(at: syncDir, withIntermediateDirectories: true)
        try "garbage".data(using: .utf8)!.write(to: syncDir.appendingPathComponent("baseline.json"))
        let again = data.readBaseline()
        let b2 = dict(again, "baseline")
        XCTAssertEqual(b2["version"] as? Int64, 1)
    }

    func testWriteBaselineAcceptsEmptyMap() {
        let r = data.writeBaseline([:])
        XCTAssertTrue((r["ok"] as? Bool) == true)
        let b = dict(data.readBaseline(), "baseline")
        XCTAssertTrue(b.isEmpty, "空 map 落盘后读回仍为空（缺省 version/items 仅在坏文件时补）")
    }

    func testWriteReadBaselineRoundTrip() {
        let w = data.writeBaseline(["version": 2, "items": ["w/a.md": 123]])
        XCTAssertTrue((w["ok"] as? Bool) == true)
        XCTAssertGreaterThan(w["bytes"] as? Int64 ?? 0, 0)
        let b = dict(data.readBaseline(), "baseline")
        XCTAssertEqual(b["version"] as? Int64, 2)
        XCTAssertEqual(dict(b, "items")["w/a.md"] as? Int64, 123)
    }

    func testLastSessionRoundTripAndMissing() {
        let miss = data.readLastSession()
        XCTAssertTrue(miss["record"] is NSNull)
        let w = data.writeLastSession(["ts": 42, "doc": "w/a.md"])
        XCTAssertTrue((w["ok"] as? Bool) == true)
        let rec = dict(data.readLastSession(), "record")
        XCTAssertEqual(rec["ts"] as? Int64, 42)
        XCTAssertEqual(rec["doc"] as? String, "w/a.md")
    }

    // MARK: - 哈希纯函数（已知向量）

    func testHash12KnownVector() {
        XCTAssertEqual(AppDataStore.hash12(""), "da39a3ee5e6b")
        XCTAssertEqual(AppDataStore.hash12("abc"), "a9993e364706")
        XCTAssertEqual(AppDataStore.hash12(nil), "da39a3ee5e6b")
    }

    func testDraftKeyAndProofCacheKeyKnownLength() {
        let k1 = AppDataStore.draftKeyFor(root: dir.path, relPath: "w/a.md")
        let k2 = AppDataStore.draftKeyFor(root: dir.path + "/", relPath: "w/a.md")
        XCTAssertEqual(k1.count, 24)
        XCTAssertNotEqual(k1, k2, "root 逐字参与哈希，分隔符为换行")
        let pk = AppDataStore.proofCacheKey(forRoot: dir.path, relPath: "w/a.md")
        XCTAssertEqual(pk.count, 40)
        XCTAssertNotEqual(k1, pk)
    }
}
```

- [ ] **7.2 运行模拟器测试，验证失败（Red）**

执行「模拟器测试命令」。预期编译失败，关键报错形如：`error: cannot find 'AppDataStore' in scope`。该失败即 Red，进入实现。

- [ ] **7.3 新增 `Sources/AppDataStore.swift`（完整实现）**

新增文件，完整内容：

```swift
import Foundation
import CryptoKit

final class AppDataStore {
    static let defaultPort: Int64 = 18080
    static let proofCacheMax = 200
    static let proofItemsMax = 500
    static let defaultDailyGoal: Int64 = 1000
    static let defaultReminderTime = "20:00"
    static let defaultIntents = ["错字/病句检查", "结构诊断", "续写"]

    private static let reminderTimePattern =
        try! NSRegularExpression(pattern: "^([01]\\d|2[0-3]):[0-5]\\d$")
    private static let sessionPattern =
        try! NSRegularExpression(pattern: "^session-[A-Za-z0-9._-]{6,}$")
    private static let gatewayPattern =
        try! NSRegularExpression(pattern: "^https?://[^\\s/]+.*")

    private let dataDir: URL
    private let lock = NSLock()
    private var tmpSeq: Int64 = 0

    init(dataDir: URL) {
        self.dataDir = dataDir
    }

    // MARK: - getState

    func getState() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let cfg = readConfig()
        let root = cfg["workspaceRoot"] as? String
        let rootStr = (root?.isEmpty == false) ? root : nil

        var s: [String: Any] = [:]
        s["ok"] = true
        s["root"] = rootStr ?? NSNull()
        s["rootExists"] = rootStr != nil && FileManager.default.fileExists(atPath: rootStr!)
        s["pomodoro"] = mergePomodoro(cfg["pomodoro"], nil)
        s["settings"] = settingsConfig(cfg)
        s["ui"] = (cfg["ui"] as? [String: Any]).map { deepCopy($0) } ?? [String: Any]()
        s["proofread"] = normalizeProofread(cfg["proofread"])
        s["writingPrefs"] = normalizeWritingPrefs(cfg["writingPrefs"] as? [String: Any])
        s["draftsDir"] = dataDir.appendingPathComponent("drafts").path
        return s
    }

    // MARK: - saveConfig

    func saveConfig(_ patch: [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        var prev = readConfig()
        var next = prev

        if patch["pomodoro"] != nil {
            next["pomodoro"] = mergePomodoro(prev["pomodoro"], patch["pomodoro"])
        }
        if patch["ui"] != nil {
            var ui = (prev["ui"] as? [String: Any]).map { $0 } ?? [:]
            if let patchUi = patch["ui"] as? [String: Any] {
                for (k, v) in patchUi {
                    if k == "split", let ps = v as? [String: Any] {
                        var split = (ui["split"] as? [String: Any]) ?? [:]
                        if ps["ratio"] != nil {
                            split["ratio"] = clampDouble(ps["ratio"], 0.2, 0.8, 0.5)
                        }
                        if ps["on"] != nil { split["on"] = Self.strictBool(ps["on"]) }
                        ui["split"] = split
                    } else {
                        ui[k] = v
                    }
                }
            }
            next["ui"] = ui
        }
        if patch["proofread"] != nil {
            next["proofread"] = normalizeProofread(patch["proofread"])
        }
        if patch["send"] != nil {
            let p = asMap(patch["send"])
            next["send"] = ["intents": normalizeIntentList(p["intents"])]
        }
        if patch["autosave"] != nil {
            let p = asMap(patch["autosave"])
            next["autosave"] = ["debounceMs": clampLong(p["debounceMs"], 200, 10000, 1000)]
        }
        if patch["drafts"] != nil {
            next["drafts"] = mergeDrafts(prev["drafts"], patch["drafts"])
        }
        if patch["theme"] != nil {
            let theme = Self.stringOf(patch["theme"])
            next["theme"] = ["auto", "light", "dark"].contains(theme) ? theme : "auto"
        }
        if patch["general"] != nil {
            let pg = asMap(patch["general"])
            next["general"] = [
                "autoStart": Self.strictBool(pg["autoStart"]),
                "tray": !Self.falseBool(pg["tray"])
            ]
        }
        if patch["editor"] != nil {
            next["editor"] = normalizeEditor(asMap(prev["editor"]), asMap(patch["editor"]))
        }
        if patch["preview"] != nil {
            next["preview"] = normalizePreview(asMap(prev["preview"]), asMap(patch["preview"]))
        }
        if patch["remote"] != nil {
            var remote = asMap(prev["remote"])
            let pr = asMap(patch["remote"])
            if let mode = pr["mode"] {
                remote["mode"] = (mode as? String == "manual" || mode as? String == "auto")
                    ? mode : "auto"
            }
            if pr["gateway"] != nil {
                let gw = Self.stringOf(pr["gateway"]).trimmingJava()
                if !Self.gatewayPattern.hasMatch(gw) {
                    return fail("BadRequest: gateway 必须是 http(s):// 地址")
                }
                remote["gateway"] = gw
            }
            if pr["port"] != nil {
                remote["port"] = clampLong(pr["port"], 1024, 65535, Self.defaultPort)
            }
            next["remote"] = remote
        }
        if patch["writingPrefs"] != nil {
            next["writingPrefs"] = mergeWritingPrefs(prev["writingPrefs"], patch["writingPrefs"])
        }

        do {
            try writeConfig(next)
        } catch {
            return fail(error.localizedDescription)
        }
        _ = prev

        var configView: [String: Any] = [:]
        configView["pomodoro"] = next["pomodoro"] ?? NSNull()
        configView["ui"] = next["ui"] ?? NSNull()
        configView["proofread"] = next["proofread"] ?? NSNull()
        configView["writingPrefs"] = next["writingPrefs"] ?? NSNull()

        return [
            "ok": true,
            "config": configView,
            "settings": settingsConfig(next)
        ]
    }

    // MARK: - 草稿

    func writeDraft(root: String, relPath: String, content: String?) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard let content = content else { return fail("内容必须是字符串") }
        let maxBytes = draftsLimits(readConfig()).maxBytes
        let bytes = Array(content.utf8)
        if Int64(bytes.count) > maxBytes {
            return fail("草稿过大（\(bytes.count) > \(maxBytes) 字节），未写草稿")
        }
        let key = Self.draftKeyFor(root: root, relPath: relPath)
        let dir = dataDir.appendingPathComponent("drafts")
        do {
            try mkdirs(dir)
            let md = dir.appendingPathComponent(key + ".md")
            try atomicWrite(md, Data(bytes))
            let mtime = mtimeMillis(md)

            let segs = Self.stringOf(relPath).replacingOccurrences(of: "\\", with: "/")
                .components(separatedBy: "/")
            var meta: [String: Any] = [:]
            meta["key"] = key
            meta["root"] = Self.stringOf(root)
            meta["relPath"] = Self.stringOf(relPath)
            meta["work"] = segs.count > 1 ? segs[0] : ""
            meta["name"] = segs[segs.count - 1]
            meta["savedAt"] = nowMillis()
            meta["draftMtime"] = mtime
            meta["bytes"] = Int64(bytes.count)
            try writeWhole(dir.appendingPathComponent(key + ".json"),
                           text: jsonStringify(meta))
            pruneDrafts(draftsLimits(readConfig()))
            return ["ok": true, "key": key, "mtime": mtime, "bytes": Int64(bytes.count)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func readDraft(root: String, relPath: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let md = dataDir.appendingPathComponent("drafts")
            .appendingPathComponent(Self.draftKeyFor(root: root, relPath: relPath) + ".md")
        do {
            return ["ok": true, "content": try readText(md)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func clearDraft(root: String, relPath: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let key = Self.draftKeyFor(root: root, relPath: relPath)
        let dir = dataDir.appendingPathComponent("drafts")
        var cleared: Int64 = 0
        for name in [key + ".md", key + ".json"] {
            let f = dir.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: f.path) {
                do {
                    try FileManager.default.removeItem(at: f)
                    cleared += 1
                } catch { }
            }
        }
        return ["ok": true, "cleared": cleared]
    }

    func draftsUsage() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let limits = draftsLimits(readConfig())
        let dir = dataDir.appendingPathComponent("drafts")
        var files: Int64 = 0
        var bytes: Int64 = 0
        let list = (try? FileManager.default.contentsOfDirectory(at: dir,
                                                                 includingPropertiesForKeys: nil)) ?? []
        for f in list where f.lastPathComponent.hasSuffix(".md") {
            files += 1
            bytes += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return [
            "dir": dir.path,
            "files": files,
            "bytes": bytes,
            "limitFiles": limits.maxFiles,
            "limitBytes": limits.maxTotalBytes
        ]
    }

    func listPendingDrafts(root: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let dir = dataDir.appendingPathComponent("drafts")
        var out: [[String: Any]] = []
        let list = (try? FileManager.default.contentsOfDirectory(at: dir,
                                                                 includingPropertiesForKeys: nil)) ?? []
        for f in list where f.lastPathComponent.hasSuffix(".json") {
            guard let text = try? readText(f),
                  let parsed = try? jsonParse(text),
                  let meta = parsed as? [String: Any] else { continue }
            guard let relPath = meta["relPath"] as? String, safeRelPath(relPath) else { continue }
            let metaRoot = Self.stringOf(meta["root"])
            guard metaRoot == root else { continue }

            let md = dir.appendingPathComponent(Self.draftKeyFor(root: metaRoot, relPath: relPath) + ".md")
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: md.path, isDirectory: &isDir),
                  !isDir.boolValue else { continue }
            let draftMtime = mtimeMillis(md)
            let draftBytes = Int64((try? md.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)

            let formal = URL(fileURLWithPath: root)
                .appendingPathComponent(relPath.replacingOccurrences(of: "/", with: "/"))
            var fDir: ObjCBool = false
            let formalExists = FileManager.default.fileExists(atPath: formal.path, isDirectory: &fDir)
                && !fDir.boolValue
            let formalMtime = formalExists ? mtimeMillis(formal) : 0
            if formalExists && draftMtime <= formalMtime {
                _ = clearDraftLocked(metaRoot, relPath)
                continue
            }
            out.append([
                "relPath": relPath,
                "work": meta["work"] ?? "",
                "name": meta["name"] ?? "",
                "savedAt": meta["savedAt"] ?? 0,
                "draftMtime": draftMtime,
                "bytes": draftBytes,
                "formalExists": formalExists,
                "formalMtime": formalMtime
            ])
        }
        out.sort { int64($0["draftMtime"]) > int64($1["draftMtime"]) }
        return ["ok": true, "root": root, "drafts": out]
    }

    // MARK: - 校对缓存

    func proofSave(root: String, payload: [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let relObj = payload["relPath"]
        let rel = (relObj as? String)?.trimmingJava() ?? ""
        if rel.isEmpty { return fail("BadRequest: 缺 relPath") }

        var items: [Any] = []
        if let raw = payload["items"] as? [Any] {
            for it in raw {
                if items.count >= Self.proofItemsMax { break }
                items.append(it)
            }
        }
        var rec: [String: Any] = [:]
        rec["relPath"] = rel
        rec["at"] = nowMillis()
        rec["docHash"] = (payload["docHash"] as? String) ?? ""
        rec["requestId"] = (payload["requestId"] as? String) ?? ""
        rec["items"] = items

        let dir = dataDir.appendingPathComponent("proofread")
        do {
            try mkdirs(dir)
            try writeWhole(dir.appendingPathComponent(
                Self.proofCacheKey(forRoot: root, relPath: rel) + ".json"),
                text: jsonStringify(rec))
            proofPrune()
            return ["ok": true, "count": Int64(items.count)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func proofLoad(root: String, relPath: String?) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let rel = (relPath ?? "").trimmingJava()
        if rel.isEmpty { return fail("BadRequest: 缺 relPath") }
        let f = dataDir.appendingPathComponent("proofread")
            .appendingPathComponent(Self.proofCacheKey(forRoot: root, relPath: rel) + ".json")
        var report: Any = NSNull()
        if let text = try? readText(f),
           let parsed = try? jsonParse(text),
           let map = parsed as? [String: Any],
           map["items"] is [Any] {
            report = map
        }
        return ["ok": true, "report": report]
    }

    // MARK: - baseline / last-session

    func readBaseline() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let f = dataDir.appendingPathComponent("sync").appendingPathComponent("baseline.json")
        var parsed: Any?
        if let text = try? readText(f), let p = try? jsonParse(text) {
            parsed = (p as? [String: Any]) != nil ? p : nil
        }
        let baseline: [String: Any]
        if let m = parsed as? [String: Any] {
            baseline = m
        } else {
            baseline = ["version": Int64(1), "items": [String: Any]()]
        }
        return ["ok": true, "baseline": baseline]
    }

    func writeBaseline(_ map: [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let f = dataDir.appendingPathComponent("sync").appendingPathComponent("baseline.json")
        do {
            try mkdirs(f.deletingLastPathComponent())
            let bytes = Data(try jsonStringify(map).utf8)
            try atomicWrite(f, bytes)
            return ["ok": true, "bytes": Int64(bytes.count)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func writeLastSession(_ rec: [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let f = dataDir.appendingPathComponent("last-session.json")
        do {
            try mkdirs(f.deletingLastPathComponent())
            let bytes = Data(try jsonStringify(rec).utf8)
            try atomicWrite(f, bytes)
            return ["ok": true, "bytes": Int64(bytes.count)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func readLastSession() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let f = dataDir.appendingPathComponent("last-session.json")
        var record: Any = NSNull()
        if let text = try? readText(f),
           let parsed = try? jsonParse(text),
           let map = parsed as? [String: Any] {
            record = map
        }
        return ["ok": true, "record": record]
    }

    // MARK: - 哈希（静态纯函数）

    static func hash12(_ text: String?) -> String {
        String(sha1Hex(text ?? "").prefix(12))
    }

    static func draftKeyFor(root: String, relPath: String) -> String {
        String(sha1Hex(stringOf(root) + "\n" + stringOf(relPath)).prefix(24))
    }

    static func proofCacheKey(forRoot root: String, relPath: String) -> String {
        String(sha1Hex(stringOf(root) + "|" + stringOf(relPath)).prefix(40))
    }

    static func sha1Hex(_ input: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - 配置归一化

    private struct DraftLimits {
        let maxFiles: Int64
        let maxBytes: Int64
        let maxTotalBytes: Int64
    }

    private func draftsLimits(_ cfg: [String: Any]) -> DraftLimits {
        let d = asMap(cfg["drafts"])
        return DraftLimits(
            maxFiles: clampLong(d["maxFiles"], 1, 10000, 200),
            maxBytes: clampLong(d["maxBytes"], 1024, 256 * 1024 * 1024, 5 * 1024 * 1024),
            maxTotalBytes: clampLong(d["maxTotalBytes"], 1024 * 1024,
                                     4 * 1024 * 1024 * 1024, 128 * 1024 * 1024)
        )
    }

    private func mergePomodoro(_ prevObj: Any?, _ patchObj: Any?) -> [String: Any] {
        var merged = asMap(prevObj)
        if let patch = patchObj as? [String: Any] {
            for (k, v) in patch { merged[k] = v }
        }
        return [
            "focusMin": clampLong(merged["focusMin"], 1, 180, 25),
            "breakMin": clampLong(merged["breakMin"], 1, 60, 5),
            "autoNext": !Self.falseBool(merged["autoNext"])
        ]
    }

    private func mergeDrafts(_ prevObj: Any?, _ patchObj: Any?) -> [String: Any] {
        let prev = asMap(prevObj)
        let patch = asMap(patchObj)
        let old = draftsLimits(prev)
        let maxFiles = patch["maxFiles"] != nil
            ? clampLong(patch["maxFiles"], 1, 10000, old.maxFiles) : old.maxFiles
        let maxBytes = patch["maxBytes"] != nil
            ? clampLong(patch["maxBytes"], 1024, 256 * 1024 * 1024, old.maxBytes)
            : old.maxBytes
        let maxTotal = patch["maxTotalBytes"] != nil
            ? clampLong(patch["maxTotalBytes"], 1024 * 1024,
                        4 * 1024 * 1024 * 1024, old.maxTotalBytes) : old.maxTotalBytes
        let notify: Bool
        if patch["notifyOnStartup"] != nil {
            notify = !Self.falseBool(patch["notifyOnStartup"])
        } else {
            notify = !Self.falseBool(prev["notifyOnStartup"])
        }
        return ["maxFiles": maxFiles, "maxBytes": maxBytes,
                "maxTotalBytes": maxTotal, "notifyOnStartup": notify]
    }

    private func settingsConfig(_ cfg: [String: Any]) -> [String: Any] {
        var s: [String: Any] = [:]
        s["autosave"] = ["debounceMs": clampLong(asMap(cfg["autosave"])["debounceMs"],
                                                 200, 10000, 1000)]
        let dl = draftsLimits(cfg)
        s["drafts"] = [
            "maxFiles": dl.maxFiles,
            "maxBytes": dl.maxBytes,
            "maxTotalBytes": dl.maxTotalBytes,
            "notifyOnStartup": !Self.falseBool(asMap(cfg["drafts"])["notifyOnStartup"])
        ]
        let theme = cfg["theme"]
        s["theme"] = (theme as? String).map { ["auto", "light", "dark"].contains($0) ? $0 : "auto" }
            ?? "auto"
        let pg = asMap(cfg["general"])
        s["general"] = [
            "autoStart": Self.strictBool(pg["autoStart"]),
            "tray": !Self.falseBool(pg["tray"])
        ]
        let sendRaw = asMap(cfg["send"])["intents"]
        s["send"] = ["intents": sendRaw == nil ? type(of: self).defaultIntents
                                          : normalizeIntentList(sendRaw)]
        s["editor"] = normalizedKnownEditor(asMap(cfg["editor"]))
        s["preview"] = normalizedKnownPreview(asMap(cfg["preview"]))

        let pr = asMap(cfg["remote"])
        let gwStr = (pr["gateway"] as? String)?.trimmingJava() ?? ""
        s["remote"] = [
            "mode": (pr["mode"] as? String == "manual") ? "manual" : "auto",
            "gateway": Self.gatewayPattern.hasMatch(gwStr) ? gwStr : "",
            "port": clampLong(pr["port"], 1024, 65535, Self.defaultPort)
        ]
        return s
    }

    private func normalizeEditor(_ prev: [String: Any], _ patch: [String: Any]) -> [String: Any] {
        var merged = prev
        for (k, v) in patch { merged[k] = v }
        return normalizedKnownEditor(merged)
    }

    private func normalizedKnownEditor(_ e: [String: Any]) -> [String: Any] {
        var out = e
        out["fontSize"] = clampFontSize(e["fontSize"])
        let family = e["fontFamily"] as? String
        out["fontFamily"] = ["kai", "mono", "serif", "sans", "dsh"].contains(family) ? family : "kai"
        out["lineHeight"] = clampOptionalDouble(e["lineHeight"], 1.4, 2.4, digits: 2)
        out["letterSpacing"] = clampOptionalDouble(e["letterSpacing"], 0, 0.1, digits: 3)
        out["measure"] = clampOptionalLong(e["measure"], 20, 48)
        let preset = e["colorPreset"] as? String
        out["colorPreset"] = ["default", "sepia", "green"].contains(preset) ? preset : "default"
        return out
    }

    private func normalizePreview(_ prev: [String: Any], _ patch: [String: Any]) -> [String: Any] {
        var merged = prev
        for (k, v) in patch { merged[k] = v }
        return normalizedKnownPreview(merged)
    }

    private func normalizedKnownPreview(_ p: [String: Any]) -> [String: Any] {
        var out = p
        out["fontSize"] = clampFontSize(p["fontSize"])
        out["lineHeight"] = clampOptionalDouble(p["lineHeight"], 1.4, 2.4, digits: 2)
        let family = p["fontFamily"] as? String
        out["fontFamily"] = ["auto", "mono", "serif", "sans"].contains(family) ? family : "auto"
        out["paraSpacing"] = normalizeParaSpacing(p["paraSpacing"])
        out["indent"] = clampLong(p["indent"], 0, 2, 0)
        return out
    }

    private func normalizeParaSpacing(_ v: Any?) -> Any {
        guard let v = v else { return "auto" }
        if let s = v as? String {
            if s.isEmpty || s == "auto" { return "auto" }
            let n = toDouble(s)
            if !n.isFinite || n < 0 { return "auto" }
            return round(Swift.min(2, n), digits: 2)
        }
        if v is NSNumber {
            let n = toDouble(v)
            if !n.isFinite || n < 0 { return "auto" }
            return round(Swift.min(2, n), digits: 2)
        }
        return "auto"
    }

    private func normalizeProofread(_ raw: Any?) -> [String: Any] {
        let o = asMap(raw)
        let s = (o["sessionId"] as? String)?.trimmingJava() ?? ""
        let valid = Self.sessionPattern.hasMatch(s) ? s : ""
        return ["sessionId": valid]
    }

    private func normalizeWritingPrefs(_ raw: [String: Any]?) -> [String: Any] {
        let goalNumber = raw.map { toDouble($0["dailyGoal"]) } ?? .nan
        let dailyGoal: Int64 = goalNumber.isFinite
            ? Swift.min(100000, Swift.max(0, Int64((goalNumber).rounded())))
            : Self.defaultDailyGoal
        let enabled = raw?["reminderEnabled"]
        let time = raw?["reminderTime"] as? String
        return [
            "dailyGoal": dailyGoal,
            "reminderEnabled": enabled == nil ? true : Self.strictBool(enabled),
            "reminderTime": (time.map { Self.reminderTimePattern.hasMatch($0) } ?? false)
                ? time! : Self.defaultReminderTime
        ]
    }

    private func mergeWritingPrefs(_ prevObj: Any?, _ patchObj: Any?) -> [String: Any] {
        let prev = asMap(prevObj)
        let patch = asMap(patchObj)
        var out = normalizeWritingPrefs(prev)
        if patch["dailyGoal"] != nil {
            let n = toDouble(patch["dailyGoal"])
            if n.isFinite {
                out["dailyGoal"] = Swift.min(100000, Swift.max(0, Int64(n.rounded())))
            }
        }
        if patch["reminderEnabled"] != nil {
            out["reminderEnabled"] = Self.strictBool(patch["reminderEnabled"])
        }
        if let t = patch["reminderTime"] as? String, Self.reminderTimePattern.hasMatch(t) {
            out["reminderTime"] = t
        }
        return out
    }

    private func normalizeIntentList(_ v: Any?) -> [String] {
        if let arr = v as? [Any] {
            var joined = ""
            for o in arr { joined += normalizeIntent(o) + "\n" }
            return parseIntents(joined)
        }
        if let s = v as? String { return parseIntents(s) }
        return []
    }

    private func normalizeIntent(_ v: Any?) -> String {
        // 逐字对齐 Java：replaceAll("[\\r\\n]+", " ")——连续换行折叠成一个空格
        // （不能拆成三次单字符替换，否则 "\r\n\r\n" 会变成两个空格而蓝本是一个）
        let collapsed = Self.stringOf(v).replacingOccurrences(
            of: #"[\r\n]+"#, with: " ", options: .regularExpression)
        let s = collapsed.trimmingJava()
        return s.count > 40 ? String(s.prefix(40)) : s
    }

    private func parseIntents(_ text: String) -> [String] {
        let s = text.count > 2000 ? String(text.prefix(2000)) : text
        var out: [String] = []
        for line in s.components(separatedBy: "\n") {
            let v = normalizeIntent(line)
            if v.isEmpty || out.contains(v) { continue }
            out.append(v)
            if out.count >= 20 { break }
        }
        return out
    }

    // MARK: - 剪枝

    private func pruneDrafts(_ limits: DraftLimits) {
        let dir = dataDir.appendingPathComponent("drafts")
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir,
                                                                   includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasSuffix(".md") }
        if files.isEmpty { return }
        let sorted = files.sorted { mtimeMillis($0) < mtimeMillis($1) }
        var total: Int64 = 0
        for f in sorted {
            total += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        if Int64(sorted.count) <= limits.maxFiles && total <= limits.maxTotalBytes { return }

        var n = sorted.count
        var sum = total
        var over = 0
        while n > 1 && over < sorted.count
                && (Int64(n) > limits.maxFiles || sum > limits.maxTotalBytes) {
            sum -= Int64((try? sorted[over].resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            n -= 1
            over += 1
        }
        for i in 0..<over {
            let old = sorted[i]
            tryDelete(old)
            let jsonPath = old.path.replacingOccurrences(of: ".md$", with: ".json",
                                                         options: .regularExpression)
            tryDelete(URL(fileURLWithPath: jsonPath))
        }
    }

    private func proofPrune() {
        let dir = dataDir.appendingPathComponent("proofread")
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir,
                                                                   includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasSuffix(".json") }
        if files.count <= Self.proofCacheMax { return }
        let sorted = files.sorted { mtimeMillis($0) < mtimeMillis($1) }
        let removeCount = sorted.count - Self.proofCacheMax
        for i in 0..<removeCount { tryDelete(sorted[i]) }
    }

    private func tryDelete(_ f: URL) {
        try? FileManager.default.removeItem(at: f)
    }

    // MARK: - 数值工具

    private func clampLong(_ v: Any?, _ lo: Int64, _ hi: Int64, _ dflt: Int64) -> Int64 {
        let n = toDouble(v)
        guard n.isFinite else { return dflt }
        return Swift.min(hi, Swift.max(lo, Int64(n.rounded())))
    }

    private func clampDouble(_ v: Any?, _ lo: Double, _ hi: Double, _ dflt: Double) -> Double {
        let n = toDouble(v)
        guard n.isFinite else { return dflt }
        return Swift.min(hi, Swift.max(lo, n))
    }

    private func clampFontSize(_ v: Any?) -> Int64 {
        let n = toDouble(v)
        guard n.isFinite, n > 0 else { return 0 }
        return Swift.min(32, Swift.max(10, Int64(n.rounded())))
    }

    private func clampOptionalDouble(_ v: Any?, _ lo: Double, _ hi: Double, digits: Int) -> Double {
        let n = toDouble(v)
        guard n.isFinite, n > 0 else { return 0 }
        return round(Swift.min(hi, Swift.max(lo, n)), digits: digits)
    }

    private func clampOptionalLong(_ v: Any?, _ lo: Int64, _ hi: Int64) -> Int64 {
        let n = toDouble(v)
        guard n.isFinite, n > 0 else { return 0 }
        return Swift.min(hi, Swift.max(lo, Int64(n.rounded())))
    }

    private func toDouble(_ v: Any?) -> Double {
        if let n = v as? NSNumber {
            return CFNumberIsFloatType(n as CFNumber) ? n.doubleValue : Double(n.int64Value)
        }
        if let s = v as? String {
            return Double(s.trimmingJava()) ?? .nan
        }
        return .nan
    }

    private func round(_ n: Double, digits: Int) -> Double {
        let f = pow(10.0, Double(digits))
        return (n * f).rounded() / f
    }

    private static func strictBool(_ v: Any?) -> Bool {
        (v as? Bool) == true
    }

    private static func falseBool(_ v: Any?) -> Bool {
        (v as? Bool) == false
    }

    // MARK: - 基础工具

    private func asMap(_ o: Any?) -> [String: Any] {
        guard let m = o as? [String: Any] else { return [:] }
        return m
    }

    private static func stringOf(_ o: Any?) -> String {
        if let s = o as? String { return s }
        if let o = o { return String(describing: o) }
        return ""
    }

    private func int64(_ o: Any?) -> Int64 {
        (o as? NSNumber)?.int64Value ?? 0
    }

    private func deepCopy(_ m: [String: Any]) -> [String: Any] {
        guard let data = try? JSONSerialization.data(withJSONObject: m, options: [.fragmentsAllowed]),
              let copy = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return m
        }
        return copy
    }

    private func fail(_ error: String) -> [String: Any] {
        ["ok": false, "error": error]
    }

    private func safeRelPath(_ relPath: String) -> Bool {
        if relPath.isEmpty { return false }
        let segs = relPath.replacingOccurrences(of: "\\", with: "/")
            .components(separatedBy: "/")
        return !segs.contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }

    private func clearDraftLocked(_ root: String, _ relPath: String) -> [String: Any] {
        let key = Self.draftKeyFor(root: root, relPath: relPath)
        let dir = dataDir.appendingPathComponent("drafts")
        var cleared: Int64 = 0
        for name in [key + ".md", key + ".json"] {
            let f = dir.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: f.path) {
                do { try FileManager.default.removeItem(at: f); cleared += 1 } catch { }
            }
        }
        return ["ok": true, "cleared": cleared]
    }

    // MARK: - 配置 IO

    private func readConfig() -> [String: Any] {
        let f = dataDir.appendingPathComponent("config.json")
        if let text = try? readText(f),
           let parsed = try? jsonParse(text),
           let m = parsed as? [String: Any] {
            return m
        }
        return [:]
    }

    private func writeConfig(_ cfg: [String: Any]) throws {
        let f = dataDir.appendingPathComponent("config.json")
        try mkdirs(f.deletingLastPathComponent())
        try writeWhole(f, text: try jsonStringify(cfg))
    }

    // MARK: - JSON / IO

    private func jsonParse(_ text: String) throws -> Any {
        let data = Data(text.utf8)
        let obj = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return obj
    }

    private func jsonStringify(_ v: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])
        return String(decoding: data, as: UTF8.self)
    }

    private func mkdirs(_ d: URL) throws {
        if !FileManager.default.fileExists(atPath: d.path) {
            do {
                try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("目录创建失败: \(d.path)")
            }
        }
    }

    private func writeWhole(_ f: URL, text: String) throws {
        try atomicWrite(f, Data(text.utf8))
    }

    private func atomicWrite(_ target: URL, _ bytes: Data) throws {
        try mkdirs(target.deletingLastPathComponent())
        tmpSeq += 1
        let tmp = target.deletingLastPathComponent()
            .appendingPathComponent(target.lastPathComponent + ".tmp-\(tmpSeq)")
        do {
            try bytes.write(to: tmp, options: .atomic)
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.moveItem(at: tmp, to: target)
        } catch {
            do {
                try bytes.write(to: target, options: .atomic)
                try? FileManager.default.removeItem(at: tmp)
            } catch {
                throw PathGuard.bad("写入失败: \(error.localizedDescription)")
            }
        }
    }

    private func readText(_ f: URL) throws -> String {
        let raw: Data
        do {
            raw = try Data(contentsOf: f)
        } catch {
            throw PathGuard.bad("读取失败: \(error.localizedDescription)")
        }
        var s = String(decoding: raw, as: UTF8.self)
        if s.first == "\u{FEFF}" { s.removeFirst() }
        return s
    }

    private func mtimeMillis(_ u: URL) -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: u.path),
              let date = attrs[.modificationDate] as? Date else { return 0 }
        return Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    private func nowMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

private extension String {
    func trimmingJava() -> String {
        var scalars = Substring(self).unicodeScalars
        while let first = scalars.first, first.value <= 0x20 { scalars.removeFirst() }
        while let last = scalars.last, last.value <= 0x20 { scalars.removeLast() }
        return String(scalars)
    }
}

private extension NSRegularExpression {
    func hasMatch(_ s: String) -> Bool {
        firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
}
```

移植要点（执行时不得偏离）：

- **个人常量禁令**：本文件**不出现**安卓的 `DEFAULT_GATEWAY`（`http://100.99.84.35:8080`）与 `DEFAULT_PROOF_SESSION`；`settingsConfig` 中 gateway 非法回落 `""`，`normalizeProofread` 非法回落 `""`。
- `saveConfig` 只拷贝白名单顶层键（与 Java 一致）：未知顶层键（如 `workspaceRoot`、`unknownTopLevel`）**不会**经 patch 落盘；`next` 从 `readConfig()` 整体拷贝起步，故旧配置中的 `workspaceRoot` 原样保留。
- `toDouble` 对 `NSNumber` 需区分整型/浮点（`CFNumberIsFloatType`），避免 Bool（它也是 NSNumber）被当数字；Bool 走布尔分支，各 clamp 读到 Bool 时 `int64Value` 行为虽存在但正常流程不会传错类型。
- JSON 用 `JSONSerialization`：整数写回时确保值为 `Int64`（不要用 `Int`，在 64 位模拟器上等价但语义以 Int64 为准）；解析得到的数字按 NSNumber 再 `int64Value`/`doubleValue`。`jsonStringify` 对 map/array/标量统一用 `.fragmentsAllowed`，内部数据均不含 NaN/Infinity（clamp 已过滤）。
- `String.replacingOccurrences(of:".md$", with:".json", options:.regularExpression)` 对应 Java `replaceAll("\\.md$", ".json")`（仅末尾一次）。
- SHA-1 用 CryptoKit `Insecure.SHA1`，输出与 Java `MessageDigest("SHA-1")` 同为小写 hex；`hash12(nil)` 与 `hash12("")` 同值。
- `atomicWrite` 临时名 `<name>.tmp-<seq>`，`seq` 为实例级单调递增（对应 Java `AtomicLong`，同一 `AppDataStore` 实例内串行锁保护）；移动失败回退“原子写目标 + 删 tmp”。
- `listPendingDrafts` 内调用剪枝式清理走 `clearDraftLocked`（不加锁，已持锁）；公共 `clearDraft` 自带锁。
- `trimmingJava()` 复刻 Java `trim()`（只裁 ≤ U+0020），不可用 `trimmingCharacters(in: .whitespaces)`。
- 校对 `relPath` 在 `proofSave` 入口 trim（Java 行为），`proofLoad` 同样 trim 后再算 key。

> **主控裁决（Task 13.3 第二次 CI，2026-10-11）**：CI（Xcode 16.2 / Swift 5 语言模式 / iOS 18.2 SDK）第二轮在本文件暴露 10 条错误，围栏与落盘逐字同款缺陷，已双侧修复：
>
> 1. `stringOf` 是 `private static func`，Swift 5 模式下实例方法不得裸用静态方法（错误 `static member 'stringOf' cannot be used on instance of type 'AppDataStore'`）。7 个实例上下文调用点（saveConfig 的 theme/gateway、writeDraft 的 segs/root/relPath、listPendingDrafts 的 metaRoot、normalizeIntent 的 collapsed）统一加 `Self.` 限定；静态方法 `draftKeyFor`/`proofCacheKey` 内的裸调用合法，不动。
> 2. `jsonStringify` 是 throws 实例方法，`writeBaseline`/`writeLastSession` 两处 `Data(jsonStringify(...).utf8)` 缺 `try`（CI 报 368:30 / 382:30）；全量排查 throws 调用点时另发现 `writeConfig` 内 `try writeWhole(f, text: jsonStringify(cfg))` 嵌套调用同样缺内层 `try`（编译器本轮被短路未报）。三处一并补 `try`。
> 3. CI 另报 `listPendingDrafts` 263:71 `reference to member 'fileSizeKey' cannot be resolved without a contextual type`，但同模式的 pruneDrafts 两处（644/653 行）不报错——判定为同函数 255 行 stringOf 错误污染整函数类型推断的级联错误，本行代码不改动，随 stringOf 修复在第三次 CI 验证自愈；若仍报错再显式写 `URLResourceKey.fileSizeKey`。
>
> 修复仅为编译合规（静态限定 / 错误传播标注），运行时语义、错误信息与 Java 蓝本一比一不变。

- [ ] **7.4 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`，AppDataStoreTests 全绿且既有测试不受影响。若个别时间敏感用例（剪枝 mtime 同毫秒）不稳定，保留 `Thread.sleep` 间隔，不得放宽断言。

- [ ] **7.5 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/AppDataStore.swift Tests/DSHRemoteTests/AppDataStoreTests.swift
git commit -m "feat(appdata): 一比一移植安卓 AppData 配置草稿校对基线与哈希"
```

---

### 7.6 先写失败测试 `Tests/DSHRemoteTests/OutboxStoreTests.swift`（Red）

蓝本 `OutboxStore.java`（153 行）：发件箱文件 `outbox.json`，条目 `{relPath, queuedAt}`；`add` 经 `normalize` 去重，`remove` 倒序多删、无变化不写盘，`read` 宽容（缺失/损坏→空数组）并按 `queuedAt` 升序，写入走固定临时名 `outbox.json.tmp` + 原子移动。Swift 侧错误风格对齐 `WorkspaceStore`：**底层/参数错误抛 `PathGuardError`**（Java 侧 `add`/`write` 本就抛 `IllegalArgumentException`/`RuntimeException`），不返回 fail-map。

新增文件，完整内容：

```swift
import XCTest
@testable import DSHRemote

final class OutboxStoreTests: XCTestCase {

    var dir: URL!
    var store: OutboxStore!
    var file: URL { dir.appendingPathComponent("outbox.json") }
    var tmpFile: URL { dir.appendingPathComponent("outbox.json.tmp") }

    override func setUpWithError() throws {
        try super.setUpWithError()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("OutboxTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = OutboxStore(dataDir: dir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        try super.tearDownWithError()
    }

    func assertAddBad(_ relPath: String?, _ fragment: String,
                       file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try store.add(relPath), file: file, line: line) { err in
            let desc = (err as? LocalizedError)?.errorDescription ?? String(describing: err)
            XCTAssertTrue(desc.contains(fragment),
                          "预期错误信息含「\(fragment)」，实际：\(desc)",
                          file: file, line: line)
        }
    }

    func readRaw(_ text: String) throws {
        try Data(text.utf8).write(to: file)
    }

    // MARK: - 缺失文件

    func testListMissingFileIsEmpty() {
        XCTAssertTrue(store.list().isEmpty)
        XCTAssertEqual(store.count(), 0)
        XCTAssertEqual(store.countByDoc(), [:])
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    // MARK: - add / 去重 / queuedAt

    func testAddWritesEntry() throws {
        try store.add("作品A/第一章.md")
        let list = store.list()
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0]["relPath"] as? String, "作品A/第一章.md")
        let at = list[0]["queuedAt"] as? Int64
        XCTAssertNotNil(at)
        XCTAssertGreaterThan(at ?? 0, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmpFile.path),
                       "提交后不得残留 outbox.json.tmp")
    }

    func testAddDeduplicatesByNormalizedRelPath() throws {
        try store.add(" 作品A/第一章.md ")
        try store.add("作品A/第一章.md")
        XCTAssertEqual(store.count(), 1)
        XCTAssertEqual(store.list()[0]["relPath"] as? String, "作品A/第一章.md")
    }

    func testAddNormalizesBackslashesAndDeduplicates() throws {
        try store.add("作品A\\第一章.md")
        try store.add("作品A/第一章.md")
        XCTAssertEqual(store.count(), 1)
        XCTAssertEqual(store.list()[0]["relPath"] as? String, "作品A/第一章.md")
    }

    func testAddKeepsInsertionOrderWhenTimestampsEqual() throws {
        try store.add("a.md")
        try store.add("b.md")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String }, ["a.md", "b.md"])
    }

    // MARK: - normalize 错误（逐字文案）

    func testAddRejectsNil() {
        assertAddBad(nil, "relPath 必须是字符串")
    }

    func testAddRejectsBlank() {
        assertAddBad("   ", "relPath 不得为空")
        assertAddBad("\t\n", "relPath 不得为空")
    }

    func testAddRejectsAbsolutePath() {
        assertAddBad("/作品A/第一章.md", "拒绝绝对路径: /作品A/第一章.md")
    }

    func testAddRejectsTrailingSlash() {
        assertAddBad("作品A/子目录/", "路径不得以分隔符结尾: 作品A/子目录/")
    }

    func testAddRejectsDotSegments() {
        assertAddBad("作品A/../第一章.md", "路径段不得为")
        assertAddBad("./第一章.md", "路径段不得为")
    }

    func testAddRejectsForbiddenSegment() {
        assertAddBad("作品A/第一:章.md", "禁用字符")
    }

    func testAddFailureDoesNotWriteFile() {
        assertAddBad("/x.md", "拒绝绝对路径")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    // MARK: - remove

    func testRemoveNullAndBlankAreNoOpWithoutWriting() {
        store.remove(nil)
        store.remove("   ")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testRemoveDeletesMatchingEntry() throws {
        try store.add("a.md")
        try store.add("b.md")
        store.remove("a.md")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String }, ["b.md"])
    }

    func testRemoveNormalizesBackslashesButDoesNotTrim() throws {
        try store.add("作品A/第一章.md")
        store.remove(" 作品A/第一章.md ")
        XCTAssertEqual(store.count(), 1, "remove 不做 trim，带空白不匹配")
        store.remove("作品A\\第一章.md")
        XCTAssertEqual(store.count(), 0)
    }

    func testRemoveUnknownIsNoOpAndDoesNotRewrite() throws {
        try store.add("a.md")
        let mtime = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate]
            as? Date
        Thread.sleep(forTimeInterval: 0.02)
        store.remove("不存在.md")
        let mtime2 = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate]
            as? Date
        XCTAssertEqual(mtime, mtime2, "无变化不得重写文件")
    }

    func testRemoveDeletesAllDuplicatesInReverse() throws {
        try readRaw("[{\"relPath\":\"a.md\",\"queuedAt\":1},"
                    + "{\"relPath\":\"dup.md\",\"queuedAt\":2},"
                    + "{\"relPath\":\"dup.md\",\"queuedAt\":3}]")
        store.remove("dup.md")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String }, ["a.md"])
    }

    // MARK: - read 宽容与排序

    func testListSortsByQueuedAtAscending() throws {
        try readRaw("[{\"relPath\":\"c.md\",\"queuedAt\":30},"
                    + "{\"relPath\":\"a.md\",\"queuedAt\":10},"
                    + "{\"relPath\":\"b.md\",\"queuedAt\":20}]")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String },
                       ["a.md", "b.md", "c.md"])
    }

    func testListToleratesCorruptJson() throws {
        try readRaw("{这不是 JSON")
        XCTAssertTrue(store.list().isEmpty)
        XCTAssertEqual(store.count(), 0)
    }

    func testListToleratesNonArrayJson() throws {
        try readRaw("{\"relPath\":\"a.md\"}")
        XCTAssertTrue(store.list().isEmpty)
    }

    func testListSkipsBadEntriesAndDefaultsQueuedAt() throws {
        try readRaw("[42,"
                    + "{\"queuedAt\":5},"
                    + "{\"relPath\":\"  \",\"queuedAt\":6},"
                    + "{\"relPath\":\"x.md\"},"
                    + "{\"relPath\":\"y.md\",\"queuedAt\":\"abc\"}]")
        let list = store.list()
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(list[0]["relPath"] as? String, "x.md")
        XCTAssertEqual(list[0]["queuedAt"] as? Int64, 0)
        XCTAssertEqual(list[1]["relPath"] as? String, "y.md")
        XCTAssertEqual(list[1]["queuedAt"] as? Int64, 0)
    }

    func testListStripsBom() throws {
        try readRaw("\u{FEFF}[{\"relPath\":\"a.md\",\"queuedAt\":1}]")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String }, ["a.md"])
    }

    func testListReturnsCopy() throws {
        try store.add("a.md")
        var snapshot = store.list()
        snapshot.removeAll()
        XCTAssertEqual(store.count(), 1)
    }

    // MARK: - countByDoc

    func testCountByDocGroupsBeforeFirstSlash() throws {
        try readRaw("[{\"relPath\":\"作品A/第一章.md\",\"queuedAt\":1},"
                    + "{\"relPath\":\"作品A/第二章.md\",\"queuedAt\":2},"
                    + "{\"relPath\":\"作品B/x.md\",\"queuedAt\":3},"
                    + "{\"relPath\":\"根文档.md\",\"queuedAt\":4}]")
        let counts = store.countByDoc()
        XCTAssertEqual(counts["作品A"] as? Int, 2)
        XCTAssertEqual(counts["作品B"] as? Int, 1)
        XCTAssertEqual(counts[""] as? Int, 1)
        XCTAssertEqual(counts.keys.sorted(), ["", "作品A", "作品B"])
    }

    // MARK: - 落盘往返

    func testRoundTripAcrossInstances() throws {
        try store.add("作品A/第一章.md")
        let reopened = OutboxStore(dataDir: dir)
        XCTAssertEqual(reopened.count(), 1)
        XCTAssertEqual(reopened.list()[0]["relPath"] as? String, "作品A/第一章.md")
    }
}
```

> **主控裁决（Task 13.3 第三次 CI，2026-10-11）**：CI 报 OutboxStoreTests 三处 `XCTAssertEqual(store.list(), [])` 错误 `type 'Any' cannot conform to 'Equatable'`（41/169/175 行）。根因：`store.list()` 返回 `[[String: Any]]`，其元素 `[String: Any]` 因 `Any` 不满足 Equatable 而整个数组不能用 `==` 比较，`XCTAssertEqual(_:_:)` 无可用重载。围栏与落盘逐字同款，双侧把三处改为 `XCTAssertTrue(store.list().isEmpty)`——断言语义完全等价（缺失文件 / 损坏 JSON / 非数组 JSON 均期望空列表），不放宽任何用例。同文件其他 `XCTAssertEqual` 比较的是 `.count`、下标取值的 `as? String` 或 `.map { ... as? String }`（`[String?]` 可 Equatable），均不报错，不动。

- [ ] **7.7 运行测试，确认失败（Red）**

执行「模拟器测试命令」。预期编译失败：`cannot find 'OutboxStore' in scope`。此时只有测试、没有实现；不得为了让测试通过而修改测试。

---

### 7.8 写实现 `Sources/OutboxStore.swift` 通过测试（Green）

新增文件，完整内容：

```swift
import Foundation

final class OutboxStore {

    private static let fileName = "outbox.json"

    private let file: URL
    private let lock = NSLock()

    init(dataDir: URL) {
        self.file = dataDir.appendingPathComponent(Self.fileName)
    }

    func add(_ relPath: String?) throws {
        let rel = try normalize(relPath)
        lock.lock()
        defer { lock.unlock() }
        var entries = try read()
        if entries.contains(where: { ($0["relPath"] as? String) == rel }) { return }
        entries.append(["relPath": rel, "queuedAt": nowMillis()])
        try write(entries)
    }

    func remove(_ relPath: String?) {
        guard let relPath = relPath, !relPath.trimmingJava().isEmpty else { return }
        let rel = relPath.replacingOccurrences(of: "\\", with: "/")
        lock.lock()
        defer { lock.unlock() }
        guard var entries = try? read() else { return }
        var changed = false
        for k in stride(from: entries.count - 1, through: 0, by: -1) {
            if (entries[k]["relPath"] as? String) == rel {
                entries.remove(at: k)
                changed = true
            }
        }
        if changed { try? write(entries) }
    }

    func list() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return (try? read()) ?? []
    }

    func count() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return (try? read().count) ?? 0
    }

    func countByDoc() -> [String: Int] {
        lock.lock()
        defer { lock.unlock() }
        var counts: [String: Int] = [:]
        guard let entries = try? read() else { return counts }
        for e in entries {
            let rel = e["relPath"] as? String ?? ""
            guard let slashRange = rel.range(of: "/") else {
                counts["", default: 0] += 1
                continue
            }
            let work = String(rel[rel.startIndex..<slashRange.lowerBound])
            counts[work, default: 0] += 1
        }
        return counts
    }

    // MARK: - 归一化

    private func normalize(_ relPath: String?) throws -> String {
        guard let relPath = relPath else { throw PathGuard.bad("relPath 必须是字符串") }
        let rel = relPath.trimmingJava().replacingOccurrences(of: "\\", with: "/")
        if rel.isEmpty { throw PathGuard.bad("relPath 不得为空") }
        if rel.hasPrefix("/") { throw PathGuard.bad("拒绝绝对路径: \(relPath)") }
        if rel.hasSuffix("/") { throw PathGuard.bad("路径不得以分隔符结尾: \(relPath)") }
        for seg in try PathGuard.splitRel(rel) {
            try PathGuard.validateSegment(seg)
            if seg == "." || seg == ".." {
                throw PathGuard.bad("路径段不得为 . 或 ..: \(relPath)")
            }
        }
        return rel
    }

    // MARK: - 文件读写

    private func read() throws -> [[String: Any]] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        do {
            let raw = try Data(contentsOf: file)
            var text = String(decoding: raw, as: UTF8.self)
            if text.first == "\u{FEFF}" { text.removeFirst() }
            guard let parsed = try? JSONSerialization.jsonObject(
                with: Data(text.utf8), options: [.fragmentsAllowed]),
                let rawList = parsed as? [Any] else { return [] }
            var out: [[String: Any]] = []
            for o in rawList {
                guard let rawMap = o as? [String: Any],
                      let rel = rawMap["relPath"] as? String,
                      !rel.trimmingJava().isEmpty else { continue }
                let at: Int64
                if let n = rawMap["queuedAt"] as? NSNumber {
                    at = CFNumberIsFloatType(n as CFNumber)
                        ? Int64(n.doubleValue.rounded()) : n.int64Value
                } else {
                    at = 0
                }
                out.append(["relPath": rel, "queuedAt": at])
            }
            out.sort {
                ($0["queuedAt"] as? Int64 ?? 0) < ($1["queuedAt"] as? Int64 ?? 0)
            }
            return out
        } catch {
            return []
        }
    }

    private func write(_ entries: [[String: Any]]) throws {
        let parent = file.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: parent.path) {
            do {
                try FileManager.default.createDirectory(at: parent,
                                                        withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("无法创建数据目录: \(parent.path)")
            }
        }
        let json: Data
        do {
            json = try JSONSerialization.data(withJSONObject: entries, options: [.fragmentsAllowed])
        } catch {
            throw PathGuard.bad("写入 outbox 失败: \(error.localizedDescription)")
        }
        let tmp = parent.appendingPathComponent(Self.fileName + ".tmp")
        do {
            try json.write(to: tmp, options: .atomic)
            try move(tmp, file)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw PathGuard.bad("写入 outbox 失败: \(error.localizedDescription)")
        }
    }

    private func move(_ src: URL, _ dst: URL) throws {
        do {
            if FileManager.default.fileExists(atPath: dst.path) {
                try FileManager.default.removeItem(at: dst)
            }
            try FileManager.default.moveItem(at: src, to: dst)
        } catch let atomicError {
            do {
                _ = try FileManager.default.replaceItemAt(dst, withItemAt: src)
            } catch {
                throw atomicError
            }
        }
    }

    private func nowMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

private extension String {
    func trimmingJava() -> String {
        var scalars = Substring(self).unicodeScalars
        while let first = scalars.first, first.value <= 0x20 { scalars.removeFirst() }
        while let last = scalars.last, last.value <= 0x20 { scalars.removeLast() }
        return String(scalars)
    }
}
```

> 关于 `move` 的回退分支：Java 先尝试 `ATOMIC_MOVE + REPLACE_EXISTING`，失败后回退普通 `REPLACE_EXISTING`。Foundation 的 `moveItem` 在同卷上本就是原子 rename，但目标已存在时先删除再移动会引入一个极短的“目标不存在”窗口；`replaceItemAt` 对应 Java 的二次回退（非原子替换）。执行时若在该私法上有更贴合的写法，可在保持「先原子、失败回退替换、均失败抛错」语义的前提下微调，但**不得**改成直接覆写且无回退。

> **主控裁决（Task 13.3 首次 CI，2026-10-11）**：CI（Xcode 16.2，`-swift-version 5`）报 `OutboxStore.swift:152/156: cannot find 'atomicError' in scope`。省略 `let` 的 catch 简写绑定（`} catch atomicError {`）是 Swift 6 语言模式语法，Swift 5 模式不识别；上方围栏原文即如此，属围栏缺陷。已双侧改为 `} catch let atomicError {`（Swift 5 全版本合法，语义完全不变）。

移植要点（执行时不得偏离）：

- **错误风格**：`add`/`write` 对齐 Java 蓝本——`normalize` 五类错误与建目录/写盘失败一律 `throw PathGuard.bad(...)`（Java 侧为 `IllegalArgumentException`/`RuntimeException`）；调用方 `WcStorageBridge`（Task 8）负责吞掉 `add` 的异常。`remove`/`list`/`count`/`countByDoc` 永不抛：`remove` 内部 `try?` 吞掉读写错误（对齐 Java 该方法本身不声明抛出）。
- **临时文件名固定**为 `outbox.json.tmp`（与 AppDataStore 的 `<name>.tmp-<seq>` 不同，这是蓝本原样）；提交成功后不得残留。
- `normalize` 顺序逐字对齐 Java：`nil` → `relPath 必须是字符串`；trim（`trimmingJava()`，只裁 ≤ U+0020）并把 `\` 换 `/` 后为空 → `relPath 不得为空`；`/` 开头 → `拒绝绝对路径: <原串>`；`/` 结尾 → `路径不得以分隔符结尾: <原串>`；再经 `PathGuard.splitRel`/`validateSegment`（段名含禁用字符等错误信息来自 PathGuard），段为 `.`/`..` → `路径段不得为 . 或 ..: <原串>`。错误文案中拼接的是**入参原串 `relPath`**，不是归一化后的 `rel`。
- `remove` 对 `nil`/纯空白 no-op 且**不建文件**；只做 `\`→`/` 替换、**不 trim**（带空白的路径不匹配）；倒序遍历删除所有同值条目；`changed == false` 时不写盘（用 mtime 测试钉死）。
- `read` 宽容：文件缺失→空数组；JSON 损坏、根不是数组、任何读取异常→空数组；非 map 元素、`relPath` 非字符串或 trim 后为空一律跳过；`queuedAt` 非数字→`0`（Int64）；读出后按 `queuedAt` 升序稳定排序（同值保持插入序）。
- `list()` 返回全新数组（调用方 mutate 不影响内部状态——每次 read 都重新解析文件，天然满足）。
- `countByDoc` 对齐 Java `TreeMap`：work 为首个 `/` 之前的子串，`indexOf('/') <= 0`（无斜杠或斜杠在首位）归入空串键 `""`；返回普通 Swift 字典，测试按 `keys.sorted()` 断言顺序。
- 读入时剥离首字符 U+FEFF（`stripBom`）；数值解析按 NSNumber，浮点 queuedAt 四舍五入为 Int64（正常数据只会是整型毫秒）。

- [ ] **7.9 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`，OutboxStoreTests 全绿，且 PathGuardTests、WorkspaceStoreTests、AppDataStoreTests 不受影响。时间敏感断言（mtime、queuedAt）若同毫秒抖动，保留 sleep/排序比较，不得放宽。

- [ ] **7.10 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/OutboxStore.swift Tests/DSHRemoteTests/OutboxStoreTests.swift
git commit -m "feat(outbox): 一比一移植安卓 OutboxStore 发件箱"
```

---

## Task 8：BridgeDispatcher —— 全方法位置参数分发（业务编排，唯一分支点）

目标（蓝本 `WcStorageBridge.java`，385 行）：把 JS 的 `(method, args[])` 位置参数调用编排到 Task 5/6/7 的三个 Store 与本地番茄钟记录上。**本类是全工程唯一含业务方法分支的类型**；Task 9 的 `NativeBridge` 与 Task 10 的 `BridgeSyncSchemeHandler` 只做「收包 → 调本类 → 回包」。

与安卓蓝本的差异（刻意裁剪，spec §5.2/§5.5 与已拍板决策）：

1. **不实现** `scheduleReminder` / `cancelReminder` / `getDeviceId` / `notifyWriting` / `nativeOnline`（无本地提醒/通知/设备号需求；联网态由 web 层 `navigator.onLine` + ipad.js 回网编排承接）。JS 白名单仍保留这些方法名（Task 9 照抄安卓白名单以避免核心 JS 调用 undefined），分发器对它们统一返回 `{ok:true}`，**不报错**——对齐 `reportDirty` 等 no-op 的宽容形态，避免核心 JS 在 iPad 上弹错误 toast。
2. `state()` 覆盖 `platform:"ipad"`（安卓是 `"android"`），`root/rootExists` 用沙盒固定工作区；`appVersion` 来自 `Bundle`（测试注入固定串）。
3. iOS 组合点在本类：持有 `AppDataStore` + `WorkspaceStore` + `OutboxStore` 三实例（安卓 AppData 内部持 OutboxStore；iOS Task 7 已拆开）；`writeDoc/writeDocSync` 成功后内部 `outbox.add(relPath)`，异常吞掉（蓝本逐字语义）。
4. 入参形态：`dispatch(method, argsJson: String)` 对应安卓 `call`——解析 JSON 数组，非数组/损坏返回 `{ok:false,error:"参数必须是 JSON 数组: …"}`；另提供 `dispatch(method, args: [Any])` 对应蓝本包内 `dispatch`，供同步通道与测试直接调用。**绝不抛 JS 异常**：所有 throws 在 catch 中转 fail-map（`WorkspaceStore`/`OutboxStore` 是 throws 风格，`AppDataStore` 自带 fail-map）。
5. `appendPomodoro` 追加到 `<workspaceRoot>/番茄钟记录.md`；`countLines` 口径逐字移植（数 `\n`；末尾非换行则行数 = 换行数 + 1）；时间用固定时区 `Asia/Shanghai`（与服务端/PC 一致；安卓未设时区用设备默认，iPad 用户就在北京时区，显式写死更确定，测试用注入 Date 固定格式）。

- [ ] **8.1 先写失败测试 `Tests/DSHRemoteTests/BridgeDispatcherTests.swift`（Red）**

新增文件，完整内容：

```swift
import XCTest
@testable import DSHRemote

final class BridgeDispatcherTests: XCTestCase {

    var root: URL!
    var dispatcher: BridgeDispatcher!
    var pomoFile: URL { root.appendingPathComponent("番茄钟记录.md") }

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("BridgeTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        dispatcher = try BridgeDispatcher(dataDir: root.appendingPathComponent("data"),
                                          workspaceRoot: root,
                                          appVersion: "0.1.0-test",
                                          now: { Date(timeIntervalSince1970: 1_790_000_000) })
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    func call(_ method: String, _ args: [Any] = []) -> [String: Any] {
        dispatcher.dispatch(method, args: args)
    }

    func callJson(_ method: String, _ argsJson: String) -> [String: Any] {
        dispatcher.dispatch(method, argsJson: argsJson)
    }

    // MARK: - getState

    func testGetStateOverridesSandboxAndPlatform() {
        let s = call("getState")
        XCTAssertEqual(s["ok"] as? Bool, true)
        XCTAssertEqual(s["platform"] as? String, "ipad")
        XCTAssertEqual(s["root"] as? String, root.path)
        XCTAssertEqual(s["rootExists"] as? Bool, true)
        XCTAssertEqual(s["appVersion"] as? String, "0.1.0-test")
        XCTAssertEqual(s["settings"] == nil, false)
    }

    // MARK: - 工作区写入 + outbox 自动入队

    func testWriteDocEnqueuesOutbox() {
        let r = call("writeDoc", ["作品A/第一章.md", "正文"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        let box = call("outboxList")
        let items = box["entries"] as? [[String: Any]]
        XCTAssertEqual(items?.count, 1)
        XCTAssertEqual(items?[0]["relPath"] as? String, "作品A/第一章.md")
    }

    func testWriteDocSyncAlsoEnqueues() {
        XCTAssertEqual(call("writeDocSync", ["a.md", "x"])["ok"] as? Bool, true)
        XCTAssertEqual(call("outboxList")["entries"] == nil, false)
        XCTAssertEqual((call("outboxList")["entries"] as? [[String: Any]])?.count, 1)
    }

    func testWriteDocFailureDoesNotEnqueue() {
        let r = call("writeDoc", ["/绝对.md", "x"])
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertEqual((call("outboxList")["entries"] as? [[String: Any]])?.count, 0)
    }

    func testOutboxRemove() {
        call("writeDoc", ["a.md", "x"])
        XCTAssertEqual(call("outboxRemove", ["a.md"])["ok"] as? Bool, true)
        XCTAssertEqual((call("outboxList")["entries"] as? [[String: Any]])?.count, 0)
    }

    // MARK: - 工作区只读方法透传

    func testWorkspaceRoundTripThroughDispatcher() {
        XCTAssertEqual(call("createWork", ["作品B"])["ok"] as? Bool, true)
        XCTAssertEqual(call("createDoc", ["作品B", "第二章"])["ok"] as? Bool, true)
        let ws = call("listWorkspace")
        XCTAssertEqual(ws["ok"] as? Bool, true)
        let read = call("readDoc", ["作品B/第二章.md"])
        XCTAssertEqual(read["ok"] as? Bool, true)
    }

    // MARK: - 草稿经沙盒 root

    func testDraftUsesSandboxRootAndRoundTrips() {
        let w = call("writeDraft", ["作品A/x.md", "草稿内容"])
        XCTAssertEqual(w["ok"] as? Bool, true)
        let r = call("readDraft", ["作品A/x.md"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertTrue((r["content"] as? String ?? "").contains("草稿内容"))
        XCTAssertEqual(call("clearDraft", ["作品A/x.md"])["ok"] as? Bool, true)
    }

    func testDraftsUsageAndPending() {
        XCTAssertEqual(call("draftsUsage")["ok"] as? Bool, true)
        XCTAssertEqual(call("listPendingDrafts")["ok"] as? Bool, true)
    }

    // MARK: - 配置 / 会话 / 校对 / 基线

    func testSaveConfigAndProofAndBaseline() {
        XCTAssertEqual(call("saveConfig", [["pomodoro": ["focusMin": 500]]])["ok"] as? Bool,
                       true)
        XCTAssertEqual((call("getState")["pomodoro"] as? [String: Any])?["focusMin"] as? Int64,
                       180)
        XCTAssertEqual(call("proofSave", [["relPath": "a.md", "items": []]])["ok"] as? Bool,
                       true)
        XCTAssertEqual(call("proofLoad", ["a.md"])["ok"] as? Bool, true)
        XCTAssertEqual(call("getLastSession")["ok"] as? Bool, true)
        XCTAssertEqual(call("syncBaseline")["ok"] as? Bool, true)
        XCTAssertEqual(call("syncBaselineSet", [["version": 1, "items": [:]]])["ok"] as? Bool,
                       true)
    }

    // MARK: - hash12

    func testHash12Bridge() {
        let r = call("hash12", ["abc"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["hash"] as? String, "a9993e364706")
        let empty = call("hash12", [])
        XCTAssertEqual(empty["hash"] as? String, "da39a3ee5e6b")
    }

    // MARK: - appendPomodoro

    func testAppendPomodoroWritesFirstLine() throws {
        let r = call("appendPomodoro", [["focusMin": 25, "doc": "第一章"]])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["line"] as? Int64, 1)
        XCTAssertEqual(r["file"] as? String, pomoFile.path)
        let text = try String(contentsOf: pomoFile, encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("1. "))
        XCTAssertTrue(text.contains("· 专注 25 分钟 · 第一章"))
        XCTAssertTrue(text.hasSuffix("\n"))
    }

    func testAppendPomodoroDefaultsFocusAndNoDoc() throws {
        call("appendPomodoro", [[:]])
        let text = try String(contentsOf: pomoFile, encoding: .utf8)
        XCTAssertTrue(text.contains("· 专注 25 分钟"))
        XCTAssertFalse(text.contains("· 专注 25 分钟 ·"))
    }

    func testAppendPomodoroIncrementsLines() {
        call("appendPomodoro", [[:]])
        let r2 = call("appendPomodoro", [[:]])
        XCTAssertEqual(r2["line"] as? Int64, 2)
    }

    func testAppendPomodoroRejectsNonMapPayload() {
        let r = call("appendPomodoro", [42])
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertTrue((r["error"] as? String ?? "").contains("payload 必须是对象"))
    }

    // MARK: - 生命周期 no-op 与 iOS 裁剪方法

    func testLifecycleCallbacksAreOkNoOps() {
        for m in ["reportDirty", "onFlushRequest", "flushDone", "relaunch",
                  "scheduleReminder", "cancelReminder", "getDeviceId",
                  "notifyWriting", "nativeOnline"] {
            let r = call(m)
            XCTAssertEqual(r["ok"] as? Bool, true, "方法 \(m) 应为宽容 no-op")
            XCTAssertNil(r["error"])
        }
    }

    // MARK: - 不支持的目录/导入方法

    func testPickAndImportAreNotSupported() {
        for m in ["pickRoot", "pickDir", "pickImportFiles", "pickImportDir",
                  "importInto", "onImportProgress"] {
            let r = call(m)
            XCTAssertEqual(r["ok"] as? Bool, false)
            XCTAssertTrue((r["error"] as? String ?? "").hasPrefix("NotSupported:"))
        }
    }

    // MARK: - 未知方法 / 空方法名 / JSON 入参

    func testUnknownMethodFails() {
        let r = call("noSuchMethod")
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "未知方法: noSuchMethod")
    }

    func testEmptyMethodNameFails() {
        XCTAssertEqual(call("")["error"] as? String, "未知方法: ")
    }

    func testArgsJsonArrayParsed() {
        let r = callJson("writeDoc", "[\"j.md\",\"通过 JSON\"]")
        XCTAssertEqual(r["ok"] as? Bool, true)
    }

    func testArgsJsonNonArrayFailsWithPrefix() {
        let r = callJson("getState", "{\"a\":1}")
        XCTAssertTrue((r["error"] as? String ?? "").hasPrefix("参数必须是 JSON 数组"))
    }

    func testArgsJsonCorruptFailsWithPrefix() {
        let r = callJson("getState", "[1,2")
        XCTAssertTrue((r["error"] as? String ?? "").hasPrefix("参数必须是 JSON 数组"))
    }

    func testArgsJsonNullBecomesEmptyArgs() {
        XCTAssertEqual(callJson("getState", "null")["ok"] as? Bool, true)
    }

    // MARK: - 底层 throws 不外泄

    func testThrowingStoreMethodBecomesFailMap() {
        let r = call("readDoc", ["../逃逸.md"])
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertFalse((r["error"] as? String ?? "").isEmpty)
    }
}
```

说明：`dispatch(_:argsJson:)` 对 `null` 按安卓 `MiniJson.parse("null")` 非 List → 空数组处理（蓝本 `parsed instanceof List ? … : new ArrayList<>()`，注意与 `directDispatch` 的 String 分支不同——`call` 入口的裸字符串不是数组也按空数组）；`now:` 闭包仅用于番茄钟行内时间，测试注入固定 Date，断言只校验固定文本片段（`1. ` 前缀、`· 专注 25 分钟`），不断言完整日期避免时区脆弱。

- [ ] **8.2 运行测试，确认失败（Red）**

执行「模拟器测试命令」。预期编译失败：`cannot find 'BridgeDispatcher' in scope`。

---

- [ ] **8.3 写实现 `Sources/BridgeDispatcher.swift` 通过测试（Green）**

新增文件，完整内容：

```swift
import Foundation

final class BridgeDispatcher {

    private let workspaceRoot: URL
    private let appVersion: String
    private let appData: AppDataStore
    private let workspace: WorkspaceStore
    private let outbox: OutboxStore
    private let ioLock = NSLock()
    private let now: () -> Date

    init(dataDir: URL, workspaceRoot: URL, appVersion: String,
         now: @escaping () -> Date = Date.init) throws {
        self.workspaceRoot = workspaceRoot
        self.appVersion = appVersion
        self.now = now
        let fm = FileManager.default
        if !fm.fileExists(atPath: dataDir.path) {
            do {
                try fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("无法创建数据目录: \(dataDir.path)")
            }
        }
        if !fm.fileExists(atPath: workspaceRoot.path) {
            do {
                try fm.createDirectory(at: workspaceRoot, withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("无法创建工作区目录: \(workspaceRoot.path)")
            }
        }
        self.appData = AppDataStore(dataDir: dataDir)
        self.workspace = WorkspaceStore(root: workspaceRoot)
        self.outbox = OutboxStore(dataDir: dataDir)
    }

    // MARK: - 两个入口

    func dispatch(_ method: String?, argsJson: String?) -> [String: Any] {
        let parsed: Any?
        do {
            parsed = try JSONSerialization.jsonObject(
                with: Data((argsJson ?? "[]").utf8), options: [.fragmentsAllowed])
        } catch {
            return Self.fail("参数必须是 JSON 数组: \(error.localizedDescription)")
        }
        let args = (parsed as? [Any]) ?? []
        return dispatch(method, args: args)
    }

    func dispatch(_ method: String?, args: [Any]) -> [String: Any] {
        ioLock.lock()
        defer { ioLock.unlock() }
        do {
            switch method ?? "" {
            case "getState":
                return state()
            case "listWorkspace":
                return try workspace.listWorkspace()
            case "readDoc":
                return try workspace.readDoc(relPath: str(args, 0))
            case "writeDoc", "writeDocSync":
                return try writeDoc(str(args, 0), args.count > 1 ? asString(args[1]) : nil)
            case "createWork":
                return try workspace.createWork(str(args, 0))
            case "createDoc":
                return try workspace.createDoc(work: str(args, 0),
                                               name: args.count > 1 ? asString(args[1]) : "")
            case "renameWork":
                return try workspace.renameWork(oldName: str(args, 0), newName: str(args, 1))
            case "renameDoc":
                return try workspace.renameDoc(work: str(args, 0),
                                               oldName: str(args, 1),
                                               newName: str(args, 2))
            case "moveDoc":
                return try workspace.moveDoc(fromWork: str(args, 0),
                                             name: str(args, 1),
                                             toWork: str(args, 2))
            case "trashDoc":
                return try workspace.trashDoc(work: str(args, 0), name: str(args, 1))
            case "trashWork":
                return try workspace.trashWork(name: str(args, 0))
            case "listTrash":
                return try workspace.listTrash()
            case "restoreTrash":
                return try workspace.restoreTrash(relPath: str(args, 0))
            case "purgeTrash":
                return try workspace.purgeTrash(relPath: str(args, 0))
            case "saveConfig":
                return appData.saveConfig(args.isEmpty ? [:] : asMap(args[0]))
            case "writeDraft", "writeDraftSync":
                return appData.writeDraft(root: workspaceRoot.path,
                                          relPath: str(args, 0),
                                          content: args.count > 1 ? asString(args[1]) : nil)
            case "readDraft":
                return appData.readDraft(root: workspaceRoot.path, relPath: str(args, 0))
            case "clearDraft":
                return appData.clearDraft(root: workspaceRoot.path, relPath: str(args, 0))
            case "listPendingDrafts":
                return appData.listPendingDrafts(root: workspaceRoot.path)
            case "draftsUsage":
                return appData.draftsUsage()
            case "getLastSession":
                return appData.readLastSession()
            case "proofSave":
                return appData.proofSave(root: workspaceRoot.path,
                                         payload: args.isEmpty ? [:] : asMap(args[0]))
            case "proofLoad":
                return appData.proofLoad(root: workspaceRoot.path,
                                         relPath: str(args, 0))
            case "syncBaseline":
                return appData.readBaseline()
            case "syncBaselineSet":
                return appData.writeBaseline(args.isEmpty ? [:] : asMap(args[0]))
            case "appendPomodoro":
                return try appendPomodoro(args.isEmpty ? nil : args[0])
            case "outboxList":
                return ["ok": true, "entries": outbox.list()]
            case "outboxRemove":
                outbox.remove(str(args, 0))
                return okMap()
            case "hash12":
                return ["ok": true,
                        "hash": AppDataStore.hash12(args.isEmpty ? "" : asString(args[0]))]
            case "reportDirty", "onFlushRequest", "flushDone", "relaunch",
                 "scheduleReminder", "cancelReminder", "getDeviceId",
                 "notifyWriting", "nativeOnline":
                return okMap()
            case "pickRoot", "pickDir", "pickImportFiles", "pickImportDir",
                 "importInto", "onImportProgress":
                return Self.unsupported()
            default:
                return Self.fail("未知方法: \(method ?? "")")
            }
        } catch {
            return Self.fail(error.localizedDescription)
        }
    }

    // MARK: - 编排私法

    private func state() -> [String: Any] {
        var s = appData.getState()
        s["root"] = workspaceRoot.path
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: workspaceRoot.path,
                                                    isDirectory: &isDir)
        s["rootExists"] = exists && isDir.boolValue
        s["platform"] = "ipad"
        s["appVersion"] = appVersion
        return s
    }

    private func writeDoc(_ relPath: String, _ content: String?) throws -> [String: Any] {
        let r = try workspace.writeDoc(relPath: relPath, content: content)
        if r["ok"] as? Bool == true {
            do {
                try outbox.add(relPath)
            } catch {
                // 对齐蓝本：入队失败不影响写入结果
            }
        }
        return r
    }

    private func appendPomodoro(_ payloadObj: Any?) throws -> [String: Any] {
        guard let payload = payloadObj as? [String: Any] else {
            throw PathGuard.bad("payload 必须是对象")
        }
        let focusMin: Int64
        if let n = payload["focusMin"] as? NSNumber {
            focusMin = CFNumberIsFloatType(n as CFNumber)
                ? Int64(n.doubleValue.rounded()) : n.int64Value
        } else {
            focusMin = 25
        }
        let doc = (payload["doc"] as? String) ?? ""

        let record = workspaceRoot.appendingPathComponent("番茄钟记录.md")
        let fm = FileManager.default
        try fm.createDirectory(at: record.deletingLastPathComponent(),
                               withIntermediateDirectories: true)
        let prev = fm.fileExists(atPath: record.path)
            ? (try? String(contentsOf: record, encoding: .utf8)) ?? "" : ""
        let line: Int64 = prev.isEmpty ? 1 : countLines(prev) + 1
        let stamp = Self.pomodoroFormatter.string(from: now())
        var row = "\(line). \(stamp) · 专注 \(focusMin) 分钟"
        if !doc.isEmpty { row += " · \(doc)" }
        row += "\n"
        let rowData = Data(row.utf8)
        if fm.fileExists(atPath: record.path),
           let h = try? FileHandle(forWritingTo: record) {
            defer { try? h.close() }
            try h.seekToEnd()
            try h.write(contentsOf: rowData)
        } else {
            try rowData.write(to: record, options: .atomic)
        }
        return ["ok": true, "file": record.path, "line": line]
    }

    private static let pomodoroFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Shanghai")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f
    }()

    private func countLines(_ s: String) -> Int64 {
        var n: Int64 = 0
        for ch in s where ch == "\n" { n += 1 }
        if s.isEmpty || s.last != "\n" { n += 1 }
        return n
    }

    // MARK: - 参数/返回工具

    private func str(_ args: [Any], _ i: Int) -> String {
        i < args.count ? (asString(args[i]) ?? "") : ""
    }

    private func asString(_ o: Any?) -> String? {
        guard let o = o else { return nil }
        if let s = o as? String { return s }
        if o is NSNull { return nil }
        return String(describing: o)
    }

    private func asMap(_ o: Any?) -> [String: Any] {
        (o as? [String: Any]) ?? [:]
    }

    private func okMap() -> [String: Any] { ["ok": true] }

    private static func fail(_ msg: String?) -> [String: Any] {
        ["ok": false, "error": msg ?? "未知错误"]
    }

    private static func unsupported() -> [String: Any] {
        ["ok": false, "error": "NotSupported: iPad v1 不支持选目录/导入"]
    }
}
```

> 蓝本 `unsupported()` 文案是 `NotSupported: 安卓 v1 不支持选目录/导入`；iOS 侧按平台改为 `NotSupported: iPad v1 不支持选目录/导入`（JS 只按 `ok===false` 与 `NotSupported:` 前缀分支，文案后缀无契约依赖）。`rootExists` 用 `fileExists(atPath:isDirectory:)` 同时取存在位与目录位，对齐 Java `isDirectory()`。
>
> 关于 `String(describing:)`：仅用于 JS 传来的非字符串标量（数字/布尔）转字符串，对齐 Java `String.valueOf`；`NSNull` 归为 nil（对齐 Java null）。正常调用点（relPath/doc/text）传的都是字符串。

- [ ] **8.4 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`，BridgeDispatcherTests 全绿且前序四个测试文件不受影响。若 `countLines` 相关用例失败，先核对 `prev` 末尾换行语义（蓝本：末尾恰为 `\n` 时不加一），不得改测试。

- [ ] **8.5 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/BridgeDispatcher.swift Tests/DSHRemoteTests/BridgeDispatcherTests.swift
git commit -m "feat(bridge): 一比一移植 WcStorageBridge 分发并编排 outbox 与番茄钟"
```

---

## Task 9：NativeBridge 异步消息桥 + BridgeJS document-start 注入 + ShellWebView 接线

目标（spec §5.1 A、§5.3）：把 Task 8 的纯 Swift 分发器接到 WKWebView 上。三件事：

1. `NativeBridge`（`WKScriptMessageHandler`，name `dshBridge`）：主线程收 `{id, method, args}`（或已 JSON 化的等价形态），后台串行队列执行 `dispatcher.dispatch(method, args:)`，回主线程经 `evaluateJavaScript("globalThis.__dshBridgeResolve(...)")` 应答。**本类型不含任何业务分支**（职责铁律）。
2. `BridgeJS`：document-start 注入 JS 字符串。白名单集合、`wcStorage` Proxy、允许壳层 function 覆写——**照抄** `MainActivity.INJECT_DOC_START`（行 108-152）；唯一实质差异是 `nativeCall` 由「同步 `__wcNative.call` + `Promise.resolve`」改为「postMessage 配对 + Promise + 10 s 超时」，两个 `*Sync` 方法走 Task 10 的同步 XHR（本 Task 的注入 JS 已把同步通道调用写好，scheme handler 在 Task 10 落地）。另在注入末尾定义**窄** `window.wcWriting = { kind:'ipad', hash12: text => nativeCallAsync('hash12',[text]) }`——理由见 9.4 注。
3. 改 `ShellWebView.swift`：注册 `dsh-asset` scheme（主壳 WebView 此前从未注册，Task 4 只接管了导航）、注入 `BridgeJS.source`、挂载 `dshBridge` 消息 handler、生产环境用 Documents 沙盒构造 `BridgeDispatcher`（工作区根 `Documents/workspace`，对齐 spec §6.1 与安卓 `new File(getFilesDir(),"workspace")`）。

线程模型（spec §5.3）：WKScriptMessageHandler 回调在主线程；IO 派到 `DispatchQueue(label:"dsh.bridge.io")` 串行队列（等价安卓 `synchronized(ioLock)`；BridgeDispatcher 内还有 NSLock 双保险，同步通道 Task 10 在 WebKit 回调线程上同用一个分发器实例）；应答必须回主线程 `evaluateJavaScript`。

- [ ] **9.1 先写失败测试 `Tests/DSHRemoteTests/NativeBridgeTests.swift`（Red）**

`NativeBridge` 设计为**不依赖 WKWebView 的可测内核**：入参/应答以纯 Swift 形态收发（`handle(body:)` 解包包体并入队派发，`replyScript(id:json:)` 生成应答脚本字符串；`WKScriptMessage` 只在薄适配层解包）。新增文件，完整内容：

```swift
import XCTest
@testable import DSHRemote

final class NativeBridgeTests: XCTestCase {

    var root: URL!
    var dispatcher: BridgeDispatcher!
    var sent: [(id: Any, json: String)]!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("NativeBridgeTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        dispatcher = try BridgeDispatcher(dataDir: root.appendingPathComponent("data"),
                                          workspaceRoot: root,
                                          appVersion: "0.1.0-test")
        sent = []
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    func makeBridge() -> NativeBridge {
        NativeBridge(dispatcher: dispatcher,
                     reply: { [weak self] id, json in self?.sent.append((id, json)) })
    }

    func drain(_ bridge: NativeBridge) {
        let done = expectation(description: "io drained")
        bridge.barrier { done.fulfill() }
        wait(for: [done], timeout: 5)
    }

    // MARK: - 解包入参

    func testDictionaryBodyDispatches() {
        let b = makeBridge()
        b.handle(body: ["id": 7, "method": "getState", "args": []])
        drain(b)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0].id as? Int, 7)
        let o = (try? JSONSerialization.jsonObject(with: Data(sent[0].json.utf8)) as? [String: Any]) ?? [:]
        XCTAssertEqual(o["ok"] as? Bool, true)
        XCTAssertEqual(o["platform"] as? String, "ipad")
    }

    func testJsonStringBodyDispatches() {
        let b = makeBridge()
        b.handle(body: #"{"id":8,"method":"getState","args":[]}"#)
        drain(b)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0].id as? Int, 8)
        XCTAssertTrue(sent[0].json.contains("\"ok\":true"))
    }

    func testPositionalArgsReachDispatcher() {
        let b = makeBridge()
        b.handle(body: ["id": 1, "method": "writeDoc", "args": ["作品A/第一章.md", "正文"]])
        drain(b)
        let box: [String: Any] = dispatcher.dispatch("outboxList", args: [])
        let entries = box["entries"] as? [[String: Any]]
        XCTAssertEqual(entries?.count, 1)
        XCTAssertEqual(entries?.first?["relPath"] as? String, "作品A/第一章.md")
    }

    func testArgsMissingBecomesEmptyArray() {
        let b = makeBridge()
        b.handle(body: ["id": 2, "method": "getState"])
        drain(b)
        XCTAssertEqual(sent.count, 1)
    }

    // MARK: - 畸形包不崩溃、不应答

    func testNonDictionaryBodyIgnored() {
        let b = makeBridge()
        b.handle(body: 42)
        b.handle(body: ["method", "getState"])
        b.handle(body: NSNull())
        b.handle(body: nil)
        XCTAssertEqual(sent.count, 0)
    }

    func testMissingIdIgnored() {
        let b = makeBridge()
        b.handle(body: ["method": "getState", "args": []])
        XCTAssertEqual(sent.count, 0)
    }

    func testInvalidJsonStringIgnored() {
        let b = makeBridge()
        b.handle(body: #"{"id":1,"method":"getState""#)
        XCTAssertEqual(sent.count, 0)
    }

    func testNonArrayArgsIgnored() {
        let b = makeBridge()
        b.handle(body: ["id": 3, "method": "getState", "args": "not-array"])
        XCTAssertEqual(sent.count, 0)
    }

    // MARK: - 应答脚本

    func testReplyScriptCallsGlobalResolverWithNumericId() {
        let script = NativeBridge.replyScript(id: 9, json: #"{"ok":true}"#)
        XCTAssertEqual(script, #"globalThis.__dshBridgeResolve(9, {"ok":true});"#)
    }

    func testReplyScriptQuotesStringId() {
        let script = NativeBridge.replyScript(id: "abc", json: #"{"ok":true}"#)
        XCTAssertEqual(script, #"globalThis.__dshBridgeResolve("abc", {"ok":true});"#)
    }

    func testIdEmbeddedWithJsonLiteralEncoding() {
        let script = NativeBridge.replyScript(id: "a\nb", json: "{}")
        XCTAssertTrue(script.contains(#""a\nb""#))
        XCTAssertFalse(script.contains("\n"))
    }

    func testReplyJsonIsAlwaysParseableObject() {
        let b = makeBridge()
        b.handle(body: ["id": 1, "method": "未知方法XYZ", "args": []])
        drain(b)
        XCTAssertEqual(sent.count, 1)
        let reparsed = (try? JSONSerialization.jsonObject(
            with: Data(sent[0].json.utf8)) as? [String: Any]) ?? [:]
        XCTAssertEqual(reparsed["ok"] as? Bool, false)
        XCTAssertTrue((reparsed["error"] as? String ?? "").contains("未知方法"))
    }

    // MARK: - 入参 JSON 字符串转义（防注入）

    func testContentWithScriptBreakingCharsRoundTrips() {
        let b = makeBridge()
        let evil = "</script>\"'\n\r\t\u{2028}中文"
        b.handle(body: ["id": 5, "method": "writeDoc", "args": ["a.md", evil]])
        drain(b)
        XCTAssertEqual(sent.count, 1)
        let r = dispatcher.dispatch("readDoc", args: ["a.md"])
        XCTAssertEqual(r["content"] as? String, evil)
    }

    // MARK: - 同步执行语义（测试队列同步等待；生产队列串行）

    func testIOIsSerializedViaQueue() {
        let b = makeBridge()
        let done = expectation(description: "100 calls drained")
        for i in 0..<100 {
            b.handle(body: ["id": i, "method": "hash12", "args": ["x\(i)"]])
        }
        b.barrier { done.fulfill() }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(sent.count, 100)
        let ids = Set(sent.map { "\($0.id)" })
        XCTAssertEqual(ids.count, 100)
    }
}
```

说明：`reply` 闭包替代真实 `evaluateJavaScript`（生产实现里是 `webView.evaluateJavaScript(replyScript)`，必须在主线程）；`barrier(_:)` 暴露队列排空点，仅测试用。`WKScriptMessage.body` 解包本身极薄（9.3 实现中直接调 `handle(body:)`），不为它写 WKWebView 集成测试（模拟器集成成本高、价值低；S3/真机验收覆盖）。

> **主控裁决（Task 13.3 第三、四次 CI，2026-10-11）**：围栏原样两处断言 `let o = try? JSONSerialization.jsonObject(...) as? [String: Any]` 后用 `o??["ok"]` 访问。第三次 CI 报 46/47/130/131 `cannot use optional chaining on non-optional value of type '[String : Any]'`（列号 26，指向**第二级** `?`）；主控初次修复只消除了双可选链——加 `?? [:]` 兜底却保留访问处的单可选链 `o?[...]`，第四次 CI（run 38127216109）同列再报（列号随列移动变为 25），证伪初次判断。准确根因：`(try? expr as? [String: Any]) ?? [:]` 经 `??` 的重载 `(T?, @autoclosure () -> T) -> T` 以**非可选**默认值 `[:]` 解包，`o` 的类型是非可选 `[String: Any]`（对照 BridgeSyncSchemeHandlerTests.json() 与 AppDataStoreTests.dict() 均显式标注 `-> [String: Any]` 后用直接下标，是本仓正确范式）。最终双侧形态：`let o = (try? ... as? [String: Any]) ?? [:]` + **直接下标** `o["ok"]`（reparsed 同理 4 行）；解析失败时对空字典取值为 nil，`as?` 断言失败，测试行为不变。教训：`?? 非可选默认值` 已完成解包，后续不得再挂可选链。

- [ ] **9.2 运行测试，确认失败（Red）**

执行「模拟器测试命令」。预期编译失败：`cannot find 'NativeBridge' in scope`。

- [ ] **9.3 写实现 `Sources/NativeBridge.swift` 通过测试（Green 第一半）**

新增文件，完整内容：

```swift
import Foundation
import WebKit

final class NativeBridge: NSObject, WKScriptMessageHandler {

    private let dispatcher: BridgeDispatcher
    private let ioQueue: DispatchQueue
    private let reply: (Any, String) -> Void

    init(dispatcher: BridgeDispatcher,
         reply: @escaping (Any, String) -> Void,
         ioQueue: DispatchQueue = DispatchQueue(label: "dsh.bridge.io")) {
        self.dispatcher = dispatcher
        self.reply = reply
        self.ioQueue = ioQueue
    }

    convenience init(dispatcher: BridgeDispatcher, webView: WKWebView) {
        self.init(dispatcher: dispatcher, reply: { [weak webView] id, json in
            let script = Self.replyScript(id: id, json: json)
            if Thread.isMainThread {
                webView?.evaluateJavaScript(script)
            } else {
                DispatchQueue.main.async { webView?.evaluateJavaScript(script) }
            }
        })
    }

    // MARK: - WKScriptMessageHandler（薄适配：主线程收包）

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "dshBridge" else { return }
        handle(body: message.body)
    }

    // MARK: - 可测内核（不依赖 WebKit）

    func handle(body: Any?) {
        let packet: [String: Any]
        if let dict = body as? [String: Any] {
            packet = dict
        } else if let text = body as? String,
                  let parsed = try? JSONSerialization.jsonObject(
                    with: Data(text.utf8), options: [.fragmentsAllowed]),
                  let dict = parsed as? [String: Any] {
            packet = dict
        } else {
            return
        }
        guard let id = packet["id"], !(id is NSNull) else { return }
        guard let method = packet["method"] as? String else { return }
        let args: [Any]
        if let present = packet["args"] {
            guard let array = present as? [Any] else { return }
            args = array
        } else {
            args = []
        }
        ioQueue.async {
            let result = self.dispatcher.dispatch(method, args: args)
            let json = Self.encode(result)
            DispatchQueue.main.async { self.reply(id, json) }
        }
    }

    func barrier(_ work: @escaping () -> Void) {
        ioQueue.async(flags: .barrier) {
            DispatchQueue.main.async(execute: work)
        }
    }

    // MARK: - 应答脚本（id 与 json 都经 JSON 字面量编码，杜绝脚本注入）

    static func replyScript(id: Any, json: String) -> String {
        let idLiteral = jsLiteral(id)
        return "globalThis.__dshBridgeResolve(\(idLiteral), \(json));"
    }

    static func encode(_ map: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: map))
            ?? Data(#"{"ok":false,"error":"应答序列化失败"}"#.utf8)
        return String(data: data, encoding: .utf8) ?? #"{"ok":false,"error":"应答序列化失败"}"#
    }

    private static func jsLiteral(_ value: Any) -> String {
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                return n.boolValue ? "true" : "false"
            }
            return n.stringValue
        }
        if value is NSNull { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: value,
                                                  options: [.fragmentsAllowed]),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return "null"
    }
}
```

要点：① `reply` 总在主线程调用（`ioQueue.async` 回主线程）；生产 `evaluateJavaScript` 的错误不处理（页面已跳走时 WebKit 静默失败，对齐安卓 `evaluateJavascript(..., null)`）。② id 只接受 JSON 标量（JS 侧恒为递增数字），字符串 id 经 `JSONSerialization` 加引号并转义换行/引号/U+2028-U+2029（`fragmentsAllowed` 对字符串产出带引号字面量）。③ `json` 由 `JSONSerialization` 产出，中文默认不转义但仍是合法 JS 字面量；`</script>` 在 `evaluateJavaScript` 路径无 HTML 解析风险（同步 XHR 通道不经过这里）。④ 畸形包一律静默丢弃（JS 侧 10 s 超时兜底，且页面自己的 bug 不应炸原生）。

- [ ] **9.4 先写 `Tests/DSHRemoteTests/BridgeJSTests.swift`（注入 JS 的结构与行为断言，Red 第二半）**

注入 JS 是与 web 核心的契约面，必须有单测钉死白名单与运行行为。完整内容：

```swift
import XCTest
import JavaScriptCore
@testable import DSHRemote

final class BridgeJSTests: XCTestCase {

    var ctx: JSContext!
    var posted: [[String: Any]]!
    var syncCalls: [[String: Any]]!

    override func setUp() {
        super.setUp()
        ctx = JSContext()
        posted = []
        syncCalls = []
        ctx.exceptionHandler = { _, ex in
            XCTFail("JS 异常: \(ex?.toString() ?? "-")")
        }
        // postMessage 桩：抓取异步通道包
        let post: @convention(block) (JSValue?) -> Void = { [weak self] msg in
            if let d = msg?.toDictionary() as? [String: Any] { self?.posted.append(d) }
        }
        let handlers = JSValue(newObjectIn: ctx)
        let dsh = JSValue(newObjectIn: ctx)
        dsh?.setObject(JSValue(object: post, in: ctx), forKeyedSubscript: "postMessage" as NSString)
        handlers?.setObject(dsh, forKeyedSubscript: "dshBridge" as NSString)
        let webkit = JSValue(newObjectIn: ctx)
        webkit?.setObject(handlers, forKeyedSubscript: "messageHandlers" as NSString)
        ctx.setObject(webkit, forKeyedSubscript: "webkit" as NSString)
        // 同步 XHR 桩：Task 10 的 dsh-bridge://sync 行为在此模拟
        let xhrCtor: @convention(block) () -> JSValue? = { [weak self] in
            let x = JSValue(newObjectIn: self?.ctx)
            x?.setObject(true, forKeyedSubscript: "isDSHSync" as NSString)
            x?.setObject(200, forKeyedSubscript: "status" as NSString)
            x?.setObject(JSValue(object: { (method: String, url: String, async: Bool) in
                x?.setObject(url, forKeyedSubscript: "__url" as NSString)
                x?.setObject(async, forKeyedSubscript: "__async" as NSString)
            } as @convention(block) (String, String, Bool) -> Void, in: self?.ctx),
                forKeyedSubscript: "open" as NSString)
            x?.setObject(JSValue(object: { (body: String) in
                guard let data = body.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { return }
                self?.syncCalls.append(parsed)
                let m = parsed["method"] as? String ?? ""
                let resp: [String: Any]
                if m == "writeDocSync" { resp = ["ok": true, "mtime": 123, "bytes": 3] }
                else if m == "writeDraftSync" { resp = ["ok": true, "key": "k"] }
                else { resp = ["ok": false, "error": "only-sync-methods"] }
                let d = (try? JSONSerialization.data(withJSONObject: resp)) ?? Data()
                x?.setObject(String(data: d, encoding: .utf8),
                             forKeyedSubscript: "responseText" as NSString)
            } as @convention(block) (String) -> Void, in: self?.ctx),
                forKeyedSubscript: "send" as NSString)
            return x
        }
        ctx.setObject(JSValue(object: xhrCtor, in: ctx), forKeyedSubscript: "XMLHttpRequest" as NSString)
        // JSC 不自带 window 自引用（WKWebView 里有）；注入脚本以 window/globalThis 并用
        ctx.evaluateScript("if (!globalThis.window) { globalThis.window = globalThis; }")
        ctx.evaluateScript(BridgeJS.source)
    }

    // MARK: - 结构断言（字符串契约）

    func testOwnsHostDeclared() {
        XCTAssertTrue(BridgeJS.source.contains("globalThis.__DSH_TRANSPORT__ = { ownsHost: true }"))
    }

    func testResolverAndPostMessageContract() {
        XCTAssertTrue(BridgeJS.source.contains("globalThis.__dshBridgeResolve ="))
        XCTAssertTrue(BridgeJS.source.contains("window.webkit.messageHandlers.dshBridge.postMessage"))
    }

    func testTenSecondTimeout() {
        XCTAssertTrue(BridgeJS.source.contains("10000"))
    }

    func testSyncChannelPostsToBridgeScheme() {
        XCTAssertTrue(BridgeJS.source.contains("dsh-bridge://sync"))
    }

    func testAllAndroidApiMethodsPresent() {
        let expected = [
            "getState", "listWorkspace", "readDoc", "writeDoc", "writeDocSync",
            "createWork", "createDoc", "renameWork", "renameDoc", "moveDoc",
            "trashDoc", "trashWork", "listTrash", "restoreTrash", "purgeTrash",
            "saveConfig", "writeDraft", "writeDraftSync", "readDraft", "clearDraft",
            "listPendingDrafts", "draftsUsage", "getLastSession", "proofSave", "proofLoad",
            "syncBaseline", "syncBaselineSet", "appendPomodoro", "outboxList", "outboxRemove",
            "nativeOnline", "reportDirty", "onFlushRequest", "flushDone", "relaunch",
            "scheduleReminder", "cancelReminder", "getDeviceId", "hash12",
            "pickRoot", "pickDir", "pickImportFiles", "pickImportDir", "importInto",
            "onImportProgress", "notifyWriting"
        ]
        XCTAssertEqual(expected.count, 46)
        for m in expected {
            XCTAssertTrue(BridgeJS.source.contains(m), "白名单缺少 \(m)")
        }
    }

    func testWcWritingShimExposesHash12() {
        XCTAssertTrue(BridgeJS.source.contains("window.wcWriting"))
        XCTAssertTrue(BridgeJS.source.contains("kind: 'ipad'"))
        XCTAssertTrue(BridgeJS.source.contains("hash12"))
    }

    // MARK: - 行为断言（JavaScriptCore）

    func flushMicrotasks(_ n: Int = 3) {
        for _ in 0..<n { _ = ctx.objectForKeyedSubscript("Promise" as NSString)?
            .invokeMethod("resolve", withArguments: [])
            .invokeMethod("then", withArguments: [{} as @convention(block) () -> Void]) }
    }

    func testAsyncCallPostsIdMethodArgs() {
        ctx.evaluateScript("window.wcStorage.getState().then(function(){})")
        XCTAssertEqual(posted.count, 1)
        XCTAssertNotNil(posted[0]["id"])
        XCTAssertEqual(posted[0]["method"] as? String, "getState")
        XCTAssertEqual((posted[0]["args"] as? [Any])?.count, 0)
    }

    func testResolveByIdFulfillsPromise() {
        let done = expectation(description: "promise resolved")
        ctx.setObject(JSValue(object: { (ok: Bool) in
            if ok { done.fulfill() }
        } as @convention(block) (Bool) -> Void, in: ctx),
            forKeyedSubscript: "__testDone" as NSString)
        ctx.evaluateScript(
            "window.wcStorage.getState().then(function(r){ __testDone(r.ok === true) })")
        let id = posted[0]["id"] as? Int ?? 0
        ctx.evaluateScript("globalThis.__dshBridgeResolve(\(id), {ok:true})")
        wait(for: [done], timeout: 2)
    }

    func testArgsPassedPositionally() {
        ctx.evaluateScript("window.wcStorage.writeDoc('a/b.md', '正文')")
        let args = posted[0]["args"] as? [Any]
        XCTAssertEqual(args?.count, 2)
        XCTAssertEqual(args?.first as? String, "a/b.md")
    }

    func testSyncMethodsUseXHRAndReturnValue() {
        // 不比较 JSON 键序（桩与原生序列化器的键序可能不同），按解析后的字段断言
        let r = ctx.evaluateScript(
            "var x = window.wcStorage.writeDocSync('a/b.md','z');"
            + "JSON.stringify({ok:x.ok,mtime:x.mtime,bytes:x.bytes})")?.toString()
        XCTAssertEqual(r, #"{"ok":true,"mtime":123,"bytes":3}"#)
        XCTAssertEqual(syncCalls.count, 1)
        XCTAssertEqual(syncCalls[0]["method"] as? String, "writeDocSync")
        XCTAssertEqual((syncCalls[0]["args"] as? [Any])?.count, 2)
        XCTAssertEqual(posted.count, 0)
    }

    func testAsyncMethodDoesNotUseXHR() {
        ctx.evaluateScript("window.wcStorage.listWorkspace()")
        XCTAssertEqual(syncCalls.count, 0)
        XCTAssertEqual(posted.count, 1)
    }

    func testWcWritingHash12IsAsync() {
        ctx.evaluateScript(
            "window.wcWriting.hash12('abc').then(function(){})")
        XCTAssertEqual(posted.last?["method"] as? String, "hash12")
    }

    func testShellCanOverrideMethodWithFunction() {
        ctx.evaluateScript(
            "window.wcStorage.getState = function(){return 'overridden'}")
        let r = ctx.evaluateScript("window.wcStorage.getState()")?.toString()
        XCTAssertEqual(r, "overridden")
        XCTAssertEqual(posted.count, 0)
    }
}
```

> JavaScriptCore 在 iOS 模拟器与 mac 测试宿主均可用（`import JavaScriptCore`，非 WebKit 私有 API）。微任务经 Promise 桩排空；若某 CI 上 JSC 的微任务时序不同，`testResolveByIdFulfillsPromise` 已用 expectation 等待，不依赖固定轮次。

> **主控裁决（Task 13.3 第六次 CI，2026-10-11）**：run 38127978505 在 PathGuard 33 条清除后编译深入本文件，全仓仅剩 2 条错误，均在上方围栏 setUp 的两个 `@convention(block)` 桩闭包内。① L21 列 66：`JSValue.toDictionary()` 经 JavaScriptCore Swift overlay 返回 `[AnyHashable: Any]`，不能直接 append 进 `[[String: Any]]`（`posted`），须 `msg?.toDictionary() as? [String: Any]` 在 `if let` 内收窄键类型。② L32 列 42：`xhrCtor` 以 `[weak self]` 捕获，闭包内 `self` 恒为可选，`JSValue(newObjectIn:)` 须传 `self?.ctx`（同闭包后续 L44/L51 本就正确使用 `self?.`，仅此一处漏 `?`）。扫雷：全仓 `toDictionary|weak self` 共 9 处，BackgroundFlusher（源码与测试）、NativeBridgeTests、本文件其余位置均已正确收窄/加可选链，无同款残留。本文件 L42 的 `try? ... as? [String: Any]` 处于 `guard let` 绑定，合法不改。

> **主控裁决（Task 13.3 第八次 CI，2026-10-11）**：run 38128822820 报本文件 L38:73/L53:59 两条 `reference to property 'ctx' in closure requires explicit use of 'self'`。这两处是 `xhrCtor`（`[weak self]`）内部两个**嵌套** `@convention(block)` 闭包（open/send 桩）的 `JSValue(object:in:)`，`in:` 实参裸写 `ctx`——外层闭包既已显式 `[weak self]`，内层闭包对 self 属性的引用也必须显式写出 `self?.ctx`（与同闭包 L32 的 `JSValue(newObjectIn: self?.ctx)` 同范式；第七轮编译在到达这两个内层闭包前先被 L19 错误短路，故本轮才暴露）。双侧改 `in: self?.ctx`。扫雷全仓 `@convention(block)`：本文件 L25/L57 在 setUp 方法体、L127 在测试方法体，均不在 `[weak self]` 闭包内，裸 `ctx` 合法；全仓无同款残留。

- [ ] **9.5 写实现 `Sources/BridgeJS.swift` 通过 9.4（Green 第二半）**

新增文件，完整内容。注入脚本结构照抄安卓 `MainActivity.INJECT_DOC_START`（白名单/Proxy/壳层覆写逐字对齐），两处实质差异：① `nativeCall` 由安卓的同步 `__wcNative.call` 改为 `postMessage` + Promise 配对 + 10 s 超时；② 两个 `*Sync` 方法走 `dsh-bridge://sync` 同步 XHR（Task 10 落地原生侧）。末尾追加 iPad 窄 `wcWriting` shim。

```swift
import Foundation

// document-start 注入脚本（主框架 + 同源 iframe，forMainFrameOnly: false）。
// 蓝本：安卓 MainActivity.INJECT_DOC_START；契约由 BridgeJSTests 钉死。
enum BridgeJS {

    static let source = #"""
globalThis.__DSH_TRANSPORT__ = { ownsHost: true };
(function () {
  var hasNative = !!(window.webkit && window.webkit.messageHandlers
      && window.webkit.messageHandlers.dshBridge);
  var SYNC_METHODS = { writeDocSync: 1, writeDraftSync: 1 };
  var API_METHODS = {
    getState: 1, listWorkspace: 1, readDoc: 1, writeDoc: 1, writeDocSync: 1,
    createWork: 1, createDoc: 1, renameWork: 1, renameDoc: 1, moveDoc: 1,
    trashDoc: 1, trashWork: 1, listTrash: 1, restoreTrash: 1, purgeTrash: 1,
    saveConfig: 1, writeDraft: 1, writeDraftSync: 1, readDraft: 1, clearDraft: 1,
    listPendingDrafts: 1, draftsUsage: 1, getLastSession: 1, proofSave: 1, proofLoad: 1,
    syncBaseline: 1, syncBaselineSet: 1, appendPomodoro: 1, outboxList: 1, outboxRemove: 1,
    nativeOnline: 1, reportDirty: 1, onFlushRequest: 1, flushDone: 1, relaunch: 1,
    scheduleReminder: 1, cancelReminder: 1, getDeviceId: 1, hash12: 1,
    pickRoot: 1, pickDir: 1, pickImportFiles: 1, pickImportDir: 1, importInto: 1, onImportProgress: 1,
    notifyWriting: 1
  };

  // ---- 异步通道：postMessage 发包，__dshBridgeResolve 按 id 配对 ----
  var nextId = 1;
  var pending = Object.create(null);

  function postNative(method, args) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      try {
        window.webkit.messageHandlers.dshBridge.postMessage({ id: id, method: method, args: args });
      } catch (e) {
        delete pending[id];
        reject(new Error('原生桥发包失败: ' + e));
        return;
      }
      if (typeof setTimeout === 'function') {
        pending[id].timer = setTimeout(function () {
          if (!pending[id]) return;
          delete pending[id];
          reject(new Error('原生桥超时: ' + method));
        }, 10000);
      }
    });
  }

  globalThis.__dshBridgeResolve = function (id, val) {
    var p = pending[id];
    if (!p) return;
    if (p.timer && typeof clearTimeout === 'function') clearTimeout(p.timer);
    delete pending[id];
    try { p.resolve(val); } catch (e) {}
  };

  // ---- 同步通道：仅 writeDocSync/writeDraftSync，XHR async=false ----
  function nativeCallSync(method, args) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'dsh-bridge://sync', false);
    xhr.send(JSON.stringify({ method: method, args: args }));
    var raw = xhr.responseText || '';
    try { return JSON.parse(raw); }
    catch (e) { return { ok: false, error: '原生桥返回非 JSON: ' + raw }; }
  }

  var target = {};
  var methodOverrides = {};
  globalThis.wcStorage = new Proxy(target, {
    get: function (t, prop) {
      if (typeof prop !== 'string') return Reflect.get(t, prop);
      if (Object.prototype.hasOwnProperty.call(methodOverrides, prop)) return methodOverrides[prop];
      if (Object.prototype.hasOwnProperty.call(API_METHODS, prop)) {
        return function () {
          var args = Array.prototype.slice.call(arguments);
          if (SYNC_METHODS[prop]) return nativeCallSync(prop, args);
          return postNative(prop, args);
        };
      }
      return Reflect.get(t, prop);
    },
    set: function (t, prop, value) {
      if (typeof value === 'function') methodOverrides[prop] = value;
      else Reflect.set(t, prop, value);
      return true;
    }
  });

  // iPad 窄 wcWriting：只给 writing.js 的 sha1Twelve 提供 hash12（Promise）。
  // kind 不取 'electron'，避免 shell.html 绑定 Electron 专有中继（tick/通知/设备号均无原生依托）。
  if (!window.wcWriting) {
    window.wcWriting = {
      kind: 'ipad',
      hash12: function (text) {
        return postNative('hash12', [String(text == null ? '' : text)]);
      }
    };
  }

  // 原生桥缺失（如 S1 探针页/异常宿主）时给一个全失败兜底，避免核心 JS 调用 undefined
  if (!hasNative) {
    Object.keys(API_METHODS).forEach(function (m) {
      if (SYNC_METHODS[m]) return;
      methodOverrides[m] = function () {
        return Promise.resolve({ ok: false, error: '原生桥未安装' });
      };
    });
  }
})();
"""#
}
```

要点：① `hasNative` 在 IIFE 入口探测一次；桥缺失时**同步方法不兜底**（写作落盘必须暴露失败，不能假装成功——同步方法被调用时 `xhr.send` 自身会抛错，由核心 JS 的 catch 接住），异步方法统一 reject 形态的 `{ok:false}`，对齐安卓"桥不存在则 `if (!__wcNative) return` 后 wcStorage 为 undefined"的失败可见原则但更温和（核心 JS 有 `.catch`/ok 判断）。② 超时 reject 后 pending 已清，迟到的原生应答被 `__dshBridgeResolve` 静默丢弃。③ 脚本全程 `try/catch` 包裹发包与回调，绝不向页面抛未捕获异常（spec §5.3）。④ **不注入** `__wcNightHint`：该 token 仅安卓 `android-shell.js`（本仓不内置）消费用于防首帧亮闪，iPad v1 无消费者，注入死值反而污染全局；若 Task 12 决定做夜间模式再在此追加。⑤ `window` 与 `globalThis` 并用是刻意的：JSC 单测宿主需显式建立 `window` 别名（9.4 setUp 已做），WKWebView 中二者本就同一对象。

- [ ] **9.6 改 `Sources/ShellWebView.swift`：注册 dsh-asset、注入 BridgeJS、挂 dshBridge、生产沙盒构造 dispatcher**

基线为 Task 4 之后的文件（已含 `ShellNavPolicy`、`decidePolicyFor`、`loadLocalShell`、Task 4.6 改过的头注释）。构造时序的关键约束：`NativeBridge(dispatcher:webView:)` 必须在 `WKWebView` 存在后才能建，但 `BridgeDispatcher` 不依赖 WebView——故 Coordinator 在 `init()` 里只建 dispatcher，桥延迟到 `makeUIView` 拿到 web 后由 `attach(to:)` 创建并注册（同时满足"scheme/message handler 必须在首次 `load` 前装好"）。将整个文件替换为：

```swift
import SwiftUI
import WebKit

// ============================================================================
// WKWebView 封装 —— 本仓的**核心**（其余多为脚手架）
//
// 承载三件与安卓壳对应的事：
//   ① 「回环权威门」：页面脚本执行前（atDocumentStart，主框架+同源 iframe）注入 BridgeJS，
//      其中含 globalThis.__DSH_TRANSPORT__ = { ownsHost: true } 与 wcStorage/wcWriting 桥。
//   ② 本地资产：dsh-asset://local/<name> 由 ShellSchemeHandler 从 Bundle 应答（Task 4 的
//      /__shell__/ 导航接管负责把主壳换成本地 HTML）。
//   ③ wcStorage 消息桥：window.webkit.messageHandlers.dshBridge → NativeBridge →
//      BridgeDispatcher（Documents 沙盒）；同步 *Sync 通道由 Task 10 的 dsh-bridge handler 承接。
//
// 本地应答路线：WKURLSchemeHandler 不能拦 http/https，故主框架 /__shell__/ 经
// decidePolicyFor 取消 + loadHTMLString(baseURL:网关) 虚拟同源；本地资产走自定义
// dsh-asset://（见 ShellSchemeHandler）。iframe 与 /api 等保持直连网关。
// ============================================================================

struct ShellWebView: UIViewRepresentable {
    let urlString: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        // 与 PC 客户端同口径：Cookie 走默认存储（同一 app 内持久）
        cfg.websiteDataStore = .default()

        // ② 本地壳资产（shell.html 改写后外链 dsh-asset://local/<name>）
        cfg.setURLSchemeHandler(ShellSchemeHandler(loadData: { name in
            guard let url = Bundle.main.url(forResource: name, withExtension: nil) else { return nil }
            return try? Data(contentsOf: url)
        }), forURLScheme: "dsh-asset")

        // ① document-start 注入（早于页面任何脚本；forMainFrameOnly:false 穿透同源 iframe）
        cfg.userContentController.addUserScript(
            WKUserScript(source: BridgeJS.source, injectionTime: .atDocumentStart,
                        forMainFrameOnly: false)
        )

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.customUserAgent = (web.value(forKey: "userAgent") as? String)
            .map { $0 + " DSHRemote/\(Coordinator.appVersion)" }
        // ③ 桥在此创建并注册（早于下面的 web.load）；dispatcher 不可用时 attach 内部空操作
        context.coordinator.attach(to: web)

        if let u = URL(string: urlString) { web.load(URLRequest(url: u)) }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        // 地址变化时重载（简单处理；P2 再谈"两个 WebView 常驻"）
        if let cur = web.url?.absoluteString.split(separator: "#").first.map(String.init),
           let want = URL(string: urlString),
           cur != "\(want.scheme ?? "")://\(want.host ?? "")\(want.path)" {
            web.load(URLRequest(url: want))
        }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        // 断开 UCC → handler 强引用（NativeBridge 的 reply 已弱引 webView，这里再破 UCC 一侧）
        web.configuration.userContentController.removeScriptMessageHandler(forName: "dshBridge")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var web: WKWebView?
        private var bridge: NativeBridge?
        private let dispatcher: BridgeDispatcher?

        static let appVersion: String =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"

        override init() {
            // spec §6.1：dataDir=Documents 根（config.json/outbox.json/drafts/proofread/sync 直接在根），
            // workspaceRoot=Documents/workspace（英文目录名，对齐安卓 getFilesDir()/workspace）
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let workspaceRoot = docs.appendingPathComponent("workspace", isDirectory: true)
            let made = try? BridgeDispatcher(
                dataDir: docs, workspaceRoot: workspaceRoot, appVersion: Self.appVersion)
            if made == nil {
                NSLog("[dsh-ios] BridgeDispatcher 构造失败，wcStorage 桥未安装（页面走未安装兜底）")
            }
            self.dispatcher = made
            super.init()
        }

        func attach(to web: WKWebView) {
            self.web = web
            guard let dispatcher else { return }
            let bridge = NativeBridge(dispatcher: dispatcher, webView: web)
            self.bridge = bridge
            web.configuration.userContentController.add(bridge, name: "dshBridge")
        }

        // MARK: - 导航观测

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            NSLog("[dsh-ios] didFinish \(webView.url?.absoluteString ?? "-")")
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("[dsh-ios] didFail \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("[dsh-ios] didFailProvisional \(error.localizedDescription)")
        }

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            // 🔴 客户端证书（mTLS）在 WKWebView 上**不可用**（`URLCredential(clientCertificate:)` 在 iOS 无效，
            //    只有证书+私钥已装进系统钥匙串身份时才可能自动响应）⇒ 走 tailnet/Funnel，不要依赖 mTLS。
            NSLog("[dsh-ios] challenge method=\(challenge.protectionSpace.authenticationMethod)")
            completionHandler(.performDefaultHandling, nil)
        }

        // target=_blank / window.open ⇒ 同 WebView 打开（不弹新窗）
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
            return nil
        }

        // MARK: - /__shell__/ 主框架导航接管（Task 4）

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url,
                  ShellNavPolicy.shouldTakeOver(
                    mainFrame: navigationAction.targetFrame?.isMainFrame ?? false, url: url) else {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            Self.loadLocalShell(into: webView, baseURL: url)
        }

        static func loadLocalShell(into webView: WKWebView, baseURL: URL) {
            guard let u = Bundle.main.url(forResource: "shell", withExtension: "html"),
                  let raw = try? String(contentsOf: u, encoding: .utf8),
                  let rewritten = try? ShellHTMLRewriter.rewrite(raw) else {
                NSLog("[DSH] 本地壳读取/改写失败，回退网络加载")
                webView.load(URLRequest(url: baseURL))
                return
            }
            webView.loadHTMLString(rewritten, baseURL: baseURL)
        }
    }
}

enum ShellNavPolicy {
    static func shouldTakeOver(mainFrame: Bool, url: URL) -> Bool {
        guard mainFrame else { return false }
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return c.path.hasPrefix("/__shell__/")
    }
}
```

要点：① **本 Task 不注册 dsh-bridge 同步 scheme**，只接异步通道；Task 10 在 `attach(to:)` 里用**同一个 dispatcher 实例**追加 `web.configuration.setURLSchemeHandler(BridgeSyncSchemeHandler(dispatcher: dispatcher), forURLScheme: "dsh-bridge")`（必须在首次 `load` 前，`attach(to:)` 满足）。② `dismantleUIView` 的 `removeScriptMessageHandler(forName:)` 断开 UCC→bridge；`NativeBridge.reply` 已 `[weak webView]`，双向无环。③ dispatcher 构造失败（Documents 目录不可建，极端情况）时 `dispatcher=nil`，`attach(to:)` 不注册 handler；BridgeJS 探测到 `messageHandlers.dshBridge` 缺失即走"原生桥未安装"兜底，页面不崩。④ 旧占位的 `WKScriptMessageHandler` 实现（`userContentController(_:didReceive:)` 与 `name:"wcStorage"` 注册）整段删除，消息逻辑全在 NativeBridge；Coordinator 只声明 `WKNavigationDelegate, WKUIDelegate`。⑤ UA 后缀版本号从 Info.plist 取（缺省 0.1.0），与 dispatcher 的 appVersion 同源。

- [ ] **9.7 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期：`** TEST SUCCEEDED **`，NativeBridgeTests（约 15 个）与 BridgeJSTests（14 个：6 结构 + 8 行为）全绿，且前序 PathGuard/WorkspaceStore/AppDataStore/OutboxStore/BridgeDispatcher 各测试与壳资产测试不受影响。若 BridgeJSTests 在 CI 上出现 JSC 微任务时序差异，优先核对 9.4 的 expectation 用法与 9.5 的 `pending` 配对，不得改宽白名单计数（46）等结构断言。

- [ ] **9.8 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/NativeBridge.swift Sources/BridgeJS.swift Sources/ShellWebView.swift \
  Tests/DSHRemoteTests/NativeBridgeTests.swift Tests/DSHRemoteTests/BridgeJSTests.swift \
  docs/superpowers/plans/2026-10-10-ipad-offline-writing-sync.md
git commit -m "feat(bridge): NativeBridge 异步消息桥与 BridgeJS 注入并接入 ShellWebView"
```

## Task 10：同步通道 `BridgeSyncSchemeHandler`（dsh-bridge://sync）

目标：落地 spec §5.1 的第二条通道——BridgeJS 中两个 `*Sync` 方法（`writeDocSync`/`writeDraftSync`）经 `XMLHttpRequest` 同步 POST 到 `dsh-bridge://sync`，原生侧当场分发并把 JSON 结果作为响应体返回，保证 `pagehide` 收尾链路的同步落盘语义（对齐安卓 `@JavascriptInterface` 同步 `call`）。

前置事实（Task 3 的 S1 探针⑤结论决定走哪条路径，**执行前先在真机探针页确认⑤全绿**）：

- 若⑤全绿（`httpBody`/`httpBodyStream` 可读到 POST 请求体）：走主路径——读 body 里的 `{method,args}`，分发，应答。下面 10.1–10.6 即此路径。
- 若⑤不绿（WKWebView 自定义 scheme 的同步 XHR 读不到 body）：**不改核心 JS**，启用 10-bis 退路：BridgeJS 的 `nativeCallSync` 把 args 放进 **URL query**（`dsh-bridge://sync?m=<method>&a=<json编码数组>`），handler 从 query 解析；写作正文单次上限约数十万字（安卓端同量级），`a` 再经 `encodeURIComponent`，URL 长度在 iOS 自定义 scheme 下无服务端网关限制，但仍以真机探针验证的实测上限为准。退路对 10.1 的测试只多一个"query 解析"用例，handler 内核签名不变。

线程：WKURLSchemeHandler 的 `start` 在 WebKit 内部线程调用；`BridgeDispatcher.dispatch` 自带 `ioLock`，与异步通道共用同一 dispatcher 实例时天然互斥，这里**不再**另开队列（同步 XHR 要求当场应答，开异步队列反而无法在 `start` 返回前 `didFinish`）。

- [ ] **10.1 写失败测试 `Tests/DSHRemoteTests/BridgeSyncSchemeHandlerTests.swift`（Red 第一部分）**

新增文件，完整内容。可测性设计同 NativeBridge：把"解析 → 校验 → 分发 → 序列化"做成不依赖 WebKit 的纯内核 `BridgeSyncBridge.answer(to:)`，输入标准 `URLRequest`、输出 `(status, contentType, body)`；WKURLSchemeHandler 只做读 body 与搬运，不经 mock。

```swift
import XCTest
@testable import DSHRemote

final class BridgeSyncSchemeHandlerTests: XCTestCase {
    private var tmp: URL!
    private var dataDir: URL!
    private var workspace: URL!
    private var dispatcher: BridgeDispatcher!
    private var bridge: BridgeSyncBridge!

    override func setUpWithError() throws {
        tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("BridgeSyncTests-\(UUID().uuidString)", isDirectory: true)
        dataDir = tmp.appendingPathComponent("data", isDirectory: true)
        workspace = dataDir.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        dispatcher = try BridgeDispatcher(dataDir: dataDir, workspaceRoot: workspace, appVersion: "0.1.0")
        bridge = BridgeSyncBridge(dispatcher: dispatcher)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    private func request(method: String? = nil,
                         args: Any? = nil,
                         rawBody: Data? = nil,
                         urlString: String = "dsh-bridge://sync") -> URLRequest {
        var req = URLRequest(url: URL(string: urlString)!)
        req.httpMethod = "POST"
        if let rawBody {
            req.httpBody = rawBody
        } else {
            var dict: [String: Any] = [:]
            if let method { dict["method"] = method }
            if let args { dict["args"] = args }
            req.httpBody = try? JSONSerialization.data(withJSONObject: dict)
        }
        return req
    }

    private func json(_ answer: BridgeSyncBridge.Answer) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: answer.body) as? [String: Any]) ?? [:]
    }

    // MARK: - 探针兼容

    func testPingProbe() {
        let req = URLRequest(url: URL(string: "dsh-bridge://sync?m=__ping__")!)
        let answer = bridge.answer(to: req)
        XCTAssertEqual(answer.status, 200)
        XCTAssertTrue(answer.contentType.contains("application/json"))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, true)
    }

    // MARK: - 两个同步方法

    func testWriteDocSyncPersists() throws {
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["a/b.md", "hello"]))
        XCTAssertEqual(answer.status, 200)
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, true)
        XCTAssertEqual(map["bytes"] as? Int, 5)
        XCTAssertTrue((map["mtime"] as? NSNumber)?.int64Value ?? 0 > 0)
        // 落盘可经异步通道同款 readDoc 读回
        let read = dispatcher.dispatch("readDoc", args: ["a/b.md"])
        XCTAssertEqual(read["ok"] as? Bool, true)
        XCTAssertEqual(read["content"] as? String, "hello")
    }

    func testWriteDraftSyncReturnsKey() throws {
        // 对齐安卓 WcStorageBridge：writeDraftSync 仅两参 (relPath, content)
        let answer = bridge.answer(to: request(method: "writeDraftSync", args: ["w/a/x.md", "草稿正文"]))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, true)
        let key = map["key"] as? String ?? ""
        XCTAssertEqual(key.count, 24) // draftKeyFor = SHA1(root\nrelPath) 前 24 位 hex
        XCTAssertTrue(key.allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertEqual(map["bytes"] as? Int, 12) // "草稿正文" 4 字 × 3 字节
        // 草稿可经异步通道同款 readDraft 读回
        let read = dispatcher.dispatch("readDraft", args: ["w/a/x.md"])
        XCTAssertEqual(read["ok"] as? Bool, true)
        XCTAssertEqual(read["content"] as? String, "草稿正文")
    }

    // MARK: - 仅允许两个同步方法

    func testAsyncMethodRejected() {
        let answer = bridge.answer(to: request(method: "writeDoc", args: ["a/b.md", "x"]))
        XCTAssertEqual(answer.status, 200) // 业务失败走 200 + ok:false（对齐安卓 call() 不抛 HTTP 错）
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, false)
        let err = map["error"] as? String ?? ""
        XCTAssertTrue(err.contains("仅允许同步方法"))
    }

    func testUnknownMethodRejected() {
        let answer = bridge.answer(to: request(method: "nope", args: []))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, false)
    }

    // MARK: - 协议级畸形 → 400

    func testMissingBodyIs400() {
        let req = URLRequest(url: URL(string: "dsh-bridge://sync")!)
        XCTAssertEqual(bridge.answer(to: req).status, 400)
    }

    func testMalformedJSONIs400() {
        let answer = bridge.answer(to: request(rawBody: Data("{not json".utf8)))
        XCTAssertEqual(answer.status, 400)
    }

    func testBodyNotObjectIs400() {
        let answer = bridge.answer(to: request(rawBody: Data("[1,2]".utf8)))
        XCTAssertEqual(answer.status, 400)
    }

    func testMethodMissingOrNotStringIs400() {
        XCTAssertEqual(bridge.answer(to: request(method: nil, args: [])).status, 400)
        let answer = bridge.answer(to: request(rawBody: Data(#"{"method":42,"args":[]}"#.utf8)))
        XCTAssertEqual(answer.status, 400)
    }

    func testArgsNotArrayIs400() {
        let answer = bridge.answer(to: request(rawBody: Data(#"{"method":"writeDocSync","args":"x"}"#.utf8)))
        XCTAssertEqual(answer.status, 400)
    }

    func testArgsMissingDefaultsToEmpty() {
        // 缺 args 时按 [] 处理，交给 dispatcher 报业务失败（200/ok:false），不是协议 400
        let answer = bridge.answer(to: request(rawBody: Data(#"{"method":"writeDocSync"}"#.utf8)))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, false)
    }

    // MARK: - 业务失败透传（路径越界）

    func testPathTraversalIsBusinessFail() {
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["../escape.md", "x"]))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, false)
        XCTAssertNotNil(map["error"])
    }

    // MARK: - 大 body / 恶意内容往返

    func testLargeBodyRoundTrip() {
        let text = String(repeating: "段", count: 200_000) // 600KB UTF-8
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["big.md", text]))
        XCTAssertEqual(json(answer)["ok"] as? Bool, true)
        let read = dispatcher.dispatch("readDoc", args: ["big.md"])
        XCTAssertEqual(read["content"] as? String, text)
    }

    func testMaliciousContentRoundTrip() {
        let text = "</script>\"'\n\r\t\u{2028}中文"
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["evil.md", text]))
        XCTAssertEqual(json(answer)["ok"] as? Bool, true)
        let read = dispatcher.dispatch("readDoc", args: ["evil.md"])
        XCTAssertEqual(read["content"] as? String, text)
    }

    // MARK: - 应答头

    func testResponseHeaders() {
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["a/b.md", "z"]))
        XCTAssertTrue(answer.contentType.contains("application/json"))
        XCTAssertTrue(answer.contentType.lowercased().contains("utf-8"))
    }
}
```

- [ ] **10.2 运行测试，确认失败（Red 第一部分）**

执行「模拟器测试命令」，预期编译报错：`cannot find 'BridgeSyncBridge' in scope`。

- [ ] **10.3 写实现 `Sources/BridgeSyncSchemeHandler.swift`（Green 第一部分）**

新增文件，完整内容。纯内核 `BridgeSyncBridge` + 薄 WKWebView 适配 `BridgeSyncSchemeHandler`。

```swift
import Foundation
import WebKit

// 同步桥内核：URLRequest → (status, Content-Type, body)，不依赖 WebKit，可直接单测。
final class BridgeSyncBridge {
    struct Answer {
        let status: Int
        let contentType: String
        let body: Data
    }

    private static let jsonType = "application/json; charset=utf-8"
    private static let syncMethods: Set<String> = ["writeDocSync", "writeDraftSync"]

    private let dispatcher: BridgeDispatcher

    init(dispatcher: BridgeDispatcher) {
        self.dispatcher = dispatcher
    }

    func answer(to request: URLRequest) -> Answer {
        // 探针（Task 3 S1 第⑤项）：dsh-bridge://sync?m=__ping__
        if request.url?.queryParameter("m") == "__ping__" {
            return json(200, ["ok": true, "echo": "pong"])
        }

        guard let body = request.httpBody ?? Self.readBodyStream(request) else {
            return badRequest("缺少请求体")
        }
        guard let obj = try? JSONSerialization.jsonObject(with: body, options: []),
              let dict = obj as? [String: Any] else {
            return badRequest("请求体必须是 JSON 对象")
        }
        guard let method = dict["method"] as? String else {
            return badRequest("method 缺失或不是字符串")
        }
        // 缺省 []；args 存在但非数组 → 协议错
        let args: [Any]
        if dict["args"] == nil || dict["args"] is NSNull {
            args = []
        } else if let arr = dict["args"] as? [Any] {
            args = arr
        } else {
            return badRequest("args 必须是数组")
        }

        guard Self.syncMethods.contains(method) else {
            // 业务失败形态（对齐安卓 call()：任何方法都经同一同步入口返回 JSON，不抛异常）
            return json(200, ["ok": false, "error": "该方法不允许走同步通道（仅允许同步方法 writeDocSync/writeDraftSync）: \(method)"])
        }

        let map = dispatcher.dispatch(method, args: args)
        return json(200, map)
    }

    private func badRequest(_ msg: String) -> Answer {
        json(400, ["ok": false, "error": msg])
    }

    private func json(_ status: Int, _ map: [String: Any]) -> Answer {
        let data: Data
        if let d = try? JSONSerialization.data(withJSONObject: map) {
            data = d
        } else {
            data = Data("{\"ok\":false,\"error\":\"应答序列化失败\"}".utf8)
        }
        return Answer(status: status, contentType: Self.jsonType, body: data)
    }

    // WKURLSchemeTask 的同步 XHR 请求体可能落在 httpBodyStream（无 NSURLRequest 直接 body 时）
    static func readBodyStream(_ request: URLRequest) -> Data? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        let cap = 8 * 1024
        var out = Data()
        let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: cap)
        defer { buf.deallocate() }
        while stream.hasBytesAvailable {
            let n = stream.read(buf, maxLength: cap)
            if n < 0 { return nil }
            if n == 0 { break }
            out.append(buf, count: n)
        }
        return out.isEmpty ? nil : out
    }
}

// WKWebView 适配：读请求 → 内核 → didReceive/didFinish（响应头与 ShellSchemeHandler 同构）
final class BridgeSyncSchemeHandler: NSObject, WKURLSchemeHandler {
    private let bridge: BridgeSyncBridge

    init(dispatcher: BridgeDispatcher) {
        self.bridge = BridgeSyncBridge(dispatcher: dispatcher)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let answer = bridge.answer(to: urlSchemeTask.request)
        guard let url = urlSchemeTask.request.url,
              let response = HTTPURLResponse(
                url: url, statusCode: answer.status, httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": answer.contentType,
                    "Content-Length": "\(answer.body.count)",
                    "Access-Control-Allow-Origin": "*"
                ]) else {
            urlSchemeTask.didFailWithError(NSError(domain: "dsh-bridge", code: -1))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(answer.body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

private extension URL {
    func queryParameter(_ key: String) -> String? {
        URLComponents(url: self, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == key }?
            .value
    }
}
```

- [ ] **10.4 运行测试，确认通过（Green 第一部分）**

执行「模拟器测试命令」，预期 `** TEST SUCCEEDED **`，BridgeSyncSchemeHandlerTests 全绿。

- [ ] **10.5 接线：`ShellWebView.Coordinator.attach(to:)` 注册 dsh-bridge**

在 Task 9 的 `attach(to:)` 里、`add(bridge,name:)` 之后追加一行（必须仍在 `web.load` 之前）：

```swift
        func attach(to web: WKWebView) {
            self.web = web
            guard let dispatcher else { return }
            let bridge = NativeBridge(dispatcher: dispatcher, webView: web)
            self.bridge = bridge
            web.configuration.userContentController.add(bridge, name: "dshBridge")
            // 同步通道（writeDocSync/writeDraftSync），与异步桥共用同一 dispatcher（ioLock 互斥）
            web.configuration.setURLSchemeHandler(
                BridgeSyncSchemeHandler(dispatcher: dispatcher), forURLScheme: "dsh-bridge")
        }
```

要点：① `setURLSchemeHandler` 必须在该 configuration 首次加载前调用——`attach(to:)` 在 `makeUIView` 的 `web.load` 之前，满足。② 与 Task 3 的 S1 探针 handler 的关系：探针页 `S1ProbePage` 若仍以独立临时代码注册 `dsh-bridge`/`__ping__`，**保留它直到真机⑤验收完成**；正式 handler 同样应答 `__ping__`（见 10.1 `testPingProbe`），二者不冲突——它们注册在不同 WKWebView 实例（探针页 vs 主壳）。Task 13 验收后再删 S1 临时代码。③ 至此 BridgeJS 同步 XHR 在主壳内可用；BridgeJSTests 的 XHR 桩仍只验证 JS 侧拼装，不依赖本 handler。

- [ ] **10.6 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/BridgeSyncSchemeHandler.swift Sources/ShellWebView.swift \
  Tests/DSHRemoteTests/BridgeSyncSchemeHandlerTests.swift \
  docs/superpowers/plans/2026-10-10-ipad-offline-writing-sync.md
git commit -m "feat(bridge): dsh-bridge 同步 XHR 通道承接 writeDocSync/writeDraftSync"
```

#### 10-bis 退路（仅当真机探针⑤不绿时执行：query 传参）

触发条件：Task 3 S1 探针页第⑤项显示自定义 scheme 的同步 XHR **读不到 body**。此路不改核心 JS，只改桥两侧的传参位置。

- [ ] **10-bis.1 改 `BridgeSyncBridge.answer(to:)`：先认 query**

在 ping 判断之后、body 读取之前插入 query 分支：

```swift
        // 探针（Task 3 S1 第⑤项）：dsh-bridge://sync?m=__ping__
        if request.url?.queryParameter("m") == "__ping__" {
            return json(200, ["ok": true, "echo": "pong"])
        }

        // 退路：query 传参（同步 XHR 读不到 body 时）
        if let viaQuery = answerFromQuery(request) {
            return viaQuery
        }

        guard let body = request.httpBody ?? Self.readBodyStream(request) else {
```

并在类内补 `answerFromQuery`（body 主路径留着，二者可共存）：

```swift
    func answerFromQuery(_ request: URLRequest) -> Answer? {
        guard let url = request.url, let method = url.queryParameter("m") else { return nil }
        var args: [Any] = []
        if let a = url.queryParameter("a"),
           let decoded = a.removingPercentEncoding,
           let data = decoded.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
           let arr = parsed as? [Any] {
            args = arr
        }
        guard Self.syncMethods.contains(method) else {
            return json(200, ["ok": false, "error": "该方法不允许走同步通道（仅允许同步方法 writeDocSync/writeDraftSync）: \(method)"])
        }
        return json(200, dispatcher.dispatch(method, args: args))
    }
```

- [ ] **10-bis.2 改 `BridgeJS.swift` 的 `nativeCallSync` 走 query**

```javascript
  function nativeCallSync(method, args) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST',
      'dsh-bridge://sync?m=' + encodeURIComponent(method)
        + '&a=' + encodeURIComponent(JSON.stringify(args)),
      false);
    xhr.send(null);
    var raw = xhr.responseText || '';
    try { return JSON.parse(raw); }
    catch (e) { return { ok: false, error: '原生桥返回非 JSON: ' + raw }; }
  }
```

- [ ] **10-bis.3 追加一个 query 传参测试到 BridgeSyncSchemeHandlerTests**

```swift
    func testQueryFallbackDispatch() {
        var comps = URLComponents(string: "dsh-bridge://sync")!
        let payload = try! JSONSerialization.data(withJSONObject: ["q/b.md", "query正文"])
        comps.queryItems = [
            URLQueryItem(name: "m", value: "writeDocSync"),
            URLQueryItem(name: "a", value: String(data: payload, encoding: .utf8))
        ]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        // 无 body：验证 query 分支独立成立
        let answer = bridge.answer(to: req)
        XCTAssertEqual(json(answer)["ok"] as? Bool, true)
        let read = dispatcher.dispatch("readDoc", args: ["q/b.md"])
        XCTAssertEqual(read["content"] as? String, "query正文")
    }
```

- [ ] **10-bis.4 验证**：执行「模拟器测试命令」全绿；真机重开探针⑤所在页确认同步 query 往返成功，再在写作页验证切后台/收尾时草稿落盘。

## Task 11：切后台 flush 钩子（ScenePhase `.background` → `__wcFlushOnSessionEnd`）

目标：对齐 PC 客户端 main.js 的 session-end 收尾——App 切后台时主动让写作页把当前正文同步落盘。

事实依据（已核对，不动共享核心）：

- writing.js 已在 `pagehide`/`beforeunload` 调 `flushSync(...)`，但 **iOS App 切后台不卸载页面、`pagehide` 不触发**，这条链在 iPad 上不会跑。
- writing.js:3446 已挂好显式钩子 `window.__wcFlushOnSessionEnd = function () { flushSync('session-end') }`；`flushSync`（writing.js:603）同步调 `api.writeDocSync(rel, text)`（Task 10 的 `dsh-bridge://sync` 通道），失败再 `keepDraftSync` 保草稿。
- PC Electron main.js:756 在 OS 关机/注销 session-end 时 `executeJavaScript('window.__wcFlushOnSessionEnd && window.__wcFlushOnSessionEnd()', true)`。iOS 的对应时机是 SwiftUI `scenePhase == .background`。
- 安卓 `MainActivity.onPause` 只做 `CookieManager.flush()`，无对等 JS 调用——iPad 此处比安卓多一道收尾，不违背任何蓝本（钩子本就是共享核心提供的公共 API）。

设计要点：

1. **可测内核 + 薄绑定**，与 NativeBridge/BridgeSyncBridge 同构。`BackgroundFlusher` 内核不直接引 `WKWebView`：经注入的「取 evaluator」闭包与「续命 begin/end」函数对单测；生产 convenience 用 `UIApplication.beginBackgroundTask` 给同步 XHR 争取后台窗口。
2. **引用通道**：当前 RootView 在内联创建 `ShellWebView`、外部够不到 Coordinator。新增 `final class ShellSession: ObservableObject`（放在 `App.swift`，**不新增文件**）持有一个 `BackgroundFlusher`；RootView 以 `@StateObject` 持有并传给 `ShellWebView(session:urlString:)`；Coordinator 在 `attach(to:)` 里把自身 webView 经 `session.flusher.bind(...)` 挂上。RootView 用 `@Environment(\.scenePhase)` 在 `.background` 调 `session.flusher.flush()`。
3. **续命语义**：flush 先同步调 `beginBackgroundTask` 拿到 token，再 evaluateJavaScript；其中 `flushSync` 的同步 XHR 在同一 JS turn 内阻塞完成；completionHandler 一回来就 `endBackgroundTask`。系统提前收回（expirationHandler）也立即 end，**尽力而为**（与 Electron 关机窗口语义一致）。拿不到后台时间（token 为 `.invalid`）时仍照发一次——多数情况下 scenePhase 转后台后该 JS turn 仍来得及跑完。
4. **重入保护**：上一次 flush 的 completionHandler 未回时，新的 flush 直接跳过（`flushing` 标志），避免后台抖动触发多次同步落盘；未绑定/解绑 evaluator 时静默 no-op，不申请后台时间。
5. 全程主线程；任何分支都必须保证每个 begin 恰好配一个 end。

- [ ] **11.1 写失败测试 `Tests/DSHRemoteTests/BackgroundFlusherTests.swift`（Red）**

新增文件，完整内容。内核把 `UIApplication` 相关的 begin/end 抽象为注入函数对，token 用 `AnyHashable`（生产装 `UIBackgroundTaskIdentifier.rawValue` 这个 `Int`，测试也传 `Int`），故测试 target 无需引 UIKit/WebKit。

```swift
import XCTest
@testable import DSHRemote

final class BackgroundFlusherTests: XCTestCase {

    private var begins: Int = 0
    private var ended: [AnyHashable] = []
    private var expirations: [() -> Void] = []
    private var evaluated: [String] = []

    private func makeHarness(token: AnyHashable? = 7) -> BackgroundFlusher {
        begins = 0
        ended = []
        expirations = []
        evaluated = []
        return BackgroundFlusher(
            begin: { [weak self] work in
                self?.begins += 1
                self?.expirations.append(work)
                return token
            },
            end: { [weak self] t in self?.ended.append(t) })
    }

    // MARK: - 脚本契约（与 Electron main.js:756 同一句）

    func testFlushScriptMatchesSessionEndHook() {
        XCTAssertEqual(
            BackgroundFlusher.flushScript,
            "window.__wcFlushOnSessionEnd && window.__wcFlushOnSessionEnd()")
    }

    // MARK: - 正常路径

    func testFlushEvaluatesScriptAndBeginsEndsTask() {
        let flusher = makeHarness()
        flusher.bind(evaluator: { [weak self] script, completion in
            self?.evaluated.append(script)
            completion(nil)
        })
        flusher.flush()
        XCTAssertEqual(begins, 1)
        XCTAssertEqual(evaluated, [BackgroundFlusher.flushScript])
        XCTAssertEqual(ended, [7])
    }

    func testCompletionFinishesEvenWhenEvaluateErrors() {
        let flusher = makeHarness()
        flusher.bind(evaluator: { $1(NSError(domain: "t", code: 1)) })
        flusher.flush()
        XCTAssertEqual(ended, [7])
    }

    // MARK: - 续命配对

    func testExpirationEndsTaskAndDoesNotCrash() {
        let flusher = makeHarness()
        flusher.bind(evaluator: { _, _ in /* 永不回调，模拟被挂起 */ })
        flusher.flush()
        XCTAssertTrue(ended.isEmpty)
        expirations[0]() // 系统提前收回
        XCTAssertEqual(ended, [7])
    }

    func testExpirationThenLateCompletionEndsOnlyOnce() {
        let flusher = makeHarness()
        var done: ((Error?) -> Void)?
        flusher.bind(evaluator: { done = $1 })
        flusher.flush()
        expirations[0]()
        done?(nil) // 迟到的完成回调
        XCTAssertEqual(ended, [7])
    }

    func testInvalidTokenStillEvaluatesOnce() {
        let flusher = makeHarness(token: nil)
        flusher.bind(evaluator: { [weak self] _, completion in
            self?.evaluated.append("x")
            completion(nil)
        })
        flusher.flush()
        XCTAssertEqual(begins, 1)
        XCTAssertEqual(evaluated.count, 1)
        XCTAssertTrue(ended.isEmpty) // 无 token 可 end
    }

    // MARK: - 重入 / 解绑 / 无 web

    func testReentrantFlushIsSkipped() {
        let flusher = makeHarness()
        var firstDone: ((Error?) -> Void)?
        flusher.bind(evaluator: { firstDone = $1 })
        flusher.flush()
        flusher.flush() // 第一次未完成 → 跳过：不重复 begin、不重复求值
        XCTAssertEqual(begins, 1)
        firstDone?(nil)
        flusher.flush() // 完成后再进后台 → 新一轮
        XCTAssertEqual(begins, 2)
        firstDone?(nil) // 第二轮的 completion（evaluator 每次把 $1 重新赋给 firstDone）
        XCTAssertEqual(ended, [7, 7])
    }

    func testFlushBeforeBindIsSilentNoop() {
        let flusher = makeHarness()
        flusher.flush() // 没有 webView（如网关未配置时切后台）
        XCTAssertEqual(begins, 0)
        XCTAssertTrue(ended.isEmpty)
    }

    func testFlushAfterUnbindIsSilentNoop() {
        let flusher = makeHarness()
        flusher.bind(evaluator: { $1(nil) })
        flusher.unbind()
        flusher.flush()
        XCTAssertEqual(begins, 0)
        XCTAssertTrue(ended.isEmpty)
    }
}
```

- [ ] **11.2 运行测试，确认失败（Red）**

执行「模拟器测试命令」，预期编译报错：`cannot find 'BackgroundFlusher' in scope`。

- [ ] **11.3 写实现 `Sources/BackgroundFlusher.swift`（Green）**

新增文件，完整内容。生产 convenience 用 `UIApplication.shared` 接后台时间；内核只依赖注入的 evaluator 闭包与 begin/end 函数对，**不出现 WKWebView/UIApplication 类型**，测试里不触 WebKit/UIKit。生产绑定由扩展 `bind(webView:)` 弱持有 webView 并把求值包成 evaluator。

```swift
import Foundation
import UIKit
import WebKit

// App 切后台（scenePhase == .background）时让写作页同步收尾：
// 执行 writing.js 暴露的 window.__wcFlushOnSessionEnd()（内部 flushSync → writeDocSync 同步 XHR）。
// 对齐 PC Electron main.js 的 session-end executeJavaScript；iOS 上 pagehide 不会因切后台触发。
final class BackgroundFlusher {

    /// 固定脚本：逐字对齐 Electron main.js:756，契约由 BackgroundFlusherTests 钉死。
    static let flushScript = "window.__wcFlushOnSessionEnd && window.__wcFlushOnSessionEnd()"

    /// (脚本, completion)：生产即 WKWebView.evaluateJavaScript 的形状；测试传内存桩。
    typealias Evaluator = (String, @escaping (Error?) -> Void) -> Void

    // 注入点：续命任务的 begin/end（生产包 UIApplication，测试传内存桩）
    private let beginTask: (@escaping () -> Void) -> AnyHashable?
    private let endTask: (AnyHashable) -> Void

    // 内核只认 evaluator 闭包；未绑定（网关未配置、壳未载入）为 nil
    private var evaluator: Evaluator?
    private var flushing = false

    init(begin: @escaping (@escaping () -> Void) -> AnyHashable?,
         end: @escaping (AnyHashable) -> Void) {
        self.beginTask = begin
        self.endTask = end
    }

    func bind(evaluator: @escaping Evaluator) {
        self.evaluator = evaluator
    }

    func unbind() {
        self.evaluator = nil
    }

    func flush() {
        // 解绑/未绑定：静默，不申请后台时间
        guard let evaluator else { return }
        // 重入：上一轮 completion 未回时跳过，避免后台抖动触发多次同步落盘
        guard !flushing else { return }
        flushing = true

        var token: AnyHashable?
        var ended = false
        let finishOnce: () -> Void = { [weak self] in
            guard !ended else { return }
            ended = true
            if let token { self?.endTask(token) }
            self?.flushing = false
        }

        token = beginTask {
            // 系统提前收回后台时间：立即收尾，迟到的 evaluateJavaScript 回调因 ended 被吞
            finishOnce()
        }

        // evaluator 内部在生产侧已切主线程（见 bind(webView:)）；此处直接调用
        evaluator(Self.flushScript) { _ in
            // 不看返回值/错误：session-end 本就是尽力而为（对齐 Electron）
            finishOnce()
        }
    }
}

extension BackgroundFlusher {

    /// 生产绑定：弱持有 WKWebView，求值时回主线程（WKWebView 必须主线程使用）。
    func bind(webView: WKWebView) {
        bind { [weak webView] script, completion in
            let doEvaluate: () -> Void = {
                _ = webView?.evaluateJavaScript(script) { _, error in completion(error) }
            }
            if Thread.isMainThread { doEvaluate() }
            else { DispatchQueue.main.async(execute: doEvaluate) }
        }
    }
}

extension BackgroundFlusher {

    /// 生产便捷构造：接 UIApplication 的后台任务时间。
    convenience init(live: Void = ()) {
        self.init(
            begin: { expiration in
                let token = UIApplication.shared.beginBackgroundTask(withName: "dsh-writing-flush") {
                    expiration()
                }
                return token == .invalid ? nil : AnyHashable(token.rawValue)
            },
            end: { raw in
                guard let value = raw.base as? Int else { return }
                UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: value))
            })
    }
}
```

要点：① 内核只依赖三个注入点（`beginTask`/`endTask`/`evaluator`），无 UIKit/WebKit 符号，BackgroundFlusherTests 全程内存桩即可。② 生产入口有两个：`ShellSession` 里用 `BackgroundFlusher(live: ())` 拿接 `UIApplication` 的实例；`Coordinator.attach(to:)` 调 `bind(webView:)` 弱挂 webView。③ `token` 用 `AnyHashable` 装箱 `UIBackgroundTaskIdentifier.rawValue`（`Int`），测试传任意 `Int`；`endTask` 用 `raw.base as? Int` 还原。④ `finishOnce` 同时被 expirationHandler 与 evaluateJavaScript completion 竞争调用，`ended` 保证 begin/end 严格配对一次；每轮 flush 的 `ended`/`token` 是局部变量，互不干扰，`flushing` 复位后下一轮可重新尝试。

> **主控裁决（Task 13.3 第二次 CI，2026-10-11）**：CI 报 `bind(webView:)` 76:54 `cannot convert value of type '() -> Void?' to expected argument type 'DispatchWorkItem'`。根因：`webView?.evaluateJavaScript(...) { ... }` 经可选链使闭包体产生 `Void?`，无类型标注的 `let doEvaluate = { ... }` 被推断为 `() -> Void?`；而 `DispatchQueue.main.async(execute:)` 的 `execute:` 标签精确选择 `DispatchWorkItem` 重载（尾随闭包的 `() -> Void` 重载不带该标签），故类型不匹配。围栏与落盘逐字同款缺陷，双侧修复为显式标注 `let doEvaluate: () -> Void = { _ = webView?.evaluateJavaScript(...) ... }`：显式返回类型压成 `Void`，`_ =` 显式丢弃可选链结果。主线程分支调用不变，派发时机与弱引用语义不变。

> **主控裁决（Task 13.3 第七次 CI，2026-10-11）**：run 38128636668 在 BridgeJSTests 2 条清除后，全仓仅剩 1 条：11.1 围栏 L19 列 20 `initializer for conditional binding must have Optional type, not '() -> Void'`。`begin:` 注入闭包的 `work` 形参对应源码 `(@escaping () -> Void) -> AnyHashable?`——系统过期回调是非可选 `@escaping () -> Void`，`if let work` 属把非可选当可选绑定（Red 围栏笔误，此前各轮被更早日志中的错误遮蔽未暴露）。双侧改为直接 `self?.expirations.append(work)`。扫雷全 Tests `if let <name> {` 缩写绑定 4 处：本处之外的 3 处（BridgeSyncSchemeHandlerTests.request 的 `rawBody: Data?`/`method: String?`/`args: Any?`）形参确为可选，合法不改。

- [ ] **11.4 运行测试，确认通过（Green）**

执行「模拟器测试命令」，预期 `** TEST SUCCEEDED **`，BackgroundFlusherTests 9 个全绿，前序各测试不受影响。

- [ ] **11.5 接线一：`Sources/App.swift` 持有 ShellSession 并监听 scenePhase**

将 `Sources/App.swift` **整文件替换为**（保留现有全部行为：网关配置、标题五连 S1、ContentUnavailableView、sheet；只加 ShellSession 与 scenePhase，并把内联 ShellWebView 改为接 session）。

> **主控裁决（执行时）**：围栏整文件版的入口 URL 基线停在 Task 4 之前（`Cfg.gateway + Cfg.entryPath` 的 `/app#/`）。现场 App.swift 自 Task 4 起已改为 `(try? GatewayURL.normalize(Cfg.gateway))?.shell ?? (Cfg.gateway + Cfg.entryPath)`（即 `origin/__shell__/shell.html`，本地壳导航接管入口）。整文件替换会绕过本地壳造成白屏式回归，故实际按**增量四处**落地（ShellSession 类、@StateObject+@Environment、ShellWebView 传 session、scenePhase onChange），入口 shell 逻辑与现场原有注释全部保留；下面围栏代码中的入口片段已按此修正，其余与落盘一致（个别历史注释措辞以现场为准）。

```swift
import SwiftUI

// ============================================================================
// 入口 + 配置
//
// 两条纪律：
//   ① 不写死任何个人地址：网关地址从 UserDefaults 读，首次为空 ⇒ 界面上让用户填。
//   ② 版本号与主仓同一节奏（0.1.0），不擅升。
// ============================================================================

enum Cfg {
    /// 网关基址（tailnet 明文 http 或 Funnel 的 https 域名）
    static var gateway: String {
        get { UserDefaults.standard.string(forKey: "gateway") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "gateway") }
    }

    /// 入口页：默认控制台（`/app#/`）。内核前端 UI 是 `/index.html`。
    static let entryPath = "/app#/"
}

/// 跨 SwiftUI 视图边界共享的壳会话：让 RootView 的 scenePhase 事件够到
/// ShellWebView.Coordinator 持有的 WKWebView（Coordinator 由 representable 私有创建）。
final class ShellSession: ObservableObject {
    let flusher = BackgroundFlusher(live: ())
}

@main
struct DSHRemoteApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @StateObject private var session = ShellSession()
    @Environment(\.scenePhase) private var scenePhase

    @State private var urlText: String = Cfg.gateway
    @State private var dropped = false
    @State private var titleTaps = 0
    @State private var showS1 = false
    @State private var showS1Alert = false

    var body: some View {
        VStack(spacing: 0) {
            Text("DSH Remote")
                .font(.headline)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .onTapGesture {
                    titleTaps += 1
                    if titleTaps >= 5 {
                        if (try? GatewayURL.normalize(Cfg.gateway)) != nil {
                            showS1 = true
                            titleTaps = 0
                        } else {
                            showS1Alert = true
                        }
                    }
                }

            HStack {
                TextField("网关 https 地址，例如 https://<xxx>.ts.net", text: $urlText)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button("连接") {
                    Cfg.gateway = urlText.trimmingCharacters(in: .whitespaces)
                    dropped = false
                }
                .buttonStyle(.borderedProminent)
                .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(8)

            Divider()

            if Cfg.gateway.isEmpty || dropped {
                ContentUnavailableView(
                    "还没有配置网关",
                    systemImage: "network",
                    description: Text("填上面的 https 网关地址后点「连接」。\n免费账号路径不使用 Tailscale，网关需已开启 HTTPS（Funnel）。")
                )
            } else {
                // TODO(P2)：改成 TabView（写作 / DSH 两个 WebView 常驻，切换不重载）
                // Task 4 起入口为本地壳：normalize().shell = origin/__shell__/shell.html，
                // 由 ShellWebView 的 decidePolicyFor 导航接管换成本地 HTML（不能退回 /app#/）
                let shell = (try? GatewayURL.normalize(Cfg.gateway))?.shell
                    ?? (Cfg.gateway + Cfg.entryPath)
                ShellWebView(session: session, urlString: shell)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .onChange(of: Cfg.gateway) { _, _ in dropped = false }
        .onChange(of: scenePhase) { _, phase in
            // iOS 切后台不触发 pagehide；主动驱动 writing.js 的 session-end 同步落盘
            if phase == .background { session.flusher.flush() }
        }
        .alert("请先填写 https 网关", isPresented: $showS1Alert) {
            Button("好", role: .cancel) {}
        } message: {
            Text("先在上方填写已开启 HTTPS 的网关地址并点「连接」。")
        }
        .sheet(isPresented: $showS1) {
            UIViewControllerBridge {
                S1ViewController(gatewayOrigin: (try? GatewayURL.normalize(Cfg.gateway))?.origin ?? "")
            }
        }
    }
}

struct UIViewControllerBridge<ViewController: UIViewController>: UIViewControllerRepresentable {
    let make: () -> ViewController

    func makeUIViewController(context: Context) -> ViewController { make() }

    func updateUIViewController(_ uiViewController: ViewController, context: Context) {}
}
```

- [ ] **11.6 接线二：`Sources/ShellWebView.swift` 接 session（三处小改，基线为 10.5 之后）**

不整文件重写，按三处定位修改（其余保持 9.6/10.5 定稿不变）：

① `ShellWebView` 增加 `session` 存储属性，并透传给 Coordinator：

```swift
struct ShellWebView: UIViewRepresentable {
    let session: ShellSession
    let urlString: String

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }
```

② `makeUIView` 不再变化（仍由 `attach(to:)` 统一接线）；Coordinator 持有 session 并改 init：

```swift
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var web: WKWebView?
        private var bridge: NativeBridge?
        private let dispatcher: BridgeDispatcher?
        private let session: ShellSession

        static let appVersion: String =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"

        init(session: ShellSession) {
            self.session = session
            // spec §6.1：dataDir=Documents 根，workspaceRoot=Documents/workspace
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let workspaceRoot = docs.appendingPathComponent("workspace", isDirectory: true)
            let made = try? BridgeDispatcher(
                dataDir: docs, workspaceRoot: workspaceRoot, appVersion: Self.appVersion)
            if made == nil {
                NSLog("[dsh-ios] BridgeDispatcher 构造失败，wcStorage 桥未安装（页面走未安装兜底）")
            }
            self.dispatcher = made
            super.init()
        }

        func attach(to web: WKWebView) {
            self.web = web
            // 后台 flush 绑定（无论 dispatcher 是否可用；flushScript 只依赖页面里的 writing.js）
            session.flusher.bind(webView: web)
            guard let dispatcher else { return }
            let bridge = NativeBridge(dispatcher: dispatcher, webView: web)
            self.bridge = bridge
            web.configuration.userContentController.add(bridge, name: "dshBridge")
            // 同步通道（writeDocSync/writeDraftSync），与异步桥共用同一 dispatcher（ioLock 互斥）
            web.configuration.setURLSchemeHandler(
                BridgeSyncSchemeHandler(dispatcher: dispatcher), forURLScheme: "dsh-bridge")
        }
```

要点：① `flusher.bind` 放在 `guard let dispatcher` **之前**——后台收尾只依赖 writing.js 已挂的钩子与同步 XHR 通道；即便 dispatcher 构造失败，脚本执行也只是 `__wcFlushOnSessionEnd` 内部各自报错（页面侧 saveState='error' + keepDraftSync 走 JS 内存草稿），不会崩。dispatcher 失败时同步 XHR 无 handler 会直接失败，被 writing.js 的 try/catch 接住。② Coordinator 对 session 是强引用；flusher 的 evaluator 闭包经 `[weak webView]` 弱挂 webView，RootView 的 `@StateObject` 是 session 的最终持有者；Coordinator 随 representable 释放、session 存活到场景销毁，无环。③ 网关未配置时 RootView 根本不创建 ShellWebView，evaluator 从未绑定，切后台静默 no-op（11.1 `testFlushBeforeBindIsSilentNoop` 已钉）。④ `dismantleUIView` 不调 `unbind()`：改网关触发 representable 重建时，新 Coordinator 的 `attach(to:)` 会用新闭包覆盖 evaluator；若 dismantle 里显式 unbind，在「旧 view dismantle 与新 view attach 交错」时存在把新绑定误清的理论窗口。view 释放后旧闭包的 `[weak webView]` 归零，即便旧闭包被触发也只是空转一次（webView 为 nil 仍回调 completion，begin/end 正常配对），安全。

- [ ] **11.7 构建验证 + Commit 检查点（执行前须征得用户同意）**

执行「模拟器测试命令」+ 一次 Debug 构建（Xcode ⌘B），预期测试全绿、构建无警告外错误。手动冒烟（模拟器即可）：开写作页输入若干字 → 模拟器菜单 Device → Background（或 ⇧⌘H 回主屏）→ 重新进 App，文档仍在、saveState 为已保存（真机留待 Task 13 与⑤同验）。

```bash
git add Sources/BackgroundFlusher.swift Sources/App.swift Sources/ShellWebView.swift \
  Tests/DSHRemoteTests/BackgroundFlusherTests.swift \
  docs/superpowers/plans/2026-10-10-ipad-offline-writing-sync.md
git commit -m "feat(lifecycle): 切后台经 __wcFlushOnSessionEnd 同步落盘写作正文"
```

---

## Task 12：iPad 壳侧触控适配（ipad.css / ipad.js + 白名单 12→14 + rewriter 注入，TDD）

目标（spec §7.3/§7.4/行 221-222）：PC 三栏壳原样内置，**不改任何共享核心**（shell.html/writing.js/2 CSS/10 JS 只读），平台差异只经两个壳侧附加文件与运行时改写承接：

1. 按 id 隐藏 5 个「选目录 / 新建到指定位置」入口（工作区根固定沙盒 `workspace/`，BridgeDispatcher 对选目录方法已回 `NotSupported`）；
2. 分割条触控拖拽跟手（核心已用 Pointer Events + setPointerCapture + `.no-pointer` 盖 iframe，**唯一硬缺口**是 `.w-split-handle` 缺 `touch-action: none`）；
3. ≥44pt 触控热区、禁双击缩放（保留捏合）、惯性滚动、消除 iOS 点击高亮；
4. 软键盘：viewport 增补 `interactive-widget=resizes-content`（rewriter 改写）+ visualViewport resize 兜底保证光标行可见 + 点空白收键盘。

**明确不做**（防止过度设计，等价安卓壳只借模式不搬功能）：① 不重写回网补推——writing.js:3465-3467 核心已绑 `online → refreshToday().then(drainWritingQueue)`，sync-net.js 自有 online/visibility 同步补推，ipad.js **不重复绑定任何 online 钩子**；② 不隐藏 PC 同步横幅 `#w-sync-banner`（与安卓 android-shell.js:1660 相反，既定决策）；③ 不做夜间模式/手机形态改造/FAB/appbar/长按菜单；④ 不多藏任何 spec 未列的控件（特别注意 `#w-ws-create-here`（shell.html:198）与 `#s-ws-create`（:453）**不藏**——它们是「在当前沙盒根新建」，不是「选目录」）。

资产加载联动（本 Task 必须一次改齐，否则启动即崩）：shell.html 原文含 **12** 个 `/__shell__/x.(js|css)` 外链；rewriter 运行时再注入 ipad.css、ipad.js 两个 `/__shell__/` 字面量，正则统一改写后命中 **14** 次；`AssetManifest.names` 必须正好 **14**，否则既有守卫 `hits == 0 || hits == names.count` 抛 `hitCountMismatch`（ShellWebView 导航接管处 `try` 失败 → 白屏）。两新文件落在 `ShellAssets/`，该目录已在 `project.yml` 以 folder reference（`type: folder`）整体入包，**无需改 project.yml / pbxproj**。

- [ ] **12.1 先改测试：AssetManifestTests 计数 12→14**

基线为 Task 2 之后（计数断言名为 `testWhitelistContainsTwelveAssets`、断言 12 且含 writing-count-core.js）。编辑 `Tests/DSHRemoteTests/AssetManifestTests.swift`，把该测试方法整体替换为：

```swift
    func testWhitelistContainsFourteenAssets() {
        XCTAssertEqual(AssetManifest.names.count, 14)
        XCTAssertTrue(AssetManifest.isAsset("writing-count-core.js"))
        XCTAssertTrue(AssetManifest.isAsset("ipad.css"))
        XCTAssertTrue(AssetManifest.isAsset("ipad.js"))
    }
```

同文件 contentType / ping / `../writing.js` 三个测试不动（ipad 走既有扩展名分支：css→`text/css; charset=utf-8`、js→`text/javascript; charset=utf-8`，无需新增断言）。

- [ ] **12.2 先改测试：ShellHTMLRewriterTests 覆盖注入与全链路 14 命中**

编辑 `Tests/DSHRemoteTests/ShellHTMLRewriterTests.swift`，将**整个文件**替换为：

```swift
import XCTest
@testable import DSHRemote

final class ShellHTMLRewriterTests: XCTestCase {
    // 与 ShellAssets/shell.html 的 2 个 CSS 外链同构（head，顺序一致）
    private let cssRefs = #"""
<link rel="stylesheet" href="/__shell__/dsw-tokens.css" />
<link rel="stylesheet" href="/__shell__/writing.css" />
"""#

    // 与 ShellAssets/shell.html 的 10 个 JS 外链同构（body，顺序一致）
    private let jsRefs = #"""
<script src="/__shell__/send.js"></script>
<script src="/__shell__/watch.js"></script>
<script src="/__shell__/editor-plain.js"></script>
<script src="/__shell__/proofread.js"></script>
<script src="/__shell__/sync-core.js"></script>
<script src="/__shell__/writing-count-core.js"></script>
<script src="/__shell__/writing.js"></script>
<script src="/__shell__/send-net.js"></script>
<script src="/__shell__/proofread-net.js"></script>
<script src="/__shell__/sync-net.js"></script>
"""#

    private let shellDoc = #"""
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>写作客户端</title>
__CSS__
<style>
  html, body { margin: 0; }
</style>
</head>
<body>
__JS__
<script>
    // 两页常驻 + display( hidden ) 显隐：不销毁重建（与 shell.html:728-729 同构）
</script>
</body>
</html>
"""#

    private var fullHTML: String {
        shellDoc
            .replacingOccurrences(of: "__CSS__", with: cssRefs)
            .replacingOccurrences(of: "__JS__", with: jsRefs)
    }

    func testRewritesFourteenRefsAndInjectsIPadAssets() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML)
        XCTAssertFalse(out.contains("/__shell__/"))
        XCTAssertTrue(out.contains("dsh-asset://local/dsw-tokens.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/writing.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/writing.js"))
        XCTAssertTrue(out.contains("dsh-asset://local/sync-net.js"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.js"))
        // ipad.css 紧跟 writing.css（级联顺序：壳侧覆盖必须最后）
        let cssAnchor = try XCTUnwrap(out.range(of: "dsh-asset://local/writing.css"))
        let ipadCss = try XCTUnwrap(out.range(of: "dsh-asset://local/ipad.css"))
        let styleTag = try XCTUnwrap(out.range(of: "<style>"))
        XCTAssertLessThan(cssAnchor.upperBound, ipadCss.lowerBound)
        XCTAssertLessThan(ipadCss.lowerBound, styleTag.lowerBound)
        // ipad.js 紧跟 sync-net.js，且在页尾内联脚本之前
        let syncNet = try XCTUnwrap(out.range(of: "dsh-asset://local/sync-net.js"))
        let ipadJs = try XCTUnwrap(out.range(of: "dsh-asset://local/ipad.js"))
        let inlineJs = try XCTUnwrap(out.range(of: "<script>\n    // 两页常驻"))
        XCTAssertLessThan(syncNet.upperBound, ipadJs.lowerBound)
        XCTAssertLessThan(ipadJs.lowerBound, inlineJs.lowerBound)
    }

    func testViewportMetaGetsInteractiveWidget() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML)
        XCTAssertTrue(out.contains("interactive-widget=resizes-content"))
        XCTAssertFalse(out.contains("viewport-fit=cover\""))
        XCTAssertTrue(out.contains("viewport-fit=cover, interactive-widget=resizes-content"))
    }

    func testInjectionIsIdempotent() throws {
        let once = try ShellHTMLRewriter.rewrite(fullHTML)
        let twice = try ShellHTMLRewriter.rewrite(once)
        XCTAssertEqual(once, twice)
        XCTAssertEqual(twice.components(separatedBy: "ipad.css").count - 1, 1)
        XCTAssertEqual(twice.components(separatedBy: "ipad.js").count - 1, 1)
        XCTAssertEqual(twice.components(separatedBy: "interactive-widget=resizes-content").count - 1, 1)
    }

    func testKeepsIframeAndNonShellUrls() throws {
        let html = #"<iframe id="dsh-frame" src="/app#/"></iframe><a href="/auth/login">x</a>"#
        let out = try ShellHTMLRewriter.rewrite(html)
        XCTAssertTrue(out.contains("src=\"/app#/\""))
        XCTAssertTrue(out.contains("/auth/login"))
    }

    func testThrowsWhenHitCountMismatchesWhitelist() {
        let html = #"<script src="/__shell__/writing.js"></script>"#
        XCTAssertThrowsError(try ShellHTMLRewriter.rewrite(html))
    }
}
```

设计说明（执行时照此理解，不要自行改测试）：① `testKeepsIframeAndNonShellUrls` 的内联 HTML 无任何 `/__shell__/` 引用也无注入锚点——注入三步全部 no-op（锚点替换要求锚点存在，见 12.4），命中 0，命中守卫的 `hits == 0` 分支放行，行为与旧测试一致。② `testThrows...` 只有一个 writing.js：CSS/JS 锚点都不在，注入 no-op，命中 1 ≠ 14，继续抛错。③ 幂等测试把**已改写产物**再喂回 `rewrite`：产物中已无 `/__shell__/`、viewport 已含 `interactive-widget`、两注入锚点（writing.css / sync-net.js 的 `/__shell__/` 形态）也已不存在，故三步注入全部跳过——重复改写不产生重复标签。④ `<script>\n    // 两页常驻` 是 shell.html:728-729 的内联脚本起点字面量，用于钉死「ipad.js 在所有外链之后、内联 tab 脚本之前」；若该内联注释日后改动，同步修此断言。

> **主控裁决（Task 12 执行时，2026-10-11）**：原围栏夹具把含 12 引用的 `twelveRefs` 同时替换 `__CSS__`/`__JS__`（夹具实含 24 个 `/__shell__/`，12.5 注入后 26 hits ≠ 白名单 14，`testRewritesFourteenRefsAndInjectsIPadAssets` 必抛 hitCountMismatch），且 `shellDoc` 缺 `<style>` 与 `<script>\n    // 两页常驻` 两个被 XCTUnwrap 的锚点。对照真实 shell.html（head 仅 2 CSS、body 仅 10 JS；L10 `<style>`、L728-729 内联脚本），已把夹具拆为 `cssRefs`（2）/`jsRefs`（10）分别填充并补齐两个锚点，与真实壳同构；落盘测试同步使用修复版。

- [ ] **12.2b 先改测试：同步更新 Task 4 的 ShellNavigationTests（Bundle 集成断言 12→14）**

Task 4 的 `Tests/DSHRemoteTests/ShellNavigationTests.swift` 读的是**真实 Bundle 内 shell.html** 并断言 12 个 `dsh-asset://local/`；12.5 注入上线后真实壳产出变为 14，该测试会变红。把其中测试方法整体替换为（方法名与计数同步改，另补两条注入存在性断言；`/__shell__/` 清零与 iframe 两条断言不动）：

```swift
    func testBundleShellHTMLRewritesFourteenReferences() throws {
        let url = try XCTUnwrap(Bundle(for: ShellNavigationTests.self)
            .url(forResource: "shell", withExtension: "html"))
        let raw = try String(contentsOf: url, encoding: .utf8)
        let out = try ShellHTMLRewriter.rewrite(raw)
        XCTAssertEqual(out.components(separatedBy: "dsh-asset://local/").count - 1, 14)
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.js"))
        XCTAssertFalse(out.contains("/__shell__/"))
        XCTAssertTrue(out.contains("src=\"/app#/\""))
    }
```

若 Task 4 落地时采用了「不依赖 Bundle 的内联 12 引用字符串」退路（见 Task 4 说明），则把该内联测试同样升级为 14 并补两条 ipad 资产断言；不可删除该测试。

- [ ] **12.3 运行测试，验证失败（Red）**

执行「模拟器测试命令」。预期编译通过但测试失败：

```
XCTAssertEqual failed: ("12") is not equal to ("14")
```

且 `testRewritesFourteenRefsAndInjectsIPadAssets` 因产物中没有 `dsh-asset://local/ipad.css`（XCTUnwrap/contains 断言）失败；若任何新断言已通过，说明 12.1/12.2 未生效，停止排查后再继续。

- [ ] **12.4 最小实现一：白名单加 ipad.css / ipad.js**

编辑 `Sources/AssetManifest.swift`，把 `static let names: Set<String> = [` 的列表（Task 2 之后为 12 项）整体替换为：

```swift
    static let names: Set<String> = [
        "dsw-tokens.css", "writing.css", "ipad.css",
        "send.js", "watch.js", "editor-plain.js", "proofread.js",
        "sync-core.js", "writing-count-core.js", "writing.js", "send-net.js",
        "proofread-net.js", "sync-net.js", "ipad.js"
    ]
```

（14 项。新增两名放在各自族的末尾：ipad.css 随 CSS、ipad.js 随 JS；Set 无序，位置只为可读。`contentType` 不改。）

- [ ] **12.5 最小实现二：ShellHTMLRewriter 增加三处注入**

编辑 `Sources/ShellHTMLRewriter.swift`，将**整个文件**替换为：

```swift
import Foundation

enum RewriteError: LocalizedError {
    case hitCountMismatch(Int, Int)
    var errorDescription: String? {
        switch self {
        case let .hitCountMismatch(got, want):
            return "shell 资产引用命中数 \(got) 与白名单 \(want) 不一致"
        }
    }
}

enum ShellHTMLRewriter {
    // 注入用字面量锚点（必须是 /__shell__/ 形态，才能与 12 个外链一起被正则统一改写）
    private static let viewportOld = "viewport-fit=cover\""
    private static let viewportNew = "viewport-fit=cover, interactive-widget=resizes-content\""
    private static let cssAnchor = #"<link rel="stylesheet" href="/__shell__/writing.css" />"#
    private static let cssInjected = #"<link rel="stylesheet" href="/__shell__/ipad.css" />"#
    private static let jsAnchor = #"<script src="/__shell__/sync-net.js"></script>"#
    private static let jsInjected = #"<script src="/__shell__/ipad.js"></script>"#

    /// 仅在锚点存在且未注入过时插入，保证对任意输入（含测试里的无锚点片段）幂等、可重入。
    private static func injectOnce(_ html: String, anchor: String, insertion: String) -> String {
        guard html.contains(anchor), !html.contains(insertion) else { return html }
        return html.replacingOccurrences(of: anchor, with: anchor + "\n" + insertion)
    }

    static func rewrite(_ html: String) throws -> String {
        // 第一步：结构注入（插进去的仍是 /__shell__/ 字面量，与原 12 外链同走下面的正则）
        let withViewport = html.contains(viewportNew)
            ? html
            : html.replacingOccurrences(of: viewportOld, with: viewportNew)
        let withCSS = injectOnce(withViewport, anchor: cssAnchor, insertion: cssInjected)
        let withJS = injectOnce(withCSS, anchor: jsAnchor, insertion: jsInjected)

        // 第二步：白名单引用统一改写（既有逻辑，不动）
        var hits = 0
        let regex = try NSRegularExpression(
            pattern: #"/__shell__/([A-Za-z0-9._-]+\.(?:js|css))"#
        )
        let mutable = NSMutableString(string: withJS)
        let matches = regex.matches(in: withJS, range: NSRange(location: 0, length: (withJS as NSString).length))
        for m in matches.reversed() {
            let file = (withJS as NSString).substring(with: m.range(at: 1))
            guard AssetManifest.isAsset(file) else { continue }
            regex.replaceMatches(
                in: mutable, range: m.range(at: 0),
                withTemplate: "dsh-asset://local/\(file)"
            )
            hits += 1
        }
        guard hits == 0 || hits == AssetManifest.names.count else {
            throw RewriteError.hitCountMismatch(hits, AssetManifest.names.count)
        }
        return mutable as String
    }
}
```

要点：① 注入必须**先于**正则——插进去的就是 `/__shell__/ipad.css|js`，正则阶段自然把它们一并改写，hits 自洽为 14；不要在注入时直接写 `dsh-asset://`（那样注入标签不被计数、也绕过了白名单校验）。② 三个锚点逐字对应 shell.html:5/9/727（含自闭合斜杠与两空格缩进差异：head 的 link 无缩进、尾部 script 有两空格缩进——锚点字符串不含前导空白，`replacingOccurrences` 只匹配标签本身，插入物换行后由锚点原有缩进承接，CSS 锚点行首无缩进故 ipad.css link 也无缩进，与 head 风格一致）。③ viewport 用**字面量**替换而非正则：`viewport-fit=cover"` 带结尾引号，只命中 content 属性结尾，不会误伤；已含 `interactive-widget` 时跳过（幂等）。④ 该函数只在主框架导航接管处对 Bundle 内 shell.html 调用一次（Task 4），测试中的任意片段也安全（无锚点即 no-op）。

> **主控裁决（Task 13.3 首次 CI，2026-10-11）**：CI（Xcode 16.2 / `-swift-version 5`）报 `ShellHTMLRewriter.swift:47: missing argument for parameter 'at' in call`。上方围栏原文 `range: m.range,` 缺 NSTextCheckingResult 的外部参数标签，为围栏自身笔误；落盘整文件转写时逐字照抄导致同样错误。已双侧改为 `m.range(at: 0)`（与同段 L5922 的 `m.range(at: 1)` 一致），语义不变。

- [ ] **12.6 新增 ShellAssets/ipad.css（全文）**

新增 `ShellAssets/ipad.css`，完整内容如下（UTF-8 无 BOM；文件只被 iPad 壳加载，故不包 `@media (pointer: coarse)`——iPad 上永远生效）：

```css
/* ============================================================================
   ipad.css —— iOS 壳侧附加样式（只在 iPad 壳经 rewriter 注入加载）
   铁律：不改 shell.html / writing.css / writing.js 等任何共享核心；
         本文件只做能力裁剪（按 id 隐藏）与触控可用性补偿，不新增产品语义。
   依据：spec §7.3（≥44pt 热区 / touch-action / 惯性滚动 / 不依赖 hover）、
         §7.4（软键盘）、行 221-222（五个选目录入口隐藏）。
   ============================================================================ */

/* ① 能力裁剪：工作区根固定沙盒 workspace/，选目录/新建到指定位置 5 入口隐藏。
   ⚠️ 只藏 spec 行 221 明列的 5 个 id；#w-ws-create-here（当前根新建）、
      #s-ws-create（新建工作区）不藏。!important 压过组件作者样式。 */
#w-pick-root,
#w-ws-switch,
#w-create-root-here,
#s-ws-switch,
#s-ws-create-here {
  display: none !important;
}

/* ② CR-6 分割条：核心已用 Pointer Events + setPointerCapture + 拖拽期 .no-pointer
   盖 iframe（shell.html 内联样式 + writing.js wireSplitHandle），触控唯一硬缺口：
   不声明 touch-action:none 时 WebKit 会把横向拖动识别为滚屏/手势，pointer 事件被取消。 */
.w-split-handle {
  touch-action: none;
}

/* ③ 触控热区补偿到 ≥44×44pt（spec §7.3；iPad 无鼠标，直接放大，不保留 28/32/36 档）。 */
header {
  height: 44px;
}
header .tab,
header .gear {
  height: 40px;
  min-width: 44px;
  padding: 0 14px;
}
/* 写作页按钮基线 36（.md）/28（侧栏 .sm）/24（.w-mini）—— min-height 统一抬到 44；
   min-height 压过 height，视觉上为 44 高的大按钮（触控可用性优先于桌面密度）。 */
#page-writing button {
  min-height: 44px;
}
/* 侧栏卡片右上角 / 文档行右侧的 24×24「⋯」：本体视觉保持 24，
   用 ::before 透明扩展命中区到 44×44（卡片本体已是 ≥56 的整行目标，仅补偿小图标）。 */
#page-writing .w-work-item > .w-more,
#page-writing .w-doc .w-more {
  position: relative;
}
#page-writing .w-work-item > .w-more::before,
#page-writing .w-doc .w-more::before {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
}
/* 卡片本体已是大目标（min-height 56），撤销上面对其 ::before 的误伤无需额外规则
   （.w-card 不匹配 .w-more 选择器）；文档行 .w-doc 整行 40→44： */
#page-writing .w-doc {
  min-height: 44px;
}
/* 设置弹层按钮（.s-btn 28）与输入控件（32） */
.s-btn {
  min-height: 44px;
}
.s-modal input[type="number"],
.s-modal input[type="text"],
.s-modal select {
  height: 44px;
}

/* ④ 禁双击缩放/300ms 延迟，但保留捏合缩放（spec §7.3：不设 user-scalable=no）。
   编辑区/文档展示不列入——那里需要系统手势（选择/滚动/捏合）。 */
html,
body {
  touch-action: manipulation;
}
button,
a,
header .tab,
header .gear,
.s-radio,
.w-goal-chip,
.w-split-handle {
  touch-action: manipulation;
}
/* 分割条在自身规则里再钉回 none（与上面并列时按源序后者胜，本文件②在前故这里重申）： */
.w-split-handle {
  touch-action: none;
}

/* ⑤ 惯性滚动（iOS 传统属性；新版 WebKit 默认即 momentum，声明为兜底，无副作用）。 */
#page-writing .w-tree,
#page-writing .w-editor,
#page-writing .w-sidebar > .w-hint,
#page-writing .w-proof-list,
#page-writing .w-modal-body,
#page-writing .w-import-result,
.s-body {
  -webkit-overflow-scrolling: touch;
}

/* ⑥ 消除 iOS 点击灰色高亮（:active 在触控设备上也无意义，统一透明）。 */
* {
  -webkit-tap-highlight-color: transparent;
}
```

执行前校对类名是否与副本一致（若 PC 端后续改名，以 `ShellAssets/writing.css` 实际类名为准同步本文件）：滚动容器 `.w-tree`（writing.css:305）、`.w-sidebar > .w-hint`（:183）、`.w-proof-list`（:467-470）、发送弹层用 `.w-modal-body`（:224-228）与 `.w-import-result`（:230-236，`#w-send` 本身是 `.w-modal`，**不存在 `.w-send-body` 类**）、设置弹层 `.s-body`（:625）；编辑器滚动元素是 `#w-editor`（contenteditable，shell.html:298；writing.css:370-377 中 `.w-editor` 有 `overflow-y:auto`）。`:hover` 经全量核查**仅用于背景/字色/透明度装饰**（writing.css 66 处 hover 无一例 `display` 显隐切换），不存在「悬停才可见」控件，故无常显兜底规则。

- [ ] **12.7 新增 ShellAssets/ipad.js（全文，窄壳层）**

新增 `ShellAssets/ipad.js`，完整内容如下。职责刻意收窄：只做 spec §7.4 的 visualViewport 兜底与收键盘，**不碰**回网编排、分栏交互、横幅、主题（核心已各自处理）。

```javascript
/* ipad.js —— iOS 壳侧附加脚本（rewriter 在 sync-net.js 之后、内联 tab 脚本之前注入）
 * 只做两件 spec §7.4 的事：
 *   1. visualViewport resize 时让光标行保持可见（interactive-widget=resizes-content
 *      已由 rewriter 写进 viewport meta，此为 WebKit 支持不全时的兜底）；
 *   2. 点编辑区/输入框之外的空白主动 blur 收键盘，并暴露 window.__wciPadDismissKeyboard。
 * 明确不做：online 回网补推（writing.js 核心已绑 online 钩子，不重复）、
 *           分栏 pointer 交互（核心已实现，CSS touch-action 即够）、横幅/主题/手机形态。
 */
(function () {
  'use strict'
  if (window.__wciPadShell) return
  window.__wciPadShell = true

  function activeEditable() {
    var el = document.activeElement
    if (!el) return null
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'SELECT') return el
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t !== 'button' && t !== 'submit' && t !== 'reset' &&
          t !== 'checkbox' && t !== 'radio' && t !== 'range' && t !== 'color') {
        return el
      }
      return null
    }
    if (el.isContentEditable) return el
    return null
  }

  function dismissKeyboard() {
    var el = activeEditable()
    if (el && typeof el.blur === 'function') el.blur()
  }
  window.__wciPadDismissKeyboard = dismissKeyboard

  function keepCaretVisible() {
    var el = activeEditable()
    if (!el || typeof el.scrollIntoView === 'undefined') return
    // block:'nearest' 只在被键盘遮挡时最小滚动，不把页面顶飞
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  var vv = window.visualViewport
  if (vv) {
    var pending = false
    vv.addEventListener('resize', function () {
      if (pending) return
      pending = true
      // 一帧内合并：键盘动画过程中连续 resize 只滚一次
      requestAnimationFrame(function () {
        pending = false
        keepCaretVisible()
      })
    })
    vv.addEventListener('scroll', function () {
      if (pending) return
      pending = true
      requestAnimationFrame(function () {
        pending = false
        keepCaretVisible()
      })
    })
  }

  // 点空白收键盘：命中的不是可编辑元素本身，也不在其内部，且不是分割条拖拽，
  // 也不是任何按钮/链接/开关（那些点按有自己的语义，不该顺带收键盘）
  document.addEventListener('pointerdown', function (e) {
    if (activeEditable() === null) return
    var t = e.target
    if (!(t instanceof Element)) return
    if (t.closest('input, textarea, select, [contenteditable="true"], button, a, label, .w-split-handle')) return
    dismissKeyboard()
  }, true)
})()
```

要点：① IIFE + `window.__wciPadShell` 幂等守卫，与安卓 android-shell.js 的 `__wcAndroidShell` 同模式（脚本即便被意外注入两次也只绑一次）。② `closest` 选择器把分割条（`.w-split-handle`）与所有交互控件排除——拖拽分割条起点不会误收键盘；点列表行/卡片空白才收。③ 用 capture 阶段监听，不阻止默认行为、不 `stopPropagation`，对核心点击逻辑零干扰。④ visualViewport 不存在（旧容器）时静默跳过，不报错。⑤ 不访问跨域 iframe（`#dsh-frame` 内控制台），只在顶层 document 工作。

- [ ] **12.8 运行全部测试，验证通过（Green）**

执行「模拟器测试命令」。预期 `** TEST SUCCEEDED **`：AssetManifestTests（14）、ShellHTMLRewriterTests 五测试全绿，既有 Task 2-11 全部测试不受影响（rewriter 对无锚点输入行为不变）。

随后做一次模拟器手动冒烟（Xcode ⌘B 后跑起）：① 写作页左栏**看不到**「选择目录 / 切换工作区 / 新建到指定位置」5 个入口，而「新建工作区」「新建作品」仍在；② 设置弹层里「切换…」「新建到指定位置…」不见、「新建…」仍在；③ 开分栏后手指拖分割条**跟手不断**、双击回中；④ 点正文区之外空白，软键盘收起；⑤ 键盘弹起时输入光标行不被遮挡（S4 正式验收留 Task 13 真机）。

- [ ] **12.9 Commit 检查点（执行前须征得用户同意）**

```bash
git add Sources/AssetManifest.swift Sources/ShellHTMLRewriter.swift \
  Tests/DSHRemoteTests/AssetManifestTests.swift Tests/DSHRemoteTests/ShellHTMLRewriterTests.swift \
  Tests/DSHRemoteTests/ShellNavigationTests.swift \
  ShellAssets/ipad.css ShellAssets/ipad.js \
  docs/superpowers/plans/2026-10-10-ipad-offline-writing-sync.md
git commit -m "feat(shell): iPad 壳侧触控适配（ipad.css/ipad.js + 白名单 14 + rewriter 注入）"
```

---

## Task 13：CI 全绿 + SideStore 真机总验收（S1 复核 / 离线写作 / 回网同步 / 冲突手选 / S4 键盘 / S6 后台 / S7 分割条）与 S1 收尾

目标：Task 1-12 的全部代码在 GitHub Actions iPad 模拟器全绿并产出未签名 IPA，SideStore 重签装机后在「周晓晨的iPad」（iPadOS 27.0.1）上按 spec §11 验收表与本计划 Goal 逐场景真机验收；验收通过后清理 S1 临时观察代码。本 Task **不写业务代码**（除非真机暴露缺陷，缺陷修复按对应 Task 的 TDD 流程走，不在本 Task 热修）。

前置：Task 1-12 所有 commit 检查点均已在**征得用户同意后**完成；本机无 Xcode，所有 Swift 验证以 CI 结果为准。

- [ ] **13.1 本地静态预检（Windows，推送前必做）**

在 `e:\项目\dsh-remote-ios` 仓根逐条执行。

① 工作区状态干净（`docs/` 下本计划应已在 12.9 随检查点提交；除 iOS 仓既有忽略项外无未跟踪源码）：

```powershell
git -C e:\项目\dsh-remote-ios status -sb
```

② 13 个共享核心资产与 PC 源**逐字节一致**（ipad.css/ipad.js 是 iOS 侧新增，不参与比对）：

```powershell
$names = 'shell.html','dsw-tokens.css','writing.css','send.js','watch.js','editor-plain.js','proofread.js','sync-core.js','writing-count-core.js','writing.js','send-net.js','proofread-net.js','sync-net.js'
$src = 'e:\项目\dsh-remote\writing-client'
$dst = 'e:\项目\dsh-remote-ios\ShellAssets'
$names | ForEach-Object {
  $h1 = (Get-FileHash -LiteralPath (Join-Path $src $_) -Algorithm SHA256).Hash
  $h2 = (Get-FileHash -LiteralPath (Join-Path $dst $_) -Algorithm SHA256).Hash
  "{0} {1}" -f ($h1 -eq $h2), $_
}
```

预期：13 行全部 `True <name>`。任一 `False`：停止，按 Task 1.2/1.3 重拷，**不得**为通过比对而改 PC 源。

③ ShellAssets 下 15 个文件齐全（13 核心 + ipad.css + ipad.js），且全部无 UTF-8 BOM：

```powershell
Get-ChildItem -LiteralPath $dst -File | Sort-Object Name | ForEach-Object {
  $b = [System.IO.File]::ReadAllBytes($_.FullName)
  $bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  "{0} {1}" -f (-not $bom), $_.Name
}
```

预期：15 行全部 `True <name>`（无 BOM）。若文件数不是 15，先补齐/查误增再继续。

④ 反证「核心零改动」：`git status` 中 PC 仓 `e:\项目\dsh-remote` 必须无任何由本计划产生的改动：

```powershell
git -C e:\项目\dsh-remote status -sb
```

预期：与本计划开工前一致（若有本计划造成的改动，全部回退）。

- [ ] **13.2 征得同意后推送分支（不 force push、不改 git config）**

向用户说明：推送目标 `origin/feature/m0-m1-shell`（现有分支），仅触发 workflow_dispatch 的 ios-build，**不打 tag、不合并 main**。用户同意后执行：

```powershell
git -C e:\项目\dsh-remote-ios push origin feature/m0-m1-shell
```

若远端有新提交（他人/CI 机器人），先 `git fetch origin` 并向用户报告分叉情况，由用户决定 rebase/merge；**默认禁止任何强推**（含 `--force` 与 `--force-with-lease`），确有必要时必须再次征得用户同意。

- [ ] **13.3 触发 CI（workflow_dispatch）并跟到全绿**

ios-build.yml 只在手动派发或 `v*` tag 时运行（推送分支本身不触发）。优先用 gh CLI（无需在仓库存任何 Apple 凭据）：

```powershell
gh workflow run ios-build.yml --ref feature/m0-m1-shell --repo skyblade47/dsh-remote-ios
gh run list --workflow=ios-build.yml --repo skyblade47/dsh-remote-ios -L 3
```

取最新一次 run 的 id 后观察（`gh run watch <run-id> --repo skyblade47/dsh-remote-ios`，或浏览器打开 Actions 页）。gh 未登录时改用浏览器：仓库 Actions → ios-build → Run workflow → 分支 `feature/m0-m1-shell`。

过判据（三关全过，任一失败点开失败 step 日志定位）：

1. 「生成 .xcodeproj」成功，objectVersion 为镜像最高 Xcode 可读写；
2. 「运行模拟器逻辑测试」输出 `** TEST SUCCEEDED **`——涵盖 Task 2-12 全部测试（AssetManifest 14、ShellHTMLRewriterTests 五测试、ShellNavigationTests 14 命中、PathGuard/WorkspaceStore/AppDataStore/OutboxStore/BridgeDispatcher/BridgeSyncSchemeHandler/BackgroundFlusher 等）；
3. Release 编译 + 打包成功，产物 `DSHRemote-unsigned.ipa` 上传为 artifact `DSHRemote-unsigned-ipa`，`unzip -l` 自检含可执行文件。

- [ ] **13.4 下载未签名 IPA（Windows）**

```powershell
gh run download <run-id> -n DSHRemote-unsigned-ipa -D e:\项目\dsh-remote-ios\build-artifacts --repo skyblade47/dsh-remote-ios
Get-ChildItem e:\项目\dsh-remote-ios\build-artifacts
```

浏览器路线：Actions run 页 → Artifacts → DSHRemote-unsigned-ipa（zip 内即 .ipa）。`build-artifacts/` 若未被 .gitignore 覆盖，确认不提交（产物不入库）。

- [ ] **13.5 SideStore 重签装机（用户在 iPad 端操作，助手只给步骤）**

沿用已验证的 S2 链路（有线配对记录已在）：iPad 与电脑同 Tailscale 网络并非必需（SideStore 重签是本机行为）；把新 IPA 传到 iPad（文件 App / 现有导入方式）→ SideStore 导入「DSHRemote-unsigned.ipa」→ 用美区专用 Apple ID 在**设备端 GUI** 完成本地重签安装（密码由用户本人输入，助手不接触、不记录、不落盘任何凭据）→ 覆盖安装后确认版本为本次构建。

免费账号限制如实预期：签名 7 天有效、SideStore VPN 项负责自动续签；若打开即闪退，先在 SideStore 手动续签再开。

- [ ] **13.6 真机验收 A：S1 五探针在正式构建上复核（含同步 XHR 能力的最终结论）**

iPad：连 Tailscale → 打开 DSHRemote → 网关配置页连点标题 5 次进入 S1 → 先登录一次 → 运行探针。逐项确认全绿：

1. origin = 网关 origin；
2. fetch `/auth/login` 带 Cookie 返回业务成功（**注意：HTTP 200 ≠ 业务成功**，看探针 JSON/页面判定，不只看状态码）；
3. iframe `/app#/` 不被 frame-ancestors 拒；
4. 同步 XHR `dsh-asset://local/ping` 拿到 `{ok:true,echo:"pong"}`；
5. 同步 XHR `dsh-bridge://sync?m=__ping__` 拿到 `{ok:true,echo:"bridge-pong"}`。

**关于 Task 3.4 遗留观察项**：探针⑤只能证明「自定义 scheme + 同步 XHR 当场回包」，不证明请求体可读（`WKURLSchemeTask.request.httpBody` 可能为 nil）。Task 10 主线按「body 可读」实现，**13.7 的离线落盘场景即是请求体可读与否的真机终审**：若同步 `writeDocSync`/`writeDraftSync` 在真机落盘成功，body 路径成立，10-bis 不执行；若真机出现原生侧收到空 body（草稿/文档落不进去），**停止后续验收，执行 10-bis 退路**（query 传参，不改 writing.js），重走 13.2-13.6。

截图归档五探针报告页；任一探针变红按 spec §3.6 回退顺位处理，不进入 B/C。

- [ ] **13.7 真机验收 B：离线写作与持久化（Goal 第一半，对应 M3 / S6）**

iPad 连 Tailscale 并确认写作页正常加载、登录态有效后：

1. **断网**：iPad 关 Wi-Fi（无蜂窝机型即全离线；不断 Tailscale 而只断 Wi-Fi 亦可），写作页保持已加载状态；
2. 打开一个既有作品文档，正文区连续输入若干段中文 + 粘贴一段长文本，等自动保存周期过后，确认保存状态指示为「已保存（本地）」语义、无红色失败横幅；
3. 新建作品：左栏「新建作品」（确认可见）创建一篇离线新文档并输入内容，等自动保存；
4. **杀进程**：上滑回主屏 → 上划杀 DSHRemote → 重新打开（仍断网）→ 进入同一工作区，**两篇文档内容完整还在**（S6 过判据：内容完整、重开在）；
5. 草稿兜底：在正文区输入后制造一次未走完保存周期的退出（快速杀进程），重开后按 PC 既有交互确认「重试保存 / 打开草稿」横幅行为与 PC 一致。

任一项丢失：抓 syslog（Console.app 按进程过滤或 Xcode Devices 日志），区分 Store 层（PathGuard/原子写）与同步 XHR body 问题，回到对应 Task 修复。

- [ ] **13.8 真机验收 C：回网同步（保存即推 / 打开比对 / 回网补推）**

保持 13.7 的本地改动：

1. 重开 Wi-Fi / Tailscale 回网；writing.js 核心的 `online → refreshToday().then(drainWritingQueue)` 与 sync-net.js 补推应自动发起，**不依赖**手动杀进程；
2. 观察左栏/顶部同步状态从待同步转为已同步，`#w-sync-banner`（本端不隐藏）无错误态；
3. 用 PC 客户端（或控制台）打开同一文档，确认 iPad 离线编辑内容**已在服务端**（保存即推/补推成功的业务判据，不只是 iPad UI 变绿）；
4. 打开比对：在另一台端改动同一文档后回到 iPad 打开它，确认拉到的是服务端新版本而非旧缓存。

- [ ] **13.9 真机验收 D：双改冲突手选（既定决策，不盲盖）**

1. iPad 断网状态下编辑文档 X 的正文（本地版）；
2. PC 客户端对**同一文档 X** 做另一处不同编辑并保存成功（远端版）；
3. iPad 回网触发同步：确认出现 PC 既有的冲突处理横幅/四动作（`#w-sync-banner`），同步层走 sync-core.js 三态判定为「双改」；
4. 选择「保留冲突手选」语义动作，确认：本地版**未被远端盲盖**、远端版**未被本地盲盖**，可手动比对后保留目标版本；outbox 中该文档在处理完成前后行为符合 §6.2（outboxList/outboxRemove 语义）。

若实际行为是任何一端被静默覆盖：**判定不通过**，回查 BridgeDispatcher/sync 链路与核心三态输入是否完整，禁止改核心 JS 兜底。

- [ ] **13.10 真机验收 E：软键盘不遮光标（S4）**

1. 点正文区末尾调出软键盘，连续回车把光标推到屏幕最低处，确认**光标行始终可见**（viewport 的 `interactive-widget=resizes-content` 生效；不生效时 ipad.js visualViewport rAF 兜底 scrollIntoView nearest 生效）；
2. 在「发送」弹层（`#w-send`）底部 input/textarea、设置弹层 textarea（`#s-send-intents`）中重复，均不被键盘遮挡；
3. 点正文/输入框之外的空白区域，软键盘**收起**；点按钮、链接、label、分割条、卡片行内控件时不误收键盘（ipad.js 排除清单）；
4. 键盘动画过程中页面不被顶飞、无明显多次跳动（一帧合并生效）。

- [ ] **13.11 真机验收 F：CR-6 分割条与触控热区（S7 + spec §7.3）**

1. 开分栏（正文 + 任务中心 iframe）：手指按住分割条拖动，**跟手不断**——iframe 不抢指针（`.no-pointer` + setPointerCapture），拖到任意位置停住；双击分割条回中；
2. 拖分割条的起手式不会误触发收键盘；
3. 抽查热区：左栏 `.w-doc`/`.w-card`/`.w-more`（视觉仍 24px，但 44×44 透明扩展区可点）、header `.tab`/`.gear`、`.s-btn`、弹层 input/select，手指点按无明显误触；
4. 双击页面按钮不触发页面缩放（manipulation 生效），双指捏合缩放仍可用；点击无灰色高亮块；
5. 五入口复核：写作页 `#w-pick-root`/`#w-ws-switch`/`#w-create-root-here`、设置弹层 `#s-ws-switch`/`#s-ws-create-here` 不可见；而「新建工作区」`#s-ws-create`、沙盒根新建 `#w-ws-create-here`、「新建作品」均在且可用。

- [ ] **13.12 真机验收 G：登录态持久与回环门（M1 回归，快验）**

杀进程重开（联网）：不需重新登录（Cookie 持久）；打开「模型设置」，提供方列表正常加载（ownsHost 注入解回环门、顶层与同源 iframe 均读到标记，S3）。

- [ ] **13.13 验收结论记录与失败分流**

把 A-G 的结论（通过/失败 + 截图/syslog 证据）汇报给用户。失败分流原则：

- 资产/注入/白名单问题 → Task 12；桥同步 body 空 → Task 10-bis；后台不落盘 → Task 11；存储内容错 → Task 6/7；导航/origin/Cookie → Task 3/4。
- 任何修复都按所属 Task 的 TDD 步骤（先改测试/Red/实现/Green）与全局约定（commit 前征得同意）走，修完重跑 13.2 起整条链路。
- S5（竖屏/分屏窄窗折叠）与 S8（外接键盘快捷键）**不在本期 Goal 的必验范围**（spec M2/M3 判据只要求三栏可触控编辑、键盘不遮光标、断网可写落盘）；如用户现场有外接键盘可顺手验 S8（⌘S/Ctrl+S 保存），不阻塞验收。

- [ ] **13.14 S1 收尾：移除临时观察代码，调试入口去留由用户拍板**

验收通过后：

1. 若 Task 3.4 在 `S1BridgePingHandler`（或正式 handler）里加过临时 `NSLog("httpBody bytes=…")` 观察行，**删除该临时代码**（探针⑤本身与五探针页保留与否见下条）；删除后按 13.2-13.3 重跑一次 CI 确认全绿（这是收尾改动，不需再走完整真机 A-G，安装新版确认探针页可打开即可）。
2. spec §3.6 对 S1 入口的原话是「M0 完成后保留为调试菜单项或随版本移除，届时再定」。用 AskUserQuestion 向用户确认二选一：
   - **保留**（推荐）：连点标题 5 次的隐藏入口 + S1ProbePage/S1ViewController 留在代码中，作为后续 iOS 升级的回归诊断页（零正常路径干扰）；
   - **移除**：删除 S1 入口、S1ProbePage、S1ViewController、S1BridgePingHandler 及 3.x 相关接线（单独一个 commit，同步删对应测试/资源引用，CI 全绿）。
3. 收尾 commit（若有删临时代码；执行前征得同意）：

```bash
git add Sources/S1ViewController.swift Sources/S1ProbePage.swift
git commit -m "chore(s1): 移除探针临时 httpBody 观察日志（五探针验收通过）"
```

若用户选择移除整套 S1，commit message 用 `chore(s1): 验收通过后移除 S1 探针页与隐藏入口`，`git add` 以实际删除文件为准。

- [ ] **13.15 交付汇报（不自动合并、不自动打 tag）**

向用户汇报：CI run 链接与结果、IPA 产物位置、A-G 各项真机结论、S1 收尾选择、本期对照 Goal 的完成度（离线写作/重开在/保存即推/回网补推/冲突手选）。后续 `feature/m0-m1-shell` 是否合并 main、是否打发布 tag（会触发 CI 产出同名工件）**一律等用户明确指令**；不 force push、不改 git config、不在 CI 配置任何 Apple ID 凭据。

---


