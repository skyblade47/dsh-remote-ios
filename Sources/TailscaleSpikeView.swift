import SwiftUI

// ============================================================================
// Phase 2.2 spike 面板 —— auth key 非交互入网的真机操作/取证界面
// （**非产品代码，闸门 B 结论固化后随 TailscaleSpike* 一起删除**）
// 入口：RootView 标题栏右侧「TS」按钮。
// ============================================================================

struct TailscaleSpikeView: View {
    @StateObject private var vm = TailscaleSpikeManager()
    @StateObject private var web = SpikeWebModel()
    @Environment(\.dismiss) private var dismiss

    // auth key 只活在这个 @State：点「入网」后立刻置空，不落盘、不进日志。
    @State private var authKeyInput: String = ""

    var body: some View {
        NavigationStack {
            List {
                Section("状态") {
                    HStack {
                        Text("阶段")
                        Spacer()
                        Text(phaseText).foregroundStyle(phaseColor)
                    }
                    HStack { Text("tailnet IPv4"); Spacer(); Text(vm.ip4).font(.system(.body, design: .monospaced)) }
                    HStack { Text("tailnet IPv6"); Spacer(); Text(vm.ip6).font(.system(.body, design: .monospaced)).lineLimit(1).minimumScaleFactor(0.5) }
                    HStack { Text("本机登录态"); Spacer(); Text(vm.hasState ? "Documents/tailscale 已存在" : "无（首次需 key）").foregroundStyle(.secondary) }
                }

                Section("auth key（tag:ipad / reusable / 非 ephemeral）") {
                    SecureField("粘贴 tskey-auth-…，用完即焚", text: $authKeyInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("key 只在内存里传给一次 up，成功后立即清空，不写盘/不入日志。杀进程后改用已存登录态恢复。")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section("操作") {
                    Button {
                        let key = authKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        authKeyInput = ""   // 用后即焚
                        Task { await vm.bringUp(authKey: key.isEmpty ? nil : key) }
                    } label: {
                        Label(vm.hasState ? "入网（无 key 恢复登录态）" : "入网（用上方 key）", systemImage: "arrow.up.circle")
                    }
                    .disabled(vm.phase == .starting)

                    Button(role: .destructive) { vm.down() } label: {
                        Label("下线（保留状态目录）", systemImage: "arrow.down.circle")
                    }
                    .disabled(vm.phase != .up)
                }

                Section("2.3 数据面探针（进程内 tailscale_dial）") {
                    Text("GET \(TailscaleSpikeManager.probeTarget)\(TailscaleSpikeManager.probePath) · 经 tsnet 数据面，绕过 URLSession/ATS")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button {
                        Task { await vm.runDialProbe() }
                    } label: {
                        if case .running = vm.dialResult {
                            Label("探测中（最多 20s）…", systemImage: "antenna.radiowaves.left.and.right")
                        } else {
                            Label("发起 GET /auth/login", systemImage: "antenna.radiowaves.left.and.right")
                        }
                    }
                    .disabled(vm.phase != .up || (vm.dialResult == .running))

                    dialResultView
                }

                // MARK: 2.4 WKWebView 经本地桥访问 tailnet（最高风险项）
                Section("2.4 本地桥 → WKWebView（页面/Cookie/WS）") {
                    bridgeControl
                    if case .running(let base) = vm.bridge {
                        bridgeProbeContent(base: base)
                    }
                }

                Section("Tailscale 日志（最近 300 行）") {
                    ScrollView {
                        Text(vm.logs.joined(separator: "\n"))
                            .font(.system(.footnote, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 260)
                }
            }
            .navigationTitle("Tailscale spike 2.4")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
        }
    }

    // MARK: - 2.4 视图

    @ViewBuilder
    private var bridgeControl: some View {
        switch vm.bridge {
        case .stopped:
            Button {
                Task { await vm.startBridge() }
            } label: {
                Label("启动本地桥（127.0.0.1 → tailnet）", systemImage: "point.3.connected.trianglepath.dotted")
            }
            .disabled(vm.phase != .up)
            if vm.phase != .up {
                Text("先在上方完成入网，再起桥。").font(.footnote).foregroundStyle(.secondary)
            }
        case .starting:
            Label("起桥中…", systemImage: "hourglass").foregroundStyle(.orange)
        case .running(let base):
            HStack {
                Text("桥地址").foregroundStyle(.secondary)
                Spacer()
                Text(base.absoluteString).font(.system(.footnote, design: .monospaced))
            }
            Button(role: .destructive) {
                vm.stopBridge()
            } label: {
                Label("停止本地桥", systemImage: "stop.circle")
            }
        case .failed(let reason):
            Text(reason).font(.footnote).foregroundStyle(.red)
            Button {
                Task { await vm.startBridge() }
            } label: {
                Label("重试起桥", systemImage: "arrow.clockwise")
            }
            .disabled(vm.phase != .up)
        }
    }

    @ViewBuilder
    private func bridgeProbeContent(base: URL) -> some View {
        // ① 页面取证：经本地桥加载真实登录页
        Button {
            web.load(base.appendingPathComponent("auth/login"))
        } label: {
            Label("WKWebView 加载 /auth/login", systemImage: "safari")
        }

        SpikeWebView(model: web)
            .frame(height: 380)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.secondary.opacity(0.3)))

        VStack(alignment: .leading, spacing: 4) {
            Text("导航轨迹").font(.footnote.bold())
            Text(web.navLog.isEmpty ? "（无）" : web.navLog.joined(separator: "\n"))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
        }

        // ② Cookie 取证：登录后应看到 dsh_session
        Button {
            web.refreshCookies()
        } label: {
            Label("读取 127.0.0.1 下 Cookie", systemImage: "key")
        }
        Text(web.cookieReport)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(web.cookieReport.contains("有 ✅") ? .green : .secondary)
            .frame(maxWidth: .infinity, alignment: .leading)

        // ③ WS Upgrade 取证：未登录多为 401 CLOSE，登录后应 OPEN 101
        Button {
            web.probeWebSocket()
        } label: {
            Label("探测 WS /api/remote.mux（Upgrade 透传）", systemImage: "antenna.radiowaves.left.and.right")
        }
        .disabled(web.busy)
        Text(web.wsReport)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(web.wsReport.contains("101") || web.wsReport.contains("401") ? .green : .orange)
            .frame(maxWidth: .infinity, alignment: .leading)

        Text("取证顺序：先加载页面看渲染 → 未登录先探一次 WS（预期 401 close，证 Upgrade 已逐字节透传到网关）→ 在 WebView 内完成登录 → 再读 Cookie（dsh_session 有）→ 再探 WS（预期 101 open）。")
            .font(.caption2).foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var dialResultView: some View {
        switch vm.dialResult {
        case .idle:
            Text("尚未探测。WiFi 与蜂窝下各跑一次。").font(.footnote).foregroundStyle(.secondary)
        case .running:
            Text("数据面建连/收包中…").font(.footnote).foregroundStyle(.orange)
        case .ok(let status, let ms, let bytes, let preview):
            VStack(alignment: .leading, spacing: 4) {
                Text("HTTP \(status)").font(.system(.footnote, design: .monospaced)).foregroundStyle(status.contains("200") && !status.contains("非 200") ? .green : .orange)
                Text("耗时 \(ms) ms · 收到 \(bytes) 字节").font(.footnote).foregroundStyle(.secondary)
                Text(preview).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .failed(let reason):
            Text(reason).font(.footnote).foregroundStyle(.red)
        }
    }

    private var phaseText: String {
        switch vm.phase {
        case .idle: return "未入网"
        case .starting: return "up 中…"
        case .up: return "已入网"
        case .failed(let m): return "失败：\(m)"
        }
    }
    private var phaseColor: Color {
        switch vm.phase {
        case .up: return .green
        case .failed: return .red
        case .starting: return .orange
        case .idle: return .secondary
        }
    }
}
