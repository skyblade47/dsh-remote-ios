import SwiftUI

// ============================================================================
// Phase 2.2 spike 面板 —— auth key 非交互入网的真机操作/取证界面
// （**非产品代码，闸门 B 结论固化后随 TailscaleSpike* 一起删除**）
// 入口：RootView 标题栏右侧「TS」按钮。
// ============================================================================

struct TailscaleSpikeView: View {
    @StateObject private var vm = TailscaleSpikeManager()
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

                Section("Tailscale 日志（最近 300 行）") {
                    ScrollView {
                        Text(vm.logs.joined(separator: "\n"))
                            .font(.system(.footnote, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 260)
                }
            }
            .navigationTitle("Tailscale spike 2.3")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
        }
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
