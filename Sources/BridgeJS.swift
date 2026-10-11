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
