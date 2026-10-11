;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  else root.WCWritingCore = mod
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  function countWords(text) {
    return String(text == null ? '' : text).replace(/\s+/g, '').length
  }

  function deltaWords(baseText, nextText) {
    return Math.max(0, countWords(nextText) - countWords(baseText))
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n)
  }

  function localDateString(d) {
    var dt = d == null ? new Date() : d
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate())
  }

  function buildKey(wsId, relPath, oldHash, newHash) {
    return wsId + ':' + relPath + ':' + oldHash + ':' + newHash
  }

  var QUEUE_KEY = 'wc.writingQueue'
  var QUEUE_MAX = 200
  var QUEUE_DAYS = 7

  function cutoffDate() {
    var d = new Date()
    d.setDate(d.getDate() - QUEUE_DAYS)
    return localDateString(d)
  }

  function sanitize(list) {
    var cutoff = cutoffDate()
    var seen = {}
    var out = []
    for (var i = 0; i < list.length; i += 1) {
      var e = list[i]
      if (!e || typeof e.key !== 'string' || typeof e.date !== 'string') continue
      if (!Number.isInteger(e.words) || e.words < 0) continue
      if (e.date < cutoff) continue
      if (seen[e.key]) continue
      seen[e.key] = 1
      out.push({ date: e.date, key: e.key, words: e.words })
    }
    return out.slice(-QUEUE_MAX)
  }

  function readQueue(store) {
    var raw
    try {
      raw = JSON.parse(store.getItem(QUEUE_KEY) || '[]')
    } catch (e) {
      return []
    }
    return Array.isArray(raw) ? sanitize(raw) : []
  }

  function writeQueue(store, list) {
    store.setItem(QUEUE_KEY, JSON.stringify(sanitize(list)))
  }

  function appendQueue(store, entry) {
    var list = readQueue(store)
    list.push(entry)
    writeQueue(store, list)
  }

  function removeKey(store, key) {
    var kept = []
    var list = readQueue(store)
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].key !== key) kept.push(list[i])
    }
    writeQueue(store, kept)
  }

  return {
    countWords: countWords,
    deltaWords: deltaWords,
    localDateString: localDateString,
    buildKey: buildKey,
    readQueue: readQueue,
    appendQueue: appendQueue,
    removeKey: removeKey,
  }
})
