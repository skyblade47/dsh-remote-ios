# iPad 上传同步兜底：壳侧发件箱补推（outbox drain）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **先评审、后实现；未获明确批准不得写实现代码、不得 commit/push、不得动服务端/ACL。**

**北极星（用户原话）：**「我需要确保的是自动保存和上传同步可用。最后，才是内核可用。」

**Goal:** 在不改任何 web 共享核心资产、不改原生 Swift 的前提下，让 iPad 在**离线/弱网期间产生的正文改动，在回网/重启/重新登录后被可靠补推到服务端**，补齐当前「上传同步」链路唯一的持久化缺口。自动保存（本地 `flush()`→`api.writeDoc`，断网零字节可用）已在既有实现中满足，本计划只补「上传同步」这一半。

**一句话方案：** 把安卓壳早已上线的 JS 侧发件箱消费逻辑（`android-shell.js` 的 `drainOutbox()` + `installSaveHook()` + 基线读写）按 iPad 裁剪后，**移植进 iOS 专属注入脚本 `ShellAssets/ipad.js`**。原生侧三件套（`OutboxStore` 持久化、`writeDoc` 成功自动入队、`outboxList`/`outboxRemove` 桥）早已就绪，本计划**零原生改动**。

---

## 0. 背景与缺口（为什么是现在这个落点）

### 0.1 三条写作弱网链路与优先级

| 链路 | 现状 | 本计划 |
|---|---|---|
| 自动保存（纯本地） | 编辑器 `flush()`→同步桥 `writeDocSync`/异步 `writeDoc` 落 Documents，断网零字节可用 | 不动（已满足北极星第一句） |
| **上传同步** | 在线时 `writing.js` 经 `WCSyncNet.saveDraft` 同源小 JSON POST；**离线分支仅 `syncNotice('未同步…改动留在本地')` 并 `return null`，无任何持久重放队列** | **本计划补齐** |
| 内核（DSH iframe，~10MB） | 优先级最低，弱网延后 | 不做 |

用户已明确：「不需要缓存，弱网可用，我可以接受只有写作页面可用」。故不做离线内核/Service Worker 缓存。

### 0.2 缺口的代码事实（2026-10-24 复核坐实）

1. **原生侧早已入队，但没有 JS 消费方。**
   - [BridgeDispatcher.swift](file:///e:/项目/dsh-remote-ios/Sources/BridgeDispatcher.swift) 私有 `writeDoc` 落盘成功即 `outbox.add(relPath)`；`outboxList`/`outboxRemove` 已在 [BridgeDispatcher.swift#L167-L171](file:///e:/项目/dsh-remote-ios/Sources/BridgeDispatcher.swift#L167-L171) 分发，并在 [BridgeJS.swift#L19](file:///e:/项目/dsh-remote-ios/Sources/BridgeJS.swift#L19) 白名单暴露。
   - 但全仓没有任何 JS 调用 `outboxList`/`outboxRemove` 去补推——队列只进不出。
2. **writing.js 的 online 钩子不补推正文。** [writing.js](file:///e:/项目/dsh-remote-ios/ShellAssets/writing.js) online 监听只做 `refreshToday`/`drainWritingQueue`（字数上报）与 `syncDrainPendingOps`（仅 archive/restore/purge），不重放正文保存。
3. **iOS 桥没有 `syncPendingOps`。** writing.js `initSync` 仅在 `api.syncPendingOps` 存在时载入待发；iOS 无此方法 ⇒ 该路径在 iOS 上是空的。
4. **旧计划的假设已被证伪。** [2026-10-10-ipad-offline-writing-sync.md](file:///e:/项目/dsh-remote-ios/docs/superpowers/plans/2026-10-10-ipad-offline-writing-sync.md) File Structure 表 L50 与 [ipad.js#L14](file:///e:/项目/dsh-remote-ios/ShellAssets/ipad.js#L14) 都写「回网补推由 writing.js 核心已有 online 钩子承接，此处不重复」。代码事实是该钩子不补推正文。本计划修正这一假设。

### 0.3 为什么落点必须是 ipad.js（不能进 writing.js）

- SHA256 实证：iOS 与 PC 的 `writing.js`（317869 字节，`724C6046…`）与 `sync-core.js`（`33E1409…`）**逐字节一致**，是 iOS/PC 共享主干；安卓 `writing.js` 是旧分叉。在 `writing.js` 改会污染 PC，违反「web 核心一字不改」铁律。
- `ipad.js` 由 `ShellHTMLRewriter` 插在 `sync-net.js` 之后、内联脚本之前，执行时 `window.WCSyncNet`、`window.WCSync` 均已存在；且已有 `hostSessionState` 会话探针、`listDrafts` 闸门、登录成功后合成 `online` 事件等可直接复用的设施。
- CI 仅断言 `ipad.js` 的**注入位置/顺序/幂等**（[ShellHTMLRewriterTests.swift#L61-L91](file:///e:/项目/dsh-remote-ios/Tests/DSHRemoteTests/ShellHTMLRewriterTests.swift#L61-L91)、[ShellNavigationTests.swift#L14-L15](file:///e:/项目/dsh-remote-ios/Tests/DSHRemoteTests/ShellNavigationTests.swift#L14-L15)），**无内容哈希断言**。故只改 `ipad.js` 不需要改任何 Swift 测试。

### 0.4 蓝本

安卓壳的 JS 侧补推已上线，是本计划的一比一语义蓝本（**不是**原生后台上传器；iOS 无原生后台上传能力，走 JS drain 与蓝本同构）：

- [android-shell.js `drainOutbox()` L1537–1651](file:///e:/项目/dsh-remote/dsh-remote-android/app/src/main/assets/shell/android-shell.js#L1537-L1651)
- [android-shell.js `installSaveHook()` L927–949](file:///e:/项目/dsh-remote/dsh-remote-android/app/src/main/assets/shell/android-shell.js#L927-L949)
- [`latestBaseline()`/`applySyncedBaseline()` L1455–1475](file:///e:/项目/dsh-remote/dsh-remote-android/app/src/main/assets/shell/android-shell.js#L1455-L1475)
- 触发点：启动 L2127–2137、`online` L1430–1436、原生网络回调 L1441–1452、`visibilitychange` L1653–1659、登录成功 L1241–1250。

---

## 1. 全局约定（沿用总计划，每个 Task 都适用）

1. 文本文件一律 **UTF-8 无 BOM**，行尾跟随仓库现状（`ipad.js` 为 LF）。
2. **web 共享核心资产一个字节都不改**：`writing.js`、`sync-core.js`、`sync-net.js`、`shell.html`、其余 9 个 JS/CSS 一律只读。改后用哈希复核与 PC 源仍一致。
3. **零原生改动**：本计划不改任何 `.swift`、不增删桥方法、不改 `project.yml`/AssetManifest。
4. 只改一个文件：[ipad.js](file:///e:/项目/dsh-remote-ios/ShellAssets/ipad.js)。不新增仓库内文件（验收用一次性控制台片段/真机操作，不落盘进仓）。
5. **默认不 commit、不 push、不推 CI**；每个检查点 commit/推 CI/装机前都必须先征得用户同意。
6. 不动服务端、不动网关、不动 tailnet ACL/derpMap。
7. 不带入任何安卓个人常量；本计划也不新增任何硬编码域名/账号。
8. iOS 仓**无 package.json、无任何 `*.test.js`**，JS 无 node 单测基建。验证策略见 Task 4（语法预检 + 共享资产哈希 + 手工/真机场景验收），不为此新建 JS 测试框架（避免过度工程）。

---

## 2. File Structure（职责边界）

| 文件 | 职责 | 本计划动作 |
|---|---|---|
| `ShellAssets/ipad.js` | iOS 壳侧附加脚本 | **唯一改动文件**：新增「发件箱补推」模块（drain + saveDraft 咽喉钩子 + 基线读写 + 安装即补推/online/可见/登录触发 + 弱网有界退避重试），并修正文件头 L14 那条已被证伪的「不做回网补推」注释 |
| `ShellAssets/writing.js` `sync-core.js` `sync-net.js` `shell.html` 等 | iOS/PC 共享核心 | **只读，零改动**（哈希复核） |
| 全部 `Sources/*.swift`、`Tests/*.swift`、`project.yml` | 原生与 CI | **零改动**（CI 不断言 ipad.js 内容） |

**新增代码在 ipad.js 内的装配位置（关键顺序约束）：**

- 现状：`installCloudSession()` 内先 `installListDraftsGate()`（包装 `WCSyncNet.listDrafts`），成功后 `probeHostSession()` 并绑定 online 重探；文件尾部在 `WCSyncNet` 就绪后轮询安装。
- 新增：一个 `installOutboxDrain()`，与 `installCloudSession()` **同机安装**（同一个「`WCSyncNet` 就绪」轮询里，在 listDrafts 闸门包装**之后**再包装 `saveDraft`）。钩子包裹顺序固定为：**先包 `listDrafts`（会话闸门），再包 `saveDraft`（出队/single-flight）**。两者包装的是 `WCSyncNet` 上不同方法，互不干扰；drain 内部调用 `listDrafts()` 时会自然经过会话闸门（无会话时被挂起，与 writing.js 同等待遇），这正是期望行为。
- drain 主体与触发点放在 IIFE 内、`installCloudSession` 之后，仅在 `gatewayConfigured()` 为真时启用（未配网关 = 纯本地，无云端可推）。

---

## 3. 语义规格（移植时必须逐条保留的判据）

### 3.1 drain 一轮的前置守卫

- 重入锁：模块级 `draining` 布尔，在途则直接 `return Promise.resolve()`。
- 在线判定：iOS **无** `nativeOnline` 桥（蓝本里的 `window.__wcNativeNet` 不移植），一律用 `navigator.onLine`。`!navigator.onLine` ⇒ 整轮不跑。
- 会话判定：复用 ipad.js 既有 `hostSessionState`（null/true/false 三态）。
  - `hostSessionState === false`（已确认本 host 无会话）⇒ 不跑（无会话 `saveDraft` 只会被 302 到登录页）。
  - `null`（探针在途/离线 fail-open）⇒ **不拦**，继续；后续 `listDrafts` 自身 fail-closed。
- 未配网关 ⇒ 不安装/不跑。

### 3.2 先拉远端索引；拉不到就整轮中止（fail-closed，绝不猜删除）

1. `window.WCSyncNet.listDrafts()`（经会话闸门）。
2. 返回非 ok / 无 `data`，或 `window.WCSync.indexList(data).known === false` ⇒ `draining=false`，`console.warn`，**整轮中止**，outbox 原封不动。
3. 得到 `index`（`{known, byRel, archived, purged, tomb, …}`）。`byRel` 的键已是本地 rel，值 `{version, bytes, mtime}`。

> 原则：**远端未知 ≠ 远端没有**。绝不能因为 `readDraft` 404 就推断云端被删。

### 3.3 逐条串行裁决（`outboxList()` → `entries.slice()` → 递归 `next()`）

对每条 `e = {relPath, queuedAt}`：

1. **墓碑优先**：`index.tomb[e.relPath]` 真 ⇒ 云端真删（在回收目录）。`outboxRemove(relPath)` 出队，**不补推、不复活**，`next()`。（iPad 不搬安卓的 missingSheet/角标 UI；仅 `console.info` 留痕。）
2. 取本地正文：`window.wcStorage.readDoc(relPath)`；非 ok ⇒ `next()`（本地读不到，不删队，下次再试；与蓝本一致）。
3. 计算：
   - `hit = index.byRel[relPath] || null`
   - `localVersion = WCSync.versionOf(content)`
   - `localBytes = new TextEncoder().encode(content).length`（异常回退 `content.length`）
   - `baselineVersion = WCSync.baselineVersionOf(baseDoc, relPath)`，其中 `baseDoc` 来自 `latestBaseline()`。
4. 调 `window.WCSync.decidePush({localVersion, localBytes, baselineVersion, remoteKnown:true, remoteExists:!!hit, remoteVersion: hit?hit.version:'', remotelyDeleted:false})`，按 `d.action` 分支：
   - **`skip`**（内容未变/同源同内容）：`applySyncedBaseline(rel, hit.version)` 后 `outboxRemove` 出队，`next()`。
   - **`remote-deleted`**：出队，不补推（墓碑口径），`next()`。
   - **`remote-newer` / `conflict`**：**留队**，`console.warn`，`next()`。**绝不自动 force、绝不盲盖**。用户下次在 writing.js 打开该文档时，核心既有横幅/四动作冲突处理自然接管。
   - 其它非 `push`：留队，`warn`，`next()`。
   - **`push`** 且 `!hit && d.reason==='reupload'`（有基线但云端正文与墓碑双缺 = 服务端存储漂移）：**留队不自动重建**（蓝本「缺陷 C」：这不是自动重建的授权），`warn`，`next()`。
   - **`push`（正常）**：`saveOpts = d.baseVersion ? {baseVersion:d.baseVersion} : null`；调 `window.WCSyncNet.saveDraft(rel, content, saveOpts)`：
     - `sr.ok`：`applySyncedBaseline(rel, sr.version)`（**先用响应 version 更新基线，再出队**，否则下次误判冲突，spec §5.2）→ `outboxRemove(rel)` → `next()`。
     - `sr.conflict`（409）：留队，`warn`，`next()`，不 force。
     - 其它失败（网络/5xx/status 0）：**留队**，`warn`，`next()`，下次回网/重启再试。
5. 单条任何异常 ⇒ `catch` 里 `warn` 后 `next()`，**不阻断后续条目**。
6. 队列空：`draining=false`。iPad 端收尾只做轻量状态刷新（见 3.5），不搬作品墙/missingSheet。

### 3.4 saveDraft 咽喉钩子（single-flight + 成功出队）

包装 `window.WCSyncNet.saveDraft`（蓝本 spec §6.25/§6.44）：

- **成功即出队**：在线写作经 writing.js `syncPush`→`saveDraft` 直推成功后，原生侧在当初 `writeDoc` 时无条件 `outboxAdd` 的条目无人移除；故在这个「所有上行的唯一咽喉」上，`r.ok` 且 `rel` 存在时 `wcStorage.outboxRemove(rel)`。出队失败不影响保存结果（`.catch(()=>r)`）。
- **single-flight 去重**：键 = `rel + '|' + base + '|' + text.length + '|' + djb2Hash(text)`，其中 `base = opts.baseVersion != null ? String(opts.baseVersion) : (opts.force ? 'force' : '')`；`djb2` 初值 5381，长文（>4000 字）按 `step=ceil(len/2000)` 采样。同键在途调用复用**同一个 Promise**，不发第二个请求。
  - 目的：回网瞬间 writing.js 核心的在途推送与壳 drain 可能对同一文档、同一正文、同一 baseVersion 各发一次；服务端让第一个成功、第二个 409，核心会把第二个误判成冲突。single-flight 从根上消掉第二个请求。
- 幂等：`net.__wciSaveHook` 标志，已包则跳过。

### 3.5 基线读写（读—改—写，失败不阻断出队）

- `latestBaseline()`：`wcStorage.syncBaseline()` → `br.ok && br.baseline ? br.baseline : 内存缓存`；异常回退缓存。iOS 返回形态已核实（[AppDataStore.swift#L406-L435](file:///e:/项目/dsh-remote-ios/Sources/AppDataStore.swift#L406-L435)）：`readBaseline()` 回 `{ok:true, baseline:{version,items}}`，`writeBaseline()` 回 `{ok:true,bytes}`——与安卓蓝本 JS 的 `br.baseline` / `syncBaselineSet(next)` 取值逐字对齐，无需 JS 侧适配。
- `applySyncedBaseline(rel, remoteVersion)`：无 version 直接 resolve；否则读基线 → `WCSync.updateBaseline(base, rel, remoteVersion, Date.now())` → `wcStorage.syncBaselineSet(next)`；任一步失败只 `warn`，**不阻断 outbox 清理**（基线丢失仅退化为内容哈希比对，不影响数据正确性）。

### 3.6 iPad 裁剪：不搬什么

明确**不移植**安卓壳下列部分（iOS 无对应 UI / 无原生桥）：

- `conflictSet`/`missingSet`/`outboxSet` 内存集合与树视图角标（`⚠ 冲突`/`云端已删`/`待同步`）、`renderBadges`/`badgeForRel`。
- 作品墙刷新 `refreshWorksWall`（点 `#w-refresh`）、`maybeOpenMissingSheet` 决策浮层、`reconcileMissingOnTree` 进树重扫。
- `window.__wcNativeNet` 原生网络回调与 `nativeOnline`（iOS 用 `navigator.onLine`）。
- `installWriteHook`（仅为安卓角标去抖刷新服务）、`drainWritingQueue`/字数上报/提醒等无关逻辑。

**用户可感知反馈（最小化）**：drain 不在页面新增任何横幅/角标/浮层。补推成功/留队全部走 `console.info/warn`，排障可读；用户侧的「已同步/未同步」状态仍由 writing.js 既有的 `syncNotice`/`#w-sync-state` 与 PC 冲突横幅表达。理由：北极星是「可用」而非新增 UI，且 writing.js 打开文档时会自行比对、自然暴露冲突/已同步态，避免双份状态互相打架。

### 3.7 触发点（共 4 个事件源 + 1 个有界退避重试，全部复用既有设施）

1. **安装即 drain（无定时器）**：`installOutboxDrain()` 成功后**立即**调一次 `drainOutbox()`，不设延时。依据：ipad.js 执行时 `WCSync`/`WCSyncNet`/`wcStorage` 已全部就绪（rewriter 保证 ipad.js 在 sync-core/sync-net/writing 之后），drain 不依赖 writing.js init；此时若 `hostSessionState===null`（探针在途），drain 内的 `listDrafts()` 会被会话闸门挂起，探针成功（release）或登录成功（release + 合成 online）后自然兑现；探针离线 fail-open 放行后索引失败则整轮中止、条目保留，由后续 online/重试承接。若 `hostSessionState===false` 或离线，drain 自身守卫直接返回，不发请求。
2. **`window` online 事件**：回网即 `drainOutbox()`。登录成功也走这条——ipad.js 登录成功处已手动 `window.dispatchEvent(new Event('online'))`（[ipad.js#L516](file:///e:/项目/dsh-remote-ios/ShellAssets/ipad.js#L516)），无需为登录单独再绑。
3. **`document` visibilitychange**：`!document.hidden && navigator.onLine` 时 `drainOutbox()`（从后台切回/熄屏恢复补一次）。
4. 登录成功的合成 online 已被 #2 覆盖；不另设第 4 个绑定。

> 注意与既有 online 监听共存：`installCloudSession` 里已有一个 online 监听用于重探会话。新增 drain 的 online 监听**独立绑定、不替换**它。登录瞬间会有「安装即 drain 的挂起调用兑现」与「合成 online 触发的新 drain」两轮并发，由 `draining` 重入锁合并为一轮。

### 3.8 持续弱网有界退避重试（北极星「确保可用」的关键，比安卓蓝本多加的一件事）

事件触发覆盖不了的场景：用户**一直停在写作页**、Wi‑Fi 仍关联（`navigator.onLine===true`）但国际链路抖动，`saveDraft` 超时（20s）/`listDrafts` 失败。此时没有 online/visibility 事件，失败条目会一直停到用户切后台。故增加纯 JS 定时器重试：

- drain 一轮内维护 `hadTransientFailure`：下列任一发生即置真——索引拉取失败/known:false 整轮中止、某条 `saveDraft` 返回非 ok 且**非** conflict（status 0/5xx/超时等网络型失败）、readDoc/outbox 桥调用抛错。
- 一轮结束时：
  - 若**仍有条目且 `hadTransientFailure`** ⇒ `scheduleDrainRetry()`：延时序列 15s→30s→60s→120s→300s，**封顶 300s（5min）**，到点若 `gatewayConfigured() && navigator.onLine && hostSessionState !== false` 则再 drain；否则跳过本次等下个延时（不联网不发包）。
  - 一旦某条 push 成功（出队发生）⇒ 退避重置回 15s。
  - 一轮结束 outbox 已空 ⇒ `clearDrainRetry()`，不留定时器。
- **纯判定性留队不重试**：`skip`/`remote-deleted` 当轮出队；`conflict`/`remote-newer`/reupload 存储漂移留队且**不计入** `hadTransientFailure`（这些等用户在 writing.js 处理，反复拉索引无意义）。即：若剩余条目全是这类，不挂重试，只由事件触发点在下次回网/可见时复核。
- 全应用最多一个重试 timer（模块级单例，与 `draining` 锁同位）；页面卸载自然回收；不做持久化 backoff（冷启动由 #1 重新开始）。
- saveDraft 咽喉钩子也兜底：内核直推网络失败（`!r.ok && !r.conflict`）时确保重试计时器已挂上（防止失败发生在两次 drain 之间、且没有新事件）。

---

## 4. Task 分解

> 全程只改 [ipad.js](file:///e:/项目/dsh-remote-ios/ShellAssets/ipad.js)。建议在独立分支（如 `feature/ipad-outbox-drain`）进行，分支创建/commit/推 CI 均需用户同意。

### Task 1：修正文件头注释 + 搭出模块骨架与装配

- [x] **1.1** 把 [ipad.js#L14](file:///e:/项目/dsh-remote-ios/ShellAssets/ipad.js#L14)「明确不做：online 回网补推（writing.js 核心已绑 online 钩子，不重复）」改写为「**做**：壳侧发件箱补推（writing.js online 钩子经核实不补推正文、iOS 无 syncPendingOps 桥、OutboxStore 无 JS 消费方），移植安卓 drainOutbox，详见 plan 2026-10-24」。
- [x] **1.2** 在 IIFE 内、`installCloudSession` 之后新增模块骨架：`draining` 锁、`onlineNow()`（`navigator.onLine`）、`installOutboxDrain()`（守卫 `gatewayConfigured()`、检查 `window.WCSync`/`WCSyncNet`/`wcStorage` 及所需函数齐备、`__wciOutboxDrain` 幂等标志）。
- [x] **1.3** 接线：把 `installOutboxDrain()` 纳入文件尾部现有「云端会话」就绪轮询——在 `installCloudSession()` 成功的同一次轮询里调用（保证 listDrafts 闸门已先装好）；若本轮 `WCSyncNet` 尚未就绪则随既有轮询重试，不新增第二个定时器。
- [x] **1.4 本地静态预检（Windows）**：
  - 文件仍为 UTF-8 无 BOM、LF；
  - 共享资产哈希未变（见 4.4 命令）；
  - `node --check ShellAssets/ipad.js`（若本机有 node；没有则跳过，不为此安装/引依赖）。

### Task 2：移植基线读写 + saveDraft 咽喉钩子

- [x] **2.1** 移植 `latestBaseline()`/`applySyncedBaseline()`（§3.5）。iOS 返回形态已核实为 `{ok,baseline}` / `{ok,bytes}`（[AppDataStore.swift#L406-L435](file:///e:/项目/dsh-remote-ios/Sources/AppDataStore.swift#L406-L435)），与蓝本一致，直接按蓝本取值，不改原生。
- [x] **2.2** 移植 `saveTextHash`（djb2 步进采样）/`saveRequestKey`/`installSaveHook()`（§3.4），在 `installListDraftsGate()` **之后**安装；幂等标志 `__wciSaveHook`。
- [x] **2.3** 验证：单条 saveDraft 成功会触发 `outboxRemove`；同键并发只发一次（逻辑走查 + Task 4 控制台片段）。

### Task 3：移植 drainOutbox 主体、触发点与有界退避重试

- [x] **3.1** 移植 `drainOutbox()`（§3.1–3.3），用 `navigator.onLine` 替换安卓 `onlineNow()` 里的原生态，会话读 ipad.js 既有 `hostSessionState`，去掉所有 missing/conflict 角标与作品墙/missingSheet 收尾，队列空仅复位锁（必要时一条 `console.info`）。
- [x] **3.2** 装事件触发点（§3.7）：安装成功后**立即** drain（无定时器）、window online、document visibilitychange；登录成功依赖既有合成 online，不新增。
- [x] **3.3** 实现有界退避重试（§3.8）：模块级单例 timer + 15/30/60/120/300s 序列（封顶 300s）；drain 维护 `hadTransientFailure`，仅网络型失败/索引失败挂重试，conflict/漂移类不挂；成功出队重置 15s；outbox 空清除 timer。并在 saveDraft 咽喉钩子里对「内核直推网络失败」补挂一次重试。
- [x] **3.4** 复核：drain 内对 `listDrafts` 的调用经由会话闸门；`hostSessionState===false` 时启动 drain 不发上行；`null` 时不拦；重试 timer 到点在离线/无会话时跳过不发包。
- [x] **3.5 本地静态预检**：同 1.4（无 BOM/LF、共享资产哈希、`node --check` 若可用）。

### Task 4：验证（无 JS 单测基建下的多层验收）

本仓 JS 无 node 测试基建，按「静态预检 → 控制台注入演练 → CI 仅防 Swift 回归 → 真机/模拟器端到端」四层验证，不新建 JS 测试框架。

- [x] **4.1 静态预检（Windows，本地必做）**

  PowerShell 复核共享资产哈希与 PC 源逐字节一致（`writing.js`/`sync-core.js` 必须不变；`sync-net.js` 两端本就不同，只与 iOS 自身基线比）：

  ```powershell
  Get-FileHash -Algorithm SHA256 e:\项目\dsh-remote-ios\ShellAssets\writing.js, `
    e:\项目\dsh-remote\writing-client\writing.js, `
    e:\项目\dsh-remote-ios\ShellAssets\sync-core.js, `
    e:\项目\dsh-remote\writing-client\sync-core.js | Format-Table Path,Hash
  ```

  预期：两对路径哈希分别相等（`writing.js` = `724C6046…`、`sync-core.js` = `33E1409…`，以实跑为准）。ipad.js 自身变化是预期的。

- [ ] **4.2 控制台注入演练（mac/Safari 开发菜单或模拟器 Web Inspector，连网关测试环境，不动生产）**

  在写作页手动执行**一次性** JS 片段（不进仓），按下列脚本化桩验证纯逻辑分支：桩掉 `WCSyncNet.listDrafts/saveDraft` 与 `wcStorage.outboxList/outboxRemove/readDoc/syncBaseline(Set)`，喂入固定 `index`/正文/基线，断言：①墓碑出队不推；②skip 出队；③conflict/remote-newer 留队；④reupload 漂移留队；⑤push 成功先更新基线再出队；⑥saveDraft 网络失败留队；⑦single-flight 同键只发一次；⑧`hostSessionState=false`/离线整轮不跑；⑨网络失败一轮后挂上重试 timer（用假时钟/可注入延时断言退避序列与封顶 300s），成功后重置/清空；⑩conflict 类留队**不**挂重试。产出一份「输入→期望 outbox 终态/请求次数/timer 态」对照记录。

- [x] **4.3 CI 模拟器测试（征得同意后推分支触发）**

  Swift 测试本应不受影响（零原生改动），仍跑一次总计划同款命令确认无回归、产出未签名 IPA：

  ```bash
  xcodegen generate
  DEST_ID=$(python3 -c "import json,subprocess;d=json.loads(subprocess.check_output(['xcrun','simctl','list','devices','available','-j']));devs=[v for u in d['devices'].values() for v in u if v['name'].lower().startswith('ipad')];print(sorted(devs,key=lambda x:x['name'])[-1]['udid'])")
  xcodebuild test -project DSHRemote.xcodeproj -scheme DSHRemote -destination "id=$DEST_ID" CODE_SIGNING_ALLOWED=NO
  ```

  预期 `** TEST SUCCEEDED **`；重点确认 `ShellHTMLRewriterTests`（ipad.js 注入位置/顺序/幂等）仍绿。

- [ ] **4.4 真机/模拟器端到端场景验收（SideStore 装机或模拟器，用户在场；对应北极星）**

  1. **离线编辑入队**：联网登录写作页 → 断 Wi‑Fi → 打开既有文档输入若干中文并等自动保存周期；新建一篇离线文档并保存。检查：保存态为本地已保存、无红色失败；杀进程重开（仍断网）两文内容在（自动保存链路，回归确认）。
  2. **回网自动补推**：恢复网络，不手动点任何东西 → 观察控制台依次出现索引拉取→push→出队；用 PC/服务端打开同一文档确认**离线改动确实在服务端**（业务判据，非仅 UI）。
  3. **冷启动补推**：断网编辑→杀进程→**联网后**冷启动 App → 启动 drain 自动把 outbox 残余推完，服务端可见。
  4. **登录后补推**：清掉本 host 会话（或等过期）→ 断网编辑留队 → 联网后在登录浮层登录 → 合成 online 触发 drain，补推成功。
  5. **冲突不盲盖**：A 端离线编辑文档 X；B 端（PC）对 X 做不同编辑并保存；A 回网 drain：该 rel **留在 outbox**、控制台 warn、不被覆盖；A 在写作页打开 X 时出现 PC 既有冲突横幅/四动作。
  6. **云端已删不复活**：B 端删除文档 Y（进回收目录，索引带 tomb）；A 端 outbox 恰有 Y 的旧条目；A 回网 drain：Y 出队且**不**重新上传。
  7. **single-flight**：回网瞬间 writing.js 自身推送与 drain 撞同一文档同一正文：服务端只收到一次 saveDraft，控制台无第二次 409、无误判冲突横幅。
  8. **弱网容错 + 有界重试（北极星核心）**：模拟高延迟/间歇断网（Network Link Conditioner），且**保持页面在前台、不切后台、不触发 online 事件**（Wi‑Fi 关联但国际链路丢包）：saveDraft 超时期间条目留队；观察到按 15→30→60→120→300s 有界自动重试，恢复后某次重试补推成功并出队，不丢条目、不无限快速重发（封顶 5min）；若仅剩冲突类条目则不挂重试。
  9. **未配网关回归**：占位 origin（未配网关）启动：不安装 drain、不发任何云端请求，纯本地写作/自动保存正常。

  任一项失败：抓 Web Inspector 控制台与网络记录，区分 drain 判据/桥返回形态/服务端版本问题，回到对应 Task 修；**禁止改共享核心 JS 或原生兜底**。

### Task 5：文档留痕与交付（不自动合并/打 tag）

- [x] **5.1** 在本计划末尾追加「执行记录」：实际 `saveBaseline` 返回键名订正（若有）、真机/模拟器各场景结果、CI run 链接、IPA 位置。
- [x] **5.2** 回填总计划 [2026-10-10-ipad-offline-writing-sync.md](file:///e:/项目/dsh-remote-ios/docs/superpowers/plans/2026-10-10-ipad-offline-writing-sync.md)：在 L50 与 Task 13.8（L6396–6403，原写「writing.js 核心的 online…sync-net.js 补推应自动发起」）处加更正注记，指明回网正文补推实际由本计划的 ipad.js drain 承接（13.8 验收步骤本身仍有效，无需改判据）。
- [x] **5.3** spec 留痕（在 dsh-remote 仓对应 iOS/同步 spec 的缺口章节，待评审时定位具体小节）：记录三事实——writing.js online 不补推正文、iOS 无 `syncPendingOps` 桥、OutboxStore 原先无 JS 消费方；以及正解（ipad.js drain）。
- [ ] **5.4** commit/合并/tag 全部等用户明确指令；不 force push、不改 git config。

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| `syncBaseline()` iOS 返回键名与安卓不同导致基线读空 | Task 2.1 先读 `AppDataStore` 确认；读空只退化为哈希比对，不影响正确性，且有 warn |
| drain 与 writing.js 核心推送并发撞 409 | saveDraft 咽喉 single-flight（§3.4），同键复用同一 Promise |
| 误把「云端拉取失败」当「云端被删」而丢条目 | 索引失败/known:false 整轮中止；墓碑只认真索引的 `index.tomb`，绝不看单次 read 404 |
| 自动 force 覆盖他端改动 | 409/conflict/remote-newer/存储漂移全部留队，绝不 force；冲突交 writing.js 既有横幅 |
| 包装顺序错误导致会话闸门失效 | 强制先装 listDrafts 闸门、后装 saveDraft 钩子；drain 的 listDrafts 经由闸门；CI 的注入顺序测试保底 |
| 改 ipad.js 影响既有 iOS 功能 | 纯新增模块、不改既有函数行为；CI 全绿 + 4.4 场景 9 未配网关回归 |
| 弱网下 drain 频繁打扰/无限重试 | 重入锁 + 事件触发；仅在「仍有条目且刚发生网络型失败」时挂**单例**退避 timer（15→300s 封顶），成功重置、出空即清；冲突/漂移类不重试；timer 到点离线/无会话则跳过不发包 |
| 无 JS 单测，逻辑回归难防 | 4.2 桩驱动控制台演练覆盖全分支；真机端到端覆盖业务判据；不为一次性脚本建测试框架 |

## 6. 明确不做（范围封板）

- 不做离线内核/DSH iframe 缓存、不做 Service Worker（用户已否决缓存方向，内核优先级最低）。
- 不新增任何原生上传/后台传输能力，不改 Swift/桥/ACL/derpMap/服务端。
- 不移植安卓角标、作品墙、missingSheet、nativeOnline、字数/提醒等无关 UI 与逻辑。
- 不做方案 B；方案 C（自建 DERP）按用户拍板在本兜底之后另起计划（依赖域名定向）。

---

## 7. 执行记录（2026-10-24）

- **实现（Task 1–3）完成**，仅改 [ipad.js](file:///e:/项目/dsh-remote-ios/ShellAssets/ipad.js)（+305/-8，最终 884 行 / 41133 字节，UTF-8 无 BOM、纯 LF），新增「4c. 壳侧发件箱补推」模块；web 共享核心与原生 Swift 零改动。计划文档本身随提交入仓。
- **draining 锁定稿**：入口守卫通过后**同步** `draining = true`（与安卓蓝本一致）。曾尝试把取锁推迟到 `listDrafts` resolve 之后以免"被会话闸门挂起占锁"，复核后判定该方案反而在弱网"索引在途"长窗口引入真实并发重叠，已回退。被闸门挂起的一轮会被 `releaseSessionWaiters` 连同自身 waiter 一起 resume，持锁无害；登录成功路径（ipad.js L519）必释放 waiter，锁不泄漏。
- **Task 4.1 静态预检通过**：`node --check ShellAssets/ipad.js` OK；无 BOM、CRLF=0；git 确认跟踪文件仅 ipad.js 改动。共享资产哈希（SHA256，与 PC 源 `writing-client/` 逐字节一致）：
  - `writing.js` = `724C60460127F63E2AE186CA35CBAE31B731B6551F27C969AE6DE3EDCE4EE13B`（iOS==PC，安卓为旧分叉不同）
  - `sync-core.js` = `33E1409B225E872505B714DD5C667152D79EFB7AA2EBBC44ACC1C5DAA5440566`（iOS==PC，安卓不同）
  - `sync-net.js` iOS=`D4E03DAF…` 与安卓基线相同、本就独立于 PC（PC=`E2AD9B2F…`）；非落点铁律对象。
- **Task 4.3 CI 通过**：分支 `feature/ipad-outbox-drain`，提交 `b67fc6d`（基线分支 `feature/m0-m1-shell`，未合主干）。ios-build workflow 由 `workflow_dispatch` 手动触发（该 workflow 不在普通分支 push 上触发），run [#40085471536](https://github.com/skyblade47/dsh-remote-ios/actions/runs/40085471536)，macos-14 + Xcode 16.2，`** TEST SUCCEEDED **`；`ShellHTMLRewriterTests`、`ShellNavigationTests` 等全套件 0 failures；Release 编译通过，产出未签名工件 `DSHRemote-unsigned-ipa`（536324 字节，artifact id 12556912777，head_sha b67fc6d）。
- **未做（等用户安排）**：Task 4.2 控制台桩驱动演练（需 Mac/Safari 或模拟器 Web Inspector）、Task 4.4 真机/模拟器 9 场景端到端（需 Sideloadly 重签装机，用户在场）。用户选择"先回填文档，装机以后再说"。
