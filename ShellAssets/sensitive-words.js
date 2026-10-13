'use strict'

// ============================================================================
// 写作客户端 · 敏感词内置词库（设计 docs/board-and-noveldb-design.md §3）
//
// 口径（§3.1）：只收**高确定性**的一般互联网违禁词，宁漏勿滥，避免日常写作被大面积误报。
//   · 纯数据包，零逻辑；词表独立成文件，后续只更词库不动 sensitive.js
//   · UMD：node 走 module.exports，浏览器挂 window.WCSensitiveWords（与 proofread.js 同构）
//   · 不做繁简转换（一期）⇒ 繁/异体词直接双形收录
// ⚠️ 免责口径（写进设置页）：本词库是通用基础集，不保证覆盖任何平台的最新审核规则，
//    投稿前以目标平台规则为准。
// ============================================================================

;(function (root, factory) {
  var mod = factory()
  if (typeof module === 'object' && module && module.exports) module.exports = mod
  if (root) root.WCSensitiveWords = mod
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict'

  // severity：must（必改）/ should（建议）/ nice（可选）；onByDefault=false ⇒ 默认关闭
  var categories = [
    {
      id: 'politics',
      label: '涉政',
      severity: 'must',
      onByDefault: true,
      words: [
        '法轮功', '法轮大法', '六四', '天安门事件', '台独', '藏独', '疆独',
        '反华势力', '颠覆国家政权', '推翻社会主义制度', '共产党下台', '专制政权',
        '颜色革命', '反政府武装', '分裂国家',
      ],
    },
    {
      id: 'violence',
      label: '暴恐',
      severity: 'must',
      onByDefault: true,
      words: [
        '恐怖袭击', '恐怖组织', '暴恐', '圣战组织', '伊斯兰国', 'ISIS', 'isis',
        '基地组织', '东突组织', '分裂组织', '自制炸弹', '炸药制作', '枪支买卖',
        '买卖枪支', '杀人方法', '制毒工厂',
      ],
    },
    {
      id: 'porn',
      label: '色情',
      severity: 'must',
      onByDefault: true,
      words: [
        '色情', '黄色视频', '黄色网站', '裸聊', '裸体照片', '裸体视频', '成人电影',
        'AV女优', 'av女优', '卖淫', '嫖娼', '妓女', '性交', '乱伦', '迷奸',
        '援交', '包夜', '一夜情网站', '裸体表演',
      ],
    },
    {
      id: 'gamble',
      label: '赌博',
      severity: 'should',
      onByDefault: true,
      words: [
        '赌博', '赌场', '线上赌场', '网络赌博', '百家乐', '老虎机', '下注平台',
        '赌资', '六合彩', '博彩网站', '私彩', '赌球', '赌马', '开元棋牌',
      ],
    },
    {
      id: 'drugs',
      label: '毒品',
      severity: 'should',
      onByDefault: true,
      words: [
        '毒品', '冰毒', '海洛因', '摇头丸', 'K粉', 'k粉', '可卡因', '鸦片',
        '吗啡', '吸毒', '贩毒', '制毒', '麻古', '杜冷丁', '大麻种植',
      ],
    },
    {
      id: 'fraud',
      label: '诈骗/传销',
      severity: 'should',
      onByDefault: true,
      words: [
        '传销', '非法集资', '诈骗团伙', '电信诈骗', '杀猪盘', '刷单返利',
        '资金盘', '庞氏骗局', '金字塔骗局', '贷款诈骗', '冒充客服', '洗钱渠道',
      ],
    },
    {
      // 🔴 默认关（小说正文误伤极高）：单字「最」「第一」等在叙事里是正常用词
      id: 'ads',
      label: '广告法极限词',
      severity: 'nice',
      onByDefault: false,
      words: [
        '最', '第一', '顶级', '极品', '万能', '国家级', '世界级', '最高级',
        '最佳', '最好', '最优', '最低价', '最先进', '王牌', '独家秘方',
        '100%', '绝无仅有', '史无前例', '举世无双',
      ],
    },
    {
      id: 'abuse',
      label: '辱骂',
      severity: 'nice',
      onByDefault: false,
      words: [
        '傻逼', '操你妈', '草泥马', '贱人', '王八蛋', '狗东西', '脑残',
        '白痴', '去死吧', '狗娘养的',
      ],
    },
  ]

  return { version: '2026.10.13', categories: categories }
})
