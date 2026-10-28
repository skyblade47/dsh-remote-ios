import SwiftUI

// ============================================================================
// Phase 3.3 —— 产品设置页「Tailscale 认证」。
//
// 安全纪律：
//   ① auth key 只从 SecureField 进入内存 @State，点「入网」后立即清空输入框；
//      不回显已存 key（Keychain 只写不读显）、不进任何日志。
//   ② 页面只**观察** TailnetNode.shared，不持有节点（节点生命周期独立于页面）。
//   ③ 登出=下线+删 Keychain；彻底清除=登出+删 Documents/tailscale 登录态。
//
// 入口：RootView 标题栏右侧胶囊按钮（沿用原调试面板位置，不碰连点 5 次的网关设置）。
// ============================================================================

struct TailnetSettingsView: View {
    @ObservedObject private var node = TailnetNode.shared
    @Environment(\.dismiss) private var dismiss

    // key 只活在这个 @State：点「入网」后立刻置空，不落盘、不进日志。
    @State private var authKeyInput: String = ""
    @State private var showWipeConfirm = false

    var body: some View {
        NavigationStack {
            List {
                Section("节点状态") {
                    HStack {
                        Text("状态")
                        Spacer()
                        Text(stateText).foregroundStyle(stateColor)
                    }
                    if case .online(let ip4, let ip6) = node.state {
                        HStack {
                            Text("tailnet IPv4")
                            Spacer()
                            Text(ip4).font(.system(.body, design: .monospaced))
                        }
                        HStack {
                            Text("tailnet IPv6")
                            Spacer()
                            Text(ip6)
                                .font(.system(.body, design: .monospaced))
                                .lineLimit(1)
                                .minimumScaleFactor(0.5)
                        }
                    }
                    // 4.1 localhost 反代状态：online 后桥自动起；WKWebView（Phase 5）固定读 UserDefaults base。
                    if isOnline {
                        HStack {
                            Text("本地反代")
                            Spacer()
                            Text(bridgeText).foregroundStyle(bridgeColor)
                        }
                        if case .running(let base) = node.bridge {
                            Text(base)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                        }
                        if case .failed(let reason) = node.bridge {
                            Text(reason)
                                .font(.footnote)
                                .foregroundStyle(.red)
                                .textSelection(.enabled)
                        }
                        // 4.8 真机验收入口（/auth/login 渲染 + WS 1006/101 + dsh_session cookie）。
                        NavigationLink {
                            TailnetVerifyView()
                        } label: {
                            Label("验收本地反代（页面 / WS / Cookie）", systemImage: "checkmark.shield")
                        }
                    }
                    if case .failed(let reason) = node.state {
                        Text(reason)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                    if isStarting {
                        // 弱网逃生口：starting 不再锁死，可随时取消（看门狗也会在约 45s 自动打断）。
                        Button(role: .destructive) {
                            Task { await node.cancelBringUp() }
                        } label: {
                            Label("取消入网", systemImage: "xmark.circle")
                        }
                        Text("弱网到控制面不通时最多等待约 45 秒，超时会自动中断并提示；也可随时取消后重试。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    SecureField("粘贴 tskey-auth-…", text: $authKeyInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("auth key 仅入网时使用一次，保存于本机 Keychain（不进 iCloud、不进日志、不回显）；提交后输入框立即清空。杀进程后用已存登录态自动恢复。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button {
                        let key = authKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        authKeyInput = ""   // 用后即焚：明文不留在 UI 状态里
                        Task { await node.signIn(authKey: key) }
                    } label: {
                        Label("提交并入网", systemImage: "arrow.up.circle")
                    }
                    .disabled(isStarting || trimmedInput.isEmpty)
                } header: {
                    Text("Tailscale 认证")
                }

                Section("维护") {
                    Button {
                        Task { await node.retry() }
                    } label: {
                        Label("重试连接", systemImage: "arrow.clockwise")
                    }
                    .disabled(isStarting || isOnline)

                    Button(role: .destructive) {
                        Task { await node.signOut() }
                    } label: {
                        Label("登出（下线并删除 Keychain 凭据）", systemImage: "arrow.down.circle")
                    }
                    .disabled(isStarting || node.state == .idle)

                    Button(role: .destructive) {
                        showWipeConfirm = true
                    } label: {
                        Label("彻底清除本机节点状态", systemImage: "trash")
                    }
                    .disabled(isStarting || node.state == .idle)
                }

                // 真机无 Mac 看不到 os_log：最近节点日志直接上屏，弱网卡死时可据此排查（可复制）。
                Section("节点日志（最近 50 条）") {
                    if node.recentLogs.isEmpty {
                        Text("暂无日志")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(node.recentLogs.enumerated().reversed()), id: \.offset) { _, line in
                            Text(line)
                                .font(.system(.caption2, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle("Tailscale 内网")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .confirmationDialog(
                "彻底清除本机节点？",
                isPresented: $showWipeConfirm,
                titleVisibility: .visible
            ) {
                Button("彻底清除", role: .destructive) {
                    Task { await node.wipeState() }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("将下线节点、删除 Keychain 中的 auth key 与 Documents/tailscale 登录态。清除后再次入网需重新粘贴 auth key。")
            }
        }
    }

    private var trimmedInput: String {
        authKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // State 带关联值（online/failed），与无关联值成员比较统一走模式匹配。
    private var isStarting: Bool {
        if case .starting = node.state { return true }
        return false
    }

    private var isOnline: Bool {
        if case .online = node.state { return true }
        return false
    }

    private var stateText: String {
        switch node.state {
        case .idle: return "初始化中…"
        case .unauthenticated: return "未入网"
        case .starting: return "启动中…"
        case .online: return "已在线"
        case .failed: return "入网失败"
        }
    }

    private var stateColor: Color {
        switch node.state {
        case .online: return .green
        case .failed: return .red
        case .starting: return .orange
        case .idle, .unauthenticated: return .secondary
        }
    }

    private var bridgeText: String {
        switch node.bridge {
        case .stopped: return "未启动"
        case .starting: return "启动中…"
        case .running: return "就绪"
        case .failed: return "异常"
        }
    }

    private var bridgeColor: Color {
        switch node.bridge {
        case .running: return .green
        case .failed: return .red
        case .starting: return .orange
        case .stopped: return .secondary
        }
    }
}
