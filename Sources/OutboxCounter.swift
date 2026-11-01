import Foundation

// ============================================================================
// Phase 6.3 —— 待发箱（outbox）只读计数，上传同步端到端的真机可观测性。
//
// 北极星验收：iPad 单设备、无 Mac Web Inspector，需在设置页直接看到
// 「断网编辑入队 N 条 → 回网 drain → 归零」。
//
// 它与 BridgeDispatcher 是**不同实例但读同一个 Documents/outbox.json**
// （OutboxStore 每次读盘，跨实例写入立即可见，见 OutboxStoreTests 落盘往返用例）。
// 只读、绝不 add/remove；计数对 drain 网页侧零耦合（不新增 dshBridge 方法、
// 不改 JS）。轮询仅在设置页出现期间运行（onAppear start / onDisappear stop）。
// ============================================================================

@MainActor
final class OutboxCounter: ObservableObject {
    /// 待上传条目总数；0 = 全部已同步（或本就无待发）。
    @Published private(set) var pendingCount: Int = 0
    /// 按作品分组的待发数（首个 "/" 前为作品名，根文档归 ""），供 UI 展开。
    @Published private(set) var countByDoc: [String: Int] = [:]

    private let store: OutboxStore
    private let pollInterval: TimeInterval
    private var pollTask: Task<Void, Never>?

    init(dataDir: URL = OutboxCounter.defaultDataDir, pollInterval: TimeInterval = 1) {
        self.store = OutboxStore(dataDir: dataDir)
        self.pollInterval = pollInterval
    }

    nonisolated static var defaultDataDir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    /// 进入设置页：立即取一次（不必等首个间隔），随后按 pollInterval 轮询。幂等。
    func start() {
        guard pollTask == nil else { return }
        refresh()
        let interval = pollInterval
        pollTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                if Task.isCancelled { break }
                self.refresh()
            }
        }
    }

    /// 离开设置页：停轮询。幂等。
    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// 从 outbox.json 重新读一次计数（OutboxStore 读盘容错：缺失/损坏均按 0）。
    func refresh() {
        pendingCount = store.count()
        countByDoc = store.countByDoc()
    }
}
