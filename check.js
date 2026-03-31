const STORAGE_KEY = 'ws_monitor_messages';
const STORAGE_URL_KEY = 'ws_monitor_url';
const STORAGE_MSG_ID_KEY = 'ws_monitor_msg_id';
const DEDUP_DURATION = 15 * 60 * 1000;

// 显示模式控制
const displayModeSelect = document.getElementById('displayMode');
let displayMode = displayModeSelect.value;
displayModeSelect.addEventListener('change', () => {
  displayMode = displayModeSelect.value;
});

const TAO_REG = /(?:[^\w])([a-zA-Z0-9]{11})(?:[^\w]|$)/g;
const LINK_REG = /\w+:\/\/[^\s]+/gi;
const CQ_IMAGE_REG = /\[CQ:image,[^\]]+\]/g;
const CLEAN_TAO_REG = /([^\u4e00-\u9fa5a-zA-Z0-9]*[a-z0-9]{11}[^\u4e00-\u9fa5a-zA-Z0-9]*)/gi;

const CHAR_MAP = {
  '紅':'红','裏':'里','衛':'卫','復':'复','國':'国','區':'区',
  '単':'单','卷':'券','劵':'券','虹':'红',
  '淦':'金','臧':'藏',
  '亓':'元','块':'元',
  '後':'后','發':'发','麵':'面','萬':'万',
  '與':'与','為':'为','個':'个','隻':'只',
  '於':'于','幹':'干','曆':'历','鬥':'斗','係':'系',
  '樸':'朴','硃':'朱','幾':'几','妳':'你',
  '條':'条','簾':'帘','範':'范','號':'号',
  '兔':'免','免':'兔',
};

const OCR_MAP = { '兔':'免','亓':'元' };

function normalizeOCR(text) {
  for (const [from, to] of Object.entries(OCR_MAP)) {
    text = text.split(from).join(to);
  }
  return text;
}

function textSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const lenA = a.length, lenB = b.length;
  const maxLen = Math.max(lenA, lenB);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / maxLen;
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }
  return dp[m][n];
}

const SIMILARITY_THRESHOLD = 0.75;

const HL_KEYWORDS = ['神价', '漏洞', '0元', '免单', '兔单', '速度', '免费', 'bug', '速‼', '锁‼', '免', '兔', 'O亓', '快‼️', '有水', '快锁'];
const HL_PRICE_PATTERNS = /(?:到手|最终|实付|只需|拍下|活动|优惠|现价|券后|返后)[价]?\s*[💰¥￥$大洋]+\s*([0-9]+(?:\.[0-9]+)?)\s*[💰¥￥$元]*|([0-9]+(?:\.[0-9]+)?)\s*[💰¥￥$大洋]+|(?:大洋|只需|只要)\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*元\s*[💰¥￥$]/g;
const HL_EMOJI_PRICE = /([0-9]+(?:\.[0-9]+)?)\s*[💰¥￥$大洋]/g;

const HL_STORAGE_KEY = 'ws_monitor_highlights';
const HL_KW_KEY = 'ws_monitor_kw_feedback';
const HL_GROUP_KW_KEY = 'ws_monitor_group_kw';
const HL_PRODUCT_KEY = 'ws_monitor_product_prices';
const HL_COLLAPSED_KEY = 'ws_monitor_hl_collapsed';

let hlHighlights = [];
let hlKeywordWeights = {};
let hlGroupKeywordWeights = {};
let hlProductPriceMap = new Map();
let hlSaveTimer = null;
let hlStats = { total: 0, receive: 0, ignore: 0, cancel: 0 };
let hlIsCollapsed = false;

const hlPanel = document.getElementById('hlPanel');
const hlBody = document.getElementById('hlBody');
const hlEmpty = document.getElementById('hlEmpty');
const hlToggle = document.getElementById('hlToggle');
const hlFloatBtn = document.getElementById('hlFloatBtn');
const hlCount = document.getElementById('hlCount');
const hlTotal = document.getElementById('hlTotal');
const hlReceive = document.getElementById('hlReceive');
const hlIgnore = document.getElementById('hlIgnore');
const hlCancelEl = document.getElementById('hlCancel');
const hlFloatCount = document.getElementById('hlFloatCount');

function hlNormalizeKeyword(text) {
  return text.replace(/兔/g, '免');
}

function hlExtractPrice(text) {
  let prices = [];
  let match;
  const regex = new RegExp(HL_PRICE_PATTERNS.source, 'g');
  while ((match = regex.exec(text)) !== null) {
    const price = parseFloat(match[1] || match[2] || match[3] || match[4]);
    if (!isNaN(price) && price > 0) prices.push(price);
  }
  const emojiRegex = new RegExp(HL_EMOJI_PRICE.source, 'g');
  while ((match = emojiRegex.exec(text)) !== null) {
    const price = parseFloat(match[1]);
    if (!isNaN(price) && price > 0) prices.push(price);
  }

  // 如果没有匹配到价格，尝试匹配纯数字（带小数点）
  if (prices.length === 0) {
    const simpleRegex = /(?:^|[^a-zA-Z0-9])(\d+\.\d{1,2})(?=[^a-zA-Z0-9]|$)/g;
    while ((match = simpleRegex.exec(text)) !== null) {
      const price = parseFloat(match[1]);
      if (!isNaN(price) && price > 0 && price < 10000) {
        prices.push(price);
      }
    }
  }

  return Math.max(...prices) || null;
}

function hlExtractProductName(text) {
  const match = text.match(/^【?[^【\]]{2,20}】?\s*[0-9]|^[^0-9\n]{2,30}?(?=\s*(?:到手|最终|实付|只需|拍下|活动|优惠|现价|免|0元|免费|$|\s{2,}))/);
  if (match) return match[0].trim().substring(0, 30);
  const brandMatch = text.match(/^【?([^\s]{2,10}(?:官方|旗舰店|专卖店|超市|team店|team官网|team店|team))/);
  if (brandMatch) return brandMatch[1].trim();
  return null;
}



function hlIsHighlight(data, allCodes) {
  if (!data || (!data.raw_message && !data.message)) return { triggered: false, reasons: [], keywords: [] };
  const text = cleanContent(data.raw_message || data.message || '');
  const rawText = data.raw_message || data.message || '';
  // 用户要求：不监控包含“凑”字的消息
  if (/凑|湊/.test(rawText)) {
    return { triggered: false, reasons: [], keywords: [] };
  }

  // 检测口令和链接（基于原始文本）
  const hasCodes = allCodes && allCodes.length > 0;
  const hasLink = /(?:jd\.com|taobao\.com|tmall\.com|jd\.cn|mao\.mall)/i.test(rawText);
  const hasCodeOrLink = hasCodes || hasLink;

  // 创建清理后的文本：移除淘口令和链接，用于关键词、价格、文案匹配
  let cleanedText = text;
  // 移除淘口令
  cleanedText = cleanedText.replace(CLEAN_TAO_REG, '');
  // 移除链接
  cleanedText = cleanedText.replace(/https?:\/\/[^\s<>]+/gi, '');
  // 移除可能的链接前缀（如"链接："、"口令："等）
  cleanedText = cleanedText.replace(/(?:链接|口令|密码|提取码|淘口令)[：:]\s*/gi, '');

  // 关键词匹配（基于清理后的文本）
  const keywords = [];
  for (const kw of HL_KEYWORDS) {
    if (cleanedText.toLowerCase().includes(kw.toLowerCase())) {
      keywords.push(kw);
    }
  }
  const reasons = [];
  if (keywords.length > 0) reasons.push('keyword');

  // 价格提取（基于清理后的文本）
  const price = extractPriceFromText(cleanedText);
  const hasPrice = price !== null;

  // 价格条件：价格 <= 6 且 有口令/链接
  if (hasPrice && price <= 6 && hasCodeOrLink) {
    reasons.push(`好价:${price}元`);
  }

  // 计算纯文本长度（基于清理后的文本）
  const pureText = cleanedText.replace(/[\s,，。.，。！!？?\d]+/g, ' ').trim();
  const pureTextLength = pureText.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length;

  // 条件2：文案长度<=7且有口令/链接
  if (pureTextLength <= 7 && hasCodeOrLink) {
    reasons.push('短文案');
  }

  return { triggered: reasons.length > 0, reasons, keywords, price };
}

// 提取价格的函数
function extractPriceFromText(text) {
  // 正则匹配：数字（可带小数点）后面可以跟表情、空格、换行、字母或无字符
  // 但不能跟元、亓等文字
  const priceRegex = /(\d+(?:\.\d+)?)(?=[\s\w\ud800-\udfff]|$)/g;
  const matches = [];
  let match;
  
  while ((match = priceRegex.exec(text)) !== null) {
    const priceStr = match[1];
    const price = parseFloat(priceStr);
    if (!isNaN(price) && price > 0) {
      matches.push(price);
    }
  }
  
  if (matches.length === 0) return null;
  
  // 优先选择有小数点的价格
  const decimalPrices = matches.filter(p => p.toString().includes('.'));
  if (decimalPrices.length > 0) {
    // 选择第一个小数点价格（可以根据需求调整为最大的小数点价格）
    return decimalPrices[0];
  }
  
  // 都没有小数点，选择最大的数字
  return Math.max(...matches);
}

function hlGetKeywordWeight(keyword, group) {
  const kwData = hlKeywordWeights[keyword];
  if (!kwData || (kwData.r + kwData.i + kwData.c) < 5) return 1;
  const weight = kwData.r * 3 + kwData.i * (-1) + kwData.c * (-5);
  if (group && hlGroupKeywordWeights[group] && hlGroupKeywordWeights[group][keyword]) {
    const gData = hlGroupKeywordWeights[group][keyword];
    if ((gData.r + gData.i + gData.c) >= 5) {
      return gData.r * 3 + gData.i * (-1) + gData.c * (-5);
    }
  }
  return weight;
}

function hlUpdateStats() {
  hlStats.total = hlHighlights.length;
  hlStats.receive = hlHighlights.filter(h => h.feedback === 'received').length;
  hlStats.ignore = hlHighlights.filter(h => h.feedback === 'ignored').length;
  hlStats.cancel = hlHighlights.filter(h => h.feedback === 'canceled').length;
  hlCount.textContent = hlStats.total;
  hlTotal.textContent = hlStats.total;
  hlReceive.textContent = hlStats.receive;
  hlIgnore.textContent = hlStats.ignore;
  hlCancelEl.textContent = hlStats.cancel;
  hlFloatCount.textContent = hlStats.total;
}

function hlUpdateWeight(keywords, action, group) {
  for (const kw of keywords) {
    if (!hlKeywordWeights[kw]) hlKeywordWeights[kw] = { r: 0, i: 0, c: 0 };
    if (action === 'received') hlKeywordWeights[kw].r++;
    else if (action === 'ignored') hlKeywordWeights[kw].i++;
    else if (action === 'canceled') hlKeywordWeights[kw].c++;
    if (group) {
      if (!hlGroupKeywordWeights[group]) hlGroupKeywordWeights[group] = {};
      if (!hlGroupKeywordWeights[group][kw]) hlGroupKeywordWeights[group][kw] = { r: 0, i: 0, c: 0 };
      if (action === 'received') hlGroupKeywordWeights[group][kw].r++;
      else if (action === 'ignored') hlGroupKeywordWeights[group][kw].i++;
      else if (action === 'canceled') hlGroupKeywordWeights[group][kw].c++;
    }
  }
  hlSaveDebounced();
}

function hlSyncCardKeywordColors() {
  document.querySelectorAll('.hl-card').forEach(card => {
    const group = card.dataset.group;
    const keywordsEl = card.querySelector('.hl-keywords');
    if (!keywordsEl) return;
    keywordsEl.querySelectorAll('.hl-tag').forEach(tag => {
      const kw = tag.dataset.kw;
      const weight = hlGetKeywordWeight(kw, group);
      tag.className = 'hl-tag ' + (weight > 0 ? 'hl-tag-highlight' : 'hl-tag-gray');
    });
  });
}

function hlCreateCard(item, index) {
  const data = item.data;
  const card = document.createElement('div');
  card.className = 'msg-card hl-card' + (item.feedback === 'canceled' ? ' canceled' : '');
  card.dataset.index = index;
  card.dataset.hash = data.hash || getContentHash(data);
  card.dataset.group = data.group_name || data.group_id || '';
  const source = data.group_name || data.group_id || '未知来源';
  const time = formatTime(data.time || Date.now() / 1000);
  const content = cleanContent(data.raw_message || data.message || '');
  const images = extractImages(data);
  const nickname = data.sender?.nickname || '';
  const msgId = data.local_id || 0;
  const keywords = item.keywords || [];
  
  let keywordsHtml = '<div class="hl-keywords">';
  for (const kw of keywords) {
    const weight = hlGetKeywordWeight(kw, source);
    const cls = weight > 0 ? 'hl-tag-highlight' : 'hl-tag-gray';
    keywordsHtml += `<span class="hl-tag ${cls}" data-kw="${escapeAttr(kw)}">${escapeHtml(kw)}</span>`;
  }
  keywordsHtml += '</div>';
  
  let imagesHtml = '';
  if (images.length > 0) {
    imagesHtml = images.map(img => `<img class="msg-image" src="${img}" alt="图片" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.border='2px red solid'; this.title='加载失败: '+this.src;">`).join('');
  }
  
  let feedbackBtnsHtml = '';
  if (item.feedback) {
    const btnText = item.feedback === 'received' ? '已收到' : item.feedback === 'ignored' ? '已忽视' : '已取消';
    feedbackBtnsHtml = `<button class="hl-btn" disabled>${btnText}</button>`;
  } else {
    feedbackBtnsHtml = `
      <button class="hl-btn hl-btn-receive" data-action="received">收到</button>
      <button class="hl-btn hl-btn-ignore" data-action="ignored">忽视</button>
      <button class="hl-btn hl-btn-cancel" data-action="canceled">取消</button>
    `;
  }
  
  card.innerHTML = `
    <div class="msg-header">
      <div class="msg-source-wrap">
        <div class="msg-source"><span class="group-icon">🏠</span>${escapeHtml(source)}</div>
        ${keywordsHtml}
      </div>
      <div class="msg-time">${time}</div>
    </div>
    <div class="msg-body">
      <div class="msg-content">${makeLinksClickable(escapeHtml(content))}</div>
      ${imagesHtml}
    </div>
    <div class="msg-footer">
      <div class="msg-meta">
        ${nickname ? `<span>👤 ${escapeHtml(nickname)}</span>` : ''}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="copy-btn" data-images="${escapeAttr(JSON.stringify(images))}" data-content="${escapeAttr(content)}">复制</button>
        <button class="context-btn" data-group-id="${data.group_id || ''}" data-group-name="${escapeAttr(source)}" data-time="${data.time || 0}" data-local-id="${msgId}">查看上下文</button>
        ${feedbackBtnsHtml}
      </div>
    </div>
  `;
  return card;
}

function hlHandleFeedback(index, action) {
  const item = hlHighlights[index];
  if (!item || item.feedback) return;
  item.feedback = action;
  hlUpdateWeight(item.keywords, action, item.data.group_name || item.data.group_id);
  hlUpdateStats();
  const card = hlBody.querySelector(`[data-index="${index}"]`);
  if (card) {
    if (action === 'canceled') card.classList.add('canceled');
    const btns = card.querySelector('.hl-feedback-btns');
    const btnText = action === 'received' ? '已收到' : action === 'ignored' ? '已忽视' : '已取消';
    btns.innerHTML = `<button class="hl-btn" disabled>${btnText}</button>`;
  }
  hlSyncCardKeywordColors();
  hlSaveDebounced();
}

function hlAdd(data, keywords) {
  const item = { data, keywords, feedback: null };
  hlHighlights.unshift(item);
  if (hlHighlights.length > 50) hlHighlights = hlHighlights.slice(0, 50);
  hlUpdateStats();
  const card = hlCreateCard(item, 0);
  if (hlEmpty.style.display !== 'none') hlEmpty.style.display = 'none';
  hlBody.insertBefore(card, hlBody.firstChild);
  if (hlBody.children.length > 50) {
    hlBody.lastChild.remove();
  }
  hlSaveDebounced();
}

function hlSaveDebounced() {
  if (hlSaveTimer) clearTimeout(hlSaveTimer);
  hlSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(HL_STORAGE_KEY, JSON.stringify(hlHighlights));
      localStorage.setItem(HL_KW_KEY, JSON.stringify(hlKeywordWeights));
      localStorage.setItem(HL_GROUP_KW_KEY, JSON.stringify(hlGroupKeywordWeights));
      localStorage.setItem(HL_PRODUCT_KEY, JSON.stringify([...hlProductPriceMap]));
    } catch (e) { console.error('HL save error:', e); }
  }, 2000);
}

function hlFlushSave() {
  if (hlSaveTimer) {
    clearTimeout(hlSaveTimer);
    hlSaveTimer = null;
    try {
      localStorage.setItem(HL_STORAGE_KEY, JSON.stringify(hlHighlights));
      localStorage.setItem(HL_KW_KEY, JSON.stringify(hlKeywordWeights));
      localStorage.setItem(HL_GROUP_KW_KEY, JSON.stringify(hlGroupKeywordWeights));
      localStorage.setItem(HL_PRODUCT_KEY, JSON.stringify([...hlProductPriceMap]));
    } catch (e) { console.error('HL flush save error:', e); }
  }
}

function hlLoad() {
  try {
    const saved = localStorage.getItem(HL_STORAGE_KEY);
    const savedKw = localStorage.getItem(HL_KW_KEY);
    const savedGroupKw = localStorage.getItem(HL_GROUP_KW_KEY);
    const savedProduct = localStorage.getItem(HL_PRODUCT_KEY);
    const savedCollapsed = localStorage.getItem(HL_COLLAPSED_KEY);
    if (saved) hlHighlights = JSON.parse(saved);
    if (savedKw) hlKeywordWeights = JSON.parse(savedKw);
    if (savedGroupKw) hlGroupKeywordWeights = JSON.parse(savedGroupKw);
    if (savedProduct) {
      try { hlProductPriceMap = new Map(JSON.parse(savedProduct)); } catch(e) {}
    }
    if (savedCollapsed === 'true') {
      hlIsCollapsed = true;
      hlPanel.classList.add('collapsed');
      hlFloatBtn.classList.add('show');
      hlToggle.textContent = '展开';
    }
  } catch (e) { console.error('HL load error:', e); }
}

function hlRender() {
  const hasEmpty = hlBody.querySelector('.hl-empty');
  hlBody.innerHTML = '';
  if (hlHighlights.length === 0) {
    hlBody.appendChild(hlEmpty);
    hlEmpty.style.display = 'block';
  } else {
    if (hasEmpty) hlEmpty.style.display = 'none';
    hlHighlights.forEach((item, i) => {
      const card = hlCreateCard(item, i);
      hlBody.appendChild(card);
    });
  }
  hlUpdateStats();
}

function hlTogglePanel() {
  hlIsCollapsed = !hlIsCollapsed;
  hlPanel.classList.toggle('collapsed', hlIsCollapsed);
  hlFloatBtn.classList.toggle('show', hlIsCollapsed);
  hlToggle.textContent = hlIsCollapsed ? '展开' : '收起';
  localStorage.setItem(HL_COLLAPSED_KEY, hlIsCollapsed);
}

function hlExpand() {
  hlIsCollapsed = false;
  hlPanel.classList.remove('collapsed');
  hlFloatBtn.classList.remove('show');
  hlToggle.textContent = '收起';
  localStorage.setItem(HL_COLLAPSED_KEY, 'false');
}

window.addEventListener('beforeunload', () => {
  flushSave();
  hlFlushSave();
});



const wsUrlInput = document.getElementById('wsUrl');
const connectBtn = document.getElementById('connectBtn');
const clearBtn = document.getElementById('clearBtn');
const messagesDiv = document.getElementById('messages');
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const countSpan = document.getElementById('count');
const debugDiv = document.getElementById('debug');
const imgOverlay = document.getElementById('imgOverlay');
const overlayImg = document.getElementById('overlayImg');
const contextModal = document.getElementById('contextModal');
const contextTitle = document.getElementById('contextTitle');
const contextList = document.getElementById('contextList');
const contextClose = document.getElementById('contextClose');

let msgCount = 0;
let ws = null;
let reconnectTimer = null;
let reconnectCount = 0;
let savedMessages = [];
let duplicateTracker = new Map();
let productDuplicateTracker = new Map();
let jdDuplicateTracker = new Map();
let cleanupTimer = null;
let isManualClose = false;
let globalMsgId = 0;
let unreadCount = 0;
const unreadBadge = document.getElementById('topUnreadBar');
let saveTimer = null;

window.addEventListener('scroll', () => {
  const distToBottom = document.body.scrollHeight - window.scrollY - window.innerHeight;
  if (distToBottom < 50) {
    unreadCount = 0;
    unreadBadge.classList.remove('show');
    messagesDiv.querySelectorAll('[data-unread="true"]').forEach(el => el.removeAttribute('data-unread'));
  }
}, { passive: true });

function log(msg){
  debugDiv.textContent = msg;
  debugDiv.classList.add('show');
  console.log(msg);
}

function jumpToUnread() {
  const firstUnread = messagesDiv.querySelector('[data-unread="true"]');
  if (!firstUnread) return;
  firstUnread.scrollIntoView({ behavior: 'smooth', block: 'center' });
  firstUnread.classList.add('unread-highlight');
  firstUnread.removeAttribute('data-unread');
    unreadCount = 0;
    unreadBadge.classList.remove('show');
    messagesDiv.querySelectorAll('[data-unread="true"]').forEach(el => el.removeAttribute('data-unread'));
  setTimeout(() => {
    firstUnread.classList.remove('unread-highlight');
  }, 1500);
}

function clearLog(){
  debugDiv.textContent = '';
  debugDiv.classList.remove('show');
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function cleanContent(content) {
  content = String(content);
  content = content.replace(CQ_IMAGE_REG, '');
  content = content.replace(/\[CQ:reply,[^\]]+\]/g, '');
  content = content.replace(/\[CQ:at,qq=\d+,name=([^\]]+)\]/g, '@$1');
  content = content.replace(/\[CQ:[^\]]+\]/g, '');
  content = content.replace(/&#91;/g, '[');
  content = content.replace(/&#93;/g, ']');
  content = content.replace(/&amp;/g, '&');
  return content;
}

function extractTextContent(data) {
  let text = '';
  if (data.message) {
    if (Array.isArray(data.message)) {
      data.message.forEach(m => {
        if (m.type === 'text') {
          text += m.data.text + ' ';
        }
      });
    } else {
      text = String(data.message);
    }
  } else if (data.raw_message) {
    text = String(data.raw_message);
  }
  text = cleanContent(text);
  return text.trim();
}

function extractImageIds(data) {
  const ids = [];
  if (data.message && Array.isArray(data.message)) {
    data.message.forEach(m => {
      if (m.type === 'image') {
        const file = m.data.file || m.data.url || '';
        const match = file.match(/[a-zA-Z0-9]{20,}/);
        if (match) ids.push(match[0]);
      }
    });
  }
  return ids;
}

function extractAllTaoCodes(data) {
  const text = (data.raw_message || String(data.message || '')).replace(CQ_IMAGE_REG, '');
  const codes = [];
  for (const m of text.matchAll(CLEAN_TAO_REG)) {
    let code = m[1].replace(/^[^\u4e00-\u9fa5a-zA-Z0-9]+/, '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+$/, '');
    if (code.length === 11 && /[a-z]/.test(code)) codes.push(code);
  }
  return codes;
}

async function fetchProductId(taoCode) {
  const url = `https://api.zhetaoke.com:10001/api/open_shangpin_id.ashx?appkey=9cf0a8e0abe44a37aa0ac29682f281bf&sid=162371&content=${encodeURIComponent(taoCode)}&type=1&tlj=1&hjs=1&pid=mm_420790137_511000486_108879600217`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.item_id) {
      const parts = data.item_id.split('-');
      return parts.length > 1 ? parts[1] : data.item_id;
    }
    return null;
  } catch(e) {
    return null;
  }
}

const JD_URL_REG = /(?:https?:\/\/)?(?:[a-z]*\.)?(?:jd\.com|3\.cn)[^\s]*/gi;

function getJDParam(url, name) {
  const match = url.match(new RegExp('[?&]' + name + '=([^&]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return await resp.text();
  } catch(e) {
    clearTimeout(timer);
    return null;
  }
}

async function fetchRedirect(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { redirect: 'manual', signal: controller.signal });
    clearTimeout(timer);
    return resp.headers.get('Location') || null;
  } catch(e) {
    clearTimeout(timer);
    return null;
  }
}

function extractJDUrls(text) {
  const urls = [];
  const regex = /(?:https?:\/\/)?(?:[a-z0-9]*\.)*(?:jd\.com|3\.cn)[^\s<>"']*/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    let url = match[0];
    if (!url.startsWith('http')) url = 'https://' + url;
    urls.push(url);
  }
  return urls;
}

function extractJDSyncId(url) {
  const cleanUrl = url.split('?')[0];
  
  // v.m.jd.com → p参数
  if (/v\.m\.jd\.com/i.test(url)) {
    const p = getJDParam(url, 'p');
    if (p) {
      const firstItem = p.split(',')[0];
      const skuId = firstItem.split(':')[0];
      if (/^\d{6,}$/.test(skuId)) return 'JD:' + skuId;
    }
  }
  
  // skuList参数
  if (/skuList/i.test(url)) {
    const skuList = getJDParam(url, 'skuList');
    if (skuList) {
      const firstItem = skuList.split(',')[0];
      const skuId = firstItem.split(':')[0];
      if (/^\d{6,}$/.test(skuId)) return 'JD:' + skuId;
    }
  }
  
  // /item.xxx.html → 商品ID
  const itemMatch = url.match(/\/item\.(\d{5,})/);
  if (itemMatch) return 'JD:' + itemMatch[1];
  
  // /数字.html → 商品ID
  const pathMatch = cleanUrl.match(/\/(\d{5,})\.html/);
  if (pathMatch) return 'JD:' + pathMatch[1];
  
  // lives.jd.com → #/和?之间
  const livesMatch = url.match(/lives\.jd\.com.*?#\/([^?]+)/i);
  if (livesMatch) return 'JD:LIVE:' + livesMatch[1];
  
  // coupon.m.jd.com → key参数
  if (/coupon\.m\.jd\.com/i.test(url)) {
    const key = getJDParam(url, 'key');
    if (key) return 'JD:COUPON:' + key;
  }
  
  // pro.m.jd.com → 活动ID
  const proMatch = url.match(/pro\.m\.jd\.com.*?\/active\/([^/?#]+)/i);
  if (proMatch) return 'JD:ACT:' + proMatch[1];
  
  // q参数
  const q = getJDParam(url, 'q');
  if (q && q.length > 5 && /^\d{5,}$/.test(q)) return 'JD:' + q;
  
  // 兜底：jd.com/后到?前的数字路径
  const genericMatch = url.match(/jd\.com\/(\d{5,})/i);
  if (genericMatch) return 'JD:' + genericMatch[1];
  
  return null;
}

async function extractJDAsyncId(url) {
  if (/u\.jd\.com/i.test(url)) {
    const html = await fetchWithTimeout(url, 3000);
    if (!html) return null;
    const hrlMatch = html.match(/var hrl='([^']+)'/);
    if (!hrlMatch) return null;
    const location = await fetchRedirect(hrlMatch[1], 3000);
    if (!location) return null;
    return extractJDSyncId(location);
  }
  
  if (/3\.cn\//i.test(url)) {
    const location = await fetchRedirect(url, 3000);
    if (!location) return null;
    return extractJDSyncId(location);
  }
  
  return null;
}

async function extractJDProductIds(data) {
  const text = data.raw_message || data.message || '';
  const urls = extractJDUrls(text);
  const ids = [];
  
  for (const url of urls) {
    const syncId = extractJDSyncId(url);
    if (syncId) {
      ids.push(syncId);
      continue;
    }
    const asyncId = await extractJDAsyncId(url);
    if (asyncId) ids.push(asyncId);
  }
  
  return [...new Set(ids)];
}

function extractImages(data) {
  const urlSet = new Set();
  let hasArrayImages = false;
  
  // 规范化图片URL，去除末尾问号等
  function normalizeUrl(url) {
    if (url.endsWith('?')) {
      url = url.slice(0, -1);
    }
    return url;
  }
  
  // 处理数组格式的消息（结构化消息）
  if (data.message && Array.isArray(data.message)) {
    data.message.forEach(m => {
      if (m.type === 'image') {
        let url = m.data.url || m.data.file;
        if (url) {
          urlSet.add(normalizeUrl(url));
          hasArrayImages = true;
        }
      }
    });
  }
  
  // 从CQ码字符串中提取图片URL
  function extractFromCQ(str) {
    if (!str || typeof str !== 'string') return;
    const regex = /\[CQ:image,([^\]]+)\]/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
      const params = match[1];
      let url = '';
      const urlMatch = params.match(/url=([^,]+)/);
      if (urlMatch) {
        url = urlMatch[1];
      } else {
        const fileMatch = params.match(/file=([^,]+)/);
        if (fileMatch) {
          url = fileMatch[1];
        }
      }
      if (url) urlSet.add(normalizeUrl(url));
    }
  }
  
  // 从data.message字符串中提取
  if (typeof data.message === 'string') {
    extractFromCQ(data.message);
  }
  // 从data.raw_message中提取，但仅当数组中没有图片时
  if (!hasArrayImages && data.raw_message && typeof data.raw_message === 'string') {
    extractFromCQ(data.raw_message);
  }
  
  // 生成代理URL数组，确保唯一性
  const images = [];
  const proxySet = new Set();
  for (const url of urlSet) {
    const proxyUrl = 'proxy.php?url=' + encodeURIComponent(url);
    if (!proxySet.has(proxyUrl)) {
      proxySet.add(proxyUrl);
      images.push(proxyUrl);
    }
  }
  // 再次确保唯一性
  return [...new Set(images)];
}

function normalizeChars(text) {
  for(const [from, to] of Object.entries(CHAR_MAP)) {
    text = text.split(from).join(to);
  }
  return text;
}

function getNormalizedText(data) {
  let text = (data.raw_message || String(data.message || '')).replace(CQ_IMAGE_REG, '');
  text = text.replace(CLEAN_TAO_REG, '');
  
  // 处理链接：京东链接替换为统一标记JD，其他链接移除
  text = text.replace(/https?:\/\/[^\s<>]+/gi, (url) => {
    const jdId = extractJDSyncId(url);
    if (jdId) {
      return 'JD'; // 所有京东链接统一替换为JD
    }
    return ''; // 其他链接移除
  });
  
  text = text.replace(/领\d*折[券卷]*/g, '');
  text = text.replace(/[-–—―]{2,}/g, '');
  text = text.replace(/[→←↑↓💰￥¥$¥￥~〰～⭕✔✖⚠❗❕📢📣📅📆⏰⏳🎁🔔🔵📌❤💚💛💜🧡✅❌🔴🟠🟡🟢⚫⚪🏠👤👍👏🤝⭐🌟★🎉🎊🛒🛍🧧🔥]+/gu);
  text = text.replace(/[^一-龥a-zA-Z0-9]/gu, '');
  text = text.replace(/购物卷/g, '购物券');
  text = text.replace(/g\+/gi, 'g');
  text = text.replace(/[;，,;.。:：!！?？]+/g, '');
  text = text.replace(/[.。]{2,}/g, '.');
  text = text.replace(/[+-]{2,}/g, '+');
  text = normalizeChars(text);
  text = normalizeOCR(text);
  text = text.replace(/(\d+(?:\.\d+)?)[元亓块]元?/g, 'N');
  text = text.replace(/\d+/g, '');
  return text.trim();
}

function getContentHash(data) {
  const text = getNormalizedText(data);
  const productMatch = text.match(/[一-龥]{2,}(?:g|ml|包|袋|瓶|箱|件|个|支|套|罐|盒|筒)/);
  const product = productMatch ? productMatch[0] : '';
  let price = '';
  const priceMatch = text.match(/凑后[【\[(]?(\d+(?:\.\d+)?)[】\]]?元?|到手(\d+(?:\.\d+)?)元/);
  if (priceMatch) {
    price = priceMatch[1] || priceMatch[2] || '';
  }
  if (product && price) {
    return simpleHash(product + '|' + price);
  }
  return simpleHash(text);
}

function updateStatus(connected){
  dot.className = 'dot' + (connected ? ' connected' : '');
  statusText.textContent = connected ? '已连接' : '未连接';
  connectBtn.textContent = connected ? '断开' : '连接';
  connectBtn.disabled = false;
  if(connected){
    connectBtn.classList.add('connected');
    wsUrlInput.disabled = true;
  } else {
    connectBtn.classList.remove('connected');
    wsUrlInput.disabled = false;
  }
}

function formatTime(timestamp){
  const d = new Date(timestamp * 1000);
  return d.toLocaleTimeString('zh-CN', {
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
}

function escapeHtml(text){
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function makeLinksClickable(text) {
  const urlPattern = /((https?:\/\/|www\.)[^\s<>"]+)/gi;
  return text.replace(urlPattern, (url) => {
    const href = url.startsWith('www.') ? 'https://' + url : url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="msg-link">${escapeAttr(url)}</a>`;
  });
}

function createMsgCard(data, { contentDupInfo = null, productDupInfo = null, productIds = [], isHighlight = false, highlightKeywords = [], matchReason = '' } = {}) {
  const card = document.createElement('div');
  card.className = 'msg-card';
  if (isHighlight) card.classList.add('highlight');
  
  const source = data.group_name || data.group_id || '未知来源';
  const time = formatTime(data.time || Date.now() / 1000);
  const content = cleanContent(data.raw_message || data.message || '');
  const images = extractImages(data);
  const nickname = data.sender?.nickname || '';
  const userId = data.sender?.user_id || '';
  const msgId = data.local_id || globalMsgId;
  const hash = getContentHash(data);
  card.dataset.hash = hash;
  if (productIds.length > 0) card.dataset.productIds = JSON.stringify(productIds);
  
  let imagesHtml = '';
  const hasTextContent = content.trim().length > 0;
  // 只有图片没有文字时，不在卡片中显示图片（但上下文查看仍会显示）
  if (images.length > 0 && hasTextContent) {
    imagesHtml = images.map(img => `<img class="msg-image" src="${img}" alt="图片" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.border='2px red solid'; this.title='加载失败: '+this.src;">`).join('');
  }
  
  let dupTagHtml = '';
  let productDupTagHtml = '';
  let dupGroupsHtml = '';
  // 删除重复消息标签，设为空字符串
  let highlightKeywordsHtml = '';
  // 高亮关键词标签已移除
  
    card.innerHTML = `
     <div class="msg-header">
       <div class="msg-source-wrap">
         <div class="msg-source"><span class="group-icon">🏠</span>${escapeHtml(source)} ${matchReason}</div>
         ${dupTagHtml}
         ${productDupTagHtml}
       </div>
       <div class="msg-time">${time}</div>
     </div>
    ${dupGroupsHtml}
    <div class="msg-body">
      <div class="msg-content">${makeLinksClickable(escapeHtml(content))}</div>
      ${imagesHtml}
    </div>
    <div class="msg-footer">
      <div class="msg-meta">
        ${nickname ? `<span>👤 ${escapeHtml(nickname)}</span>` : ''}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="copy-btn" data-images="${escapeAttr(JSON.stringify(images))}" data-content="${escapeAttr(content)}">复制</button>
        <button class="context-btn" data-group-id="${data.group_id || ''}" data-group-name="${escapeAttr(source)}" data-time="${data.time || 0}" data-local-id="${msgId}">查看上下文</button>
      </div>
    </div>
  `;
  
  return card;
}

function updateDupTag(card, dupInfo){
  const tag = card.querySelector('.dup-tag:not(.product-dup)');
  if (tag) {
    tag.innerHTML = `${dupInfo.count}个群发送了同样的消息 <span class="arrow">↑</span>`;
    tag.dataset.groups = JSON.stringify(dupInfo.groups);
    tag.classList.toggle('hidden', dupInfo.count <= 1);
  }
  updateAllGroupsTag(card);
}

function updateAllGroupsTag(card) {
  const hash = card.dataset.hash;
  const dupInfo = duplicateTracker.get(hash);
  const pInfoKeys = JSON.parse(card.dataset.productIds || '[]');
  const pInfos = pInfoKeys.map(id => productDuplicateTracker.get(id)).filter(Boolean);
  const groupsDiv = card.querySelector('.dup-groups-list');
  if (!groupsDiv) return;
  const allGroups = [...new Set([
    ...(dupInfo?.groups || []),
    ...pInfos.flatMap(p => p.groups || [])
  ])];
  groupsDiv.innerHTML = allGroups.map(g => `<span>🏠 ${escapeHtml(g)}</span>`).join('');
}

function updateCardProductTag(card, pInfo) {
  let tag = card.querySelector('.product-dup');
  const pInfoKeys = JSON.parse(card.dataset.productIds || '[]');
  const allPInfos = pInfoKeys.map(id => productDuplicateTracker.get(id)).filter(Boolean);
  const totalCount = allPInfos.reduce((sum, p) => sum + (p.count || 1), 0);
  if (allPInfos.length > 0) {
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'dup-tag product-dup';
      const sourceWrap = card.querySelector('.msg-source-wrap');
      sourceWrap.appendChild(tag);
    }
    tag.innerHTML = `🛒 ${totalCount}个群发送了同款商品 <span class="arrow">↑</span>`;
    tag.dataset.groups = JSON.stringify(allPInfos.flatMap(p => p.groups || []));
    tag.dataset.productId = pInfo.productId;
    tag.classList.remove('hidden');
  }
  updateAllGroupsTag(card);
}

async function copyContent(btn, images, content){
  try {
    await navigator.clipboard.writeText(content);
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('copied');
    }, 1500);
  } catch(e) {
    btn.textContent = '失败';
    setTimeout(() => {
      btn.textContent = '复制';
    }, 1500);
    console.error('Copy error:', e);
  }
}

function getContextMessages(groupId, currentLocalId) {
  const gid = Number(groupId) || 0;

  const groupMessages = savedMessages.filter(m => Number(m.group_id) === gid);

  if (groupMessages.length === 0) return [];

  const sorted = [...groupMessages].sort((a, b) => (a.time || 0) - (b.time || 0));

  const safeLocalId = Number(currentLocalId) || 0;
  let currentIndex = sorted.findIndex(m => m.local_id === safeLocalId);
  if (currentIndex === -1) currentIndex = 0;

  const ctxCount = 5;
  const start = Math.max(0, currentIndex - ctxCount);
  const end = Math.min(sorted.length - 1, currentIndex + ctxCount);

  return sorted.slice(start, end + 1).map((m, i) => ({
    ...m,
    isCurrent: i === currentIndex - start,
    index: start + i
  }));
}

function showContextModal(groupId, groupName, currentLocalId) {
  const messages = getContextMessages(groupId, currentLocalId);

  contextTitle.textContent = `🏠 ${groupName}  #${currentLocalId}`;
  contextList.innerHTML = '';

  let currentIdx = -1;
  if (messages.length === 0) {
    contextList.innerHTML = `<div style="color:#999;padding:20px;text-align:center;">暂无上下文</div>`;
  } else {
    messages.forEach((msg, i) => {
      if(msg.isCurrent) currentIdx = i;

      const item = document.createElement('div');
      item.className = 'ctx-item' + (msg.isCurrent ? ' current' : '');
      item.dataset.images = JSON.stringify(extractImages(msg));
      item.dataset.content = escapeHtml(cleanContent(msg.raw_message || msg.message || ''));
      item.dataset.rawMessage = escapeHtml(msg.raw_message || msg.message || '');

      const senderName = msg.sender?.nickname || '未知';
      const senderTime = formatTime(msg.time || 0);
      const images = extractImages(msg);
      const imagesHtml = images.map(img => `<img class="ctx-img" src="${img}" alt="图片" referrerpolicy="no-referrer" crossorigin="anonymous" onerror="this.style.border='2px red solid'; this.title='加载失败: '+this.src;">`).join('');
      const content = escapeHtml(cleanContent(msg.raw_message || msg.message || ''));

      item.innerHTML = `
        <div class="ctx-header">
          <div class="ctx-sender"><span class="ctx-icon">👤</span>${escapeHtml(senderName)} <button class="ctx-copy-btn" style="margin-left:8px;padding:1px 8px;font-size:11px;vertical-align:middle;">复制</button></div>
          <div class="ctx-time">${senderTime}</div>
        </div>
        <div class="ctx-body">
          <div class="ctx-content">${makeLinksClickable(content)}</div>
          ${imagesHtml}
        </div>
      `;

      contextList.appendChild(item);

      if (i < messages.length - 1) {
        const nextTime = messages[i + 1].time || 0;
        const currTime = msg.time || 0;
        const diff = nextTime - currTime;
        if (diff > 120) {
          const gap = document.createElement('div');
          gap.className = 'ctx-gap';
          gap.textContent = `⏱ ${Math.floor(diff / 60)} 分钟后`;
          contextList.appendChild(gap);
        }
      }
    });
  }

  contextModal.classList.add('show');
  const currentEl = contextList.querySelector('.ctx-item.current');
  if (currentEl) {
    setTimeout(() => {
      currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }
}

function checkTextDuplicate(hash, normalizedText, source, now) {
  if (duplicateTracker.has(hash)) {
    const info = duplicateTracker.get(hash);
    if (!info.groups.includes(source)) {
      info.groups.push(source);
      info.count = info.groups.length;
    }
    info.lastTime = now;
    if (info.card && info.card.parentNode) {
      updateDupTag(info.card, info);
      updateAllGroupsTag(info.card);
    }
    return true;
  }
  for (const [existingHash, info] of duplicateTracker) {
    if (textSimilarity(normalizedText, info.normalizedText) >= SIMILARITY_THRESHOLD) {
      if (!info.groups.includes(source)) {
        info.groups.push(source);
        info.count = info.groups.length;
      }
      info.lastTime = now;
      if (info.card && info.card.parentNode) {
        updateDupTag(info.card, info);
        updateAllGroupsTag(info.card);
      }
      return true;
    }
  }
  return false;
}

async function addMessage(data){
  const allCodes = extractAllTaoCodes(data);
  const now = Date.now();
  const source = data.group_name || data.group_id || '未知来源';
  const contentPreview = cleanContent(data.raw_message || data.message || '').substring(0, 25);

  const hash = getContentHash(data);
  const normalizedText = getNormalizedText(data);

  console.log(`[DEBUG] hash=${hash} norm=${normalizedText} codes=${JSON.stringify(allCodes)}`);

  const hasImages = extractImages(data).length > 0;
  if (!hasImages && checkTextDuplicate(hash, normalizedText, source, now)) {
    log(`[已过滤] ${source}\n${contentPreview}...`);
    return;
  }

  // Extract JD product IDs from URLs
  const jdIds = await extractJDProductIds(data);
  console.log(`[DEBUG] JD IDs=${JSON.stringify(jdIds)}`);
  
  // Fetch Taobao product IDs for codes
  let productResults = [];
  if (allCodes.length > 0) {
    for (const code of allCodes) {
      const id = await fetchProductId('￥' + code + '￥');
      if (id) productResults.push({ code, productId: id });
    }
  }
  
  // Add JD IDs to productResults
  jdIds.forEach(id => productResults.push({ code: null, productId: id }));
  
  console.log(`[DEBUG] allProductIds=${JSON.stringify(productResults.map(r => r.productId))} trackerKeys=${JSON.stringify([...productDuplicateTracker.keys()])}`);
  
  // Check for existing product duplicates
  const existingProductIds = productResults.filter(r => productDuplicateTracker.has(r.productId));
  if (existingProductIds.length > 0) {
    for (const { productId } of existingProductIds) {
      const pInfo = productDuplicateTracker.get(productId);
      if (pInfo && !pInfo.groups.includes(source)) {
        pInfo.groups.push(source);
        pInfo.count = pInfo.groups.length;
      }
      if (pInfo && pInfo.card) {
        updateCardProductTag(pInfo.card, pInfo);
        updateAllGroupsTag(pInfo.card);
      }
    }
    log(`[同商品] ${source}\n${contentPreview}...`);
    return;
  }

  globalMsgId++;
  data.local_id = globalMsgId;

  savedMessages.push(data);
  if(savedMessages.length > 500) savedMessages = savedMessages.slice(-500);
  saveMessages();
  
  if(msgCount === 0){
    messagesDiv.innerHTML = '';
  }
  msgCount++;
  countSpan.textContent = msgCount;

   const hlResult = hlIsHighlight(data, allCodes);
   const newProductIds = productResults.map(r => r.productId).filter(id => id);
   const matchReason = hlResult.reasons.length > 0 ? `[${hlResult.reasons.join(', ')}]` : '';
   const card = createMsgCard(data, { contentDupInfo: { count: 1, groups: [source] }, productDupInfo: null, productIds: newProductIds, isHighlight: hlResult.triggered, highlightKeywords: hlResult.keywords, matchReason: matchReason });

   const wasAtBottomBefore = document.body.scrollHeight - window.scrollY - window.innerHeight < 50;

   // 根据显示模式决定是否显示消息
   if (displayMode === 'highlight' && !hlResult.triggered) {
     // 仅显示重点消息时，非重点消息直接跳过
     return;
   }

   messagesDiv.appendChild(card);

  for (const productId of newProductIds) {
    if (productId) {
      productDuplicateTracker.set(productId, {
        productId,
        content: data.raw_message || data.message || '',
        count: 1,
        groups: [source],
        firstTime: now,
        lastTime: now,
        card: card
      });
    }
  }
  
  if (wasAtBottomBefore) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    });
    const imgs = card.querySelectorAll('img');
    if (imgs.length > 0) {
      let loaded = 0;
      imgs.forEach(img => {
        if (img.complete) loaded++;
        else img.addEventListener('load', () => { loaded++; if (loaded === imgs.length) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })); }, { once: true });
      });
    }
    unreadCount = 0;
    unreadBadge.classList.remove('show');
    messagesDiv.querySelectorAll('[data-unread="true"]').forEach(el => el.removeAttribute('data-unread'));
  } else {
    card.dataset.unread = 'true';
    unreadCount++;
    unreadBadge.textContent = unreadCount > 99 ? '99+' : `获取到新消息 ${unreadCount}`;
    unreadBadge.classList.add('show');
  }
  
  duplicateTracker.set(hash, {
    content: data.raw_message || data.message || '',
    normalizedText: normalizedText,
    count: 1,
    groups: [source],
    firstTime: now,
    lastTime: now,
    card: card
  });
  
  log(`[新消息] #${globalMsgId} ${source}\n${contentPreview}...`);
  
}

function cleanupDuplicateTracker(){
  const now = Date.now();
  for(const [hash, info] of duplicateTracker){
    if(now - info.lastTime > DEDUP_DURATION){
      // 如果卡片已从DOM移除，先删除card属性
      if (info.card && !info.card.parentNode) {
        delete info.card;
      }
      duplicateTracker.delete(hash);
    }
  }
  for(const [productId, info] of productDuplicateTracker){
    if(now - info.lastTime > DEDUP_DURATION){
      if (info.card && !info.card.parentNode) {
        delete info.card;
      }
      productDuplicateTracker.delete(productId);
    }
  }
  for(const [jdId, info] of jdDuplicateTracker){
    if(now - info.lastTime > DEDUP_DURATION){
      if (info.card && !info.card.parentNode) {
        delete info.card;
      }
      jdDuplicateTracker.delete(jdId);
    }
  }
}

  function saveMessages(){
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try{
        const dataStr = JSON.stringify(savedMessages);
        if(dataStr.length > 2 * 1024 * 1024){
          const seen = new Set();
          savedMessages = savedMessages.reverse().filter(msg => {
            const hash = getContentHash(msg);
            if(seen.has(hash)) return false;
            seen.add(hash);
            return true;
          }).slice(0, 500).reverse();
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedMessages));
        localStorage.setItem(STORAGE_URL_KEY, wsUrlInput.value);
        localStorage.setItem(STORAGE_MSG_ID_KEY, globalMsgId);
      } catch(e){ console.error('Save error:', e); }
    }, 3000);
  }
  
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedMessages));
        localStorage.setItem(STORAGE_URL_KEY, wsUrlInput.value);
        localStorage.setItem(STORAGE_MSG_ID_KEY, globalMsgId);
      } catch(e) { console.error('Flush save error:', e); }
    }
  }

  function loadMessages(){
    try{
      const saved = localStorage.getItem(STORAGE_KEY);
      const savedUrl = localStorage.getItem(STORAGE_URL_KEY);
      const savedMsgId = localStorage.getItem(STORAGE_MSG_ID_KEY);
      if(saved){
        const parsed = JSON.parse(saved);
        const seen = new Set();
        savedMessages = parsed.filter(msg => {
          const hash = getContentHash(msg);
          if(seen.has(hash)) return false;
          seen.add(hash);
          return true;
        });
      }
      if(savedUrl) wsUrlInput.value = savedUrl;
      if(savedMsgId) globalMsgId = parseInt(savedMsgId) || 0;
    } catch(e){ console.error('Load error:', e); }
  }

function renderSavedMessages(){
  if(savedMessages.length > 0){
    messagesDiv.innerHTML = '';
    duplicateTracker.clear();
    
    savedMessages.forEach((msg, i) => {
      if (!msg.local_id) {
        msg.local_id = i + 1;
      }
      const hash = getContentHash(msg);
      const source = msg.group_name || msg.group_id || '未知来源';
      
      if(duplicateTracker.has(hash)){
        const info = duplicateTracker.get(hash);
        if(!info.groups.includes(source)){
          info.groups.push(source);
          info.count = info.groups.length;
        }
        updateDupTag(info.card, info);
        updateAllGroupsTag(info.card);
      } else {
        const card = createMsgCard(msg, { contentDupInfo: { count: 1, groups: [source] }, productDupInfo: null, productIds: [] });
        messagesDiv.appendChild(card);
        
        // 限制左侧面板卡片数量，防止内存泄漏
        const maxCards = 200;
        if (messagesDiv.children.length > maxCards) {
          const toRemove = messagesDiv.children.length - maxCards;
          for (let i = 0; i < toRemove; i++) {
            messagesDiv.removeChild(messagesDiv.children[0]);
          }
        }
        msgCount++;
        countSpan.textContent = msgCount;
        
        const msgNormalizedText = getNormalizedText(msg);
        duplicateTracker.set(hash, {
          content: msg.raw_message || msg.message || '',
          normalizedText: msgNormalizedText,
          count: 1,
          groups: [source],
          firstTime: Date.now(),
          lastTime: Date.now(),
          card: card
        });
      }
    });
    const scrollToBottom = () => {
      window.scrollTo(0, document.body.scrollHeight);
    };
    requestAnimationFrame(() => {
      scrollToBottom();
      // 延迟再次滚动，确保图片等资源加载后位置准确
      setTimeout(scrollToBottom, 300);
    });
  }
}

function connect(){
  const url = wsUrlInput.value.trim();
  if(!url) return;
  
  // 如果重连次数超过5次，停止自动重连
  if(reconnectCount >= 5) {
    console.log('已达到最大重连次数（5次），停止自动重连');
    return;
  }
  
  if(reconnectTimer){
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if(ws){
    ws.close();
    ws = null;
  }
  
  updateStatus(false);
  connectBtn.disabled = true;
  
  try{
    ws = new WebSocket(url);
    
    ws.onopen = () => {
      reconnectCount = 0; // 连接成功，重置重连计数
      updateStatus(true);
      cleanupTimer = setInterval(cleanupDuplicateTracker, 60000);
      clearLog();
    };
    
    ws.onmessage = (event) => {
      try{
        const data = JSON.parse(event.data);
        if(data.post_type !== 'meta_event'){
          addMessage(data);
        }
      } catch(e){
        console.log('Parse error:', e);
      }
    };
    
    ws.onclose = () => {
      if(isManualClose){
        isManualClose = false;
        updateStatus(false);
        return;
      }
      updateStatus(false);
      if(cleanupTimer){
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      reconnectCount++;
      if(reconnectCount >= 5) {
        console.log('已达到最大重连次数（5次），停止自动重连');
        return;
      }
      reconnectTimer = setTimeout(() => {
    reconnectCount = 0; // 手动连接，重置重连计数
    connect();
      }, 3000);
    };
    
    ws.onerror = (err) => {
      console.error('WebSocket 错误:', err);
    };
  } catch(e){
    console.error('连接失败:', e);
    reconnectCount++;
    if(reconnectCount >= 5) {
      console.log('已达到最大重连次数（5次），停止自动重连');
      return;
    }
    reconnectTimer = setTimeout(() => {
      connect();
    }, 3000);
  }
}

function toggleConnect(){
  if(ws && ws.readyState === WebSocket.OPEN){
    isManualClose = true;
    ws.close();
  } else {
    connect();
  }
}

// 事件绑定
connectBtn.addEventListener('click', toggleConnect);

clearBtn.addEventListener('click', () => {
  savedMessages = [];
  duplicateTracker.clear();
  productDuplicateTracker.clear();
  jdDuplicateTracker.clear();
  msgCount = 0;
  globalMsgId = 0;
  countSpan.textContent = 0;
  unreadCount = 0;
  unreadBadge.classList.remove('show');
  messagesDiv.innerHTML = '<div class="empty">等待新消息...</div>';
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(STORAGE_MSG_ID_KEY);
  hlProductPriceMap.clear();
  clearLog();
});

wsUrlInput.addEventListener('change', saveMessages);
wsUrlInput.addEventListener('keypress', (e) => {
  if(e.key === 'Enter' && !wsUrlInput.disabled){
    connect();
  }
});

// 图片放大
imgOverlay.addEventListener('click', () => {
  imgOverlay.classList.remove('show');
});

// 上下文弹窗关闭
contextClose.addEventListener('click', () => {
  contextModal.classList.remove('show');
});

contextModal.addEventListener('click', (e) => {
  if(e.target === contextModal) {
    contextModal.classList.remove('show');
  }
});

// 事件委托
document.addEventListener('click', (e) => {
  // 图片点击放大
  if(e.target.classList.contains('msg-image') || e.target.classList.contains('ctx-img')){
    overlayImg.src = e.target.src;
    imgOverlay.classList.add('show');
  }

  // 复制按钮
  if(e.target.classList.contains('copy-btn') || e.target.classList.contains('ctx-copy-btn') || e.target.closest('.copy-btn') || e.target.closest('.ctx-copy-btn')){
    const btn = e.target.classList.contains('copy-btn') || e.target.classList.contains('ctx-copy-btn') ? e.target : (e.target.closest('.copy-btn') || e.target.closest('.ctx-copy-btn'));
    let images = [], content = '';
    if(btn.classList.contains('ctx-copy-btn')){
      images = JSON.parse(btn.closest('.ctx-item').dataset.images || '[]');
      content = btn.closest('.ctx-item').dataset.content || '';
    } else {
      images = JSON.parse(btn.dataset.images || '[]');
      content = btn.dataset.content || '';
    }
    copyContent(btn, images, content);
  }
  
  // 上下文按钮
  if(e.target.classList.contains('context-btn') || e.target.closest('.context-btn')){
    const btn = e.target.classList.contains('context-btn') ? e.target : e.target.closest('.context-btn');
    const groupId = btn.dataset.groupId || '';
    const groupName = btn.dataset.groupName || '';
    const localId = parseInt(btn.dataset.localId) || 0;
    showContextModal(groupId, groupName, localId);
  }
  
  // 重复标记展开
  if(e.target.classList.contains('dup-tag') || e.target.closest('.dup-tag')){
    const tag = e.target.classList.contains('dup-tag') ? e.target : e.target.closest('.dup-tag');
    const card = tag.closest('.msg-card');
    const groupsDiv = card.querySelector('.dup-groups');
    const groupsList = card.querySelector('.dup-groups-list');
    
    // 如果点击的是已展开的标签，则收起
    if (tag.classList.contains('expanded')) {
      tag.classList.remove('expanded');
      if (groupsDiv) groupsDiv.classList.remove('show');
    } else {
      // 收起其他标签
      card.querySelectorAll('.dup-tag.expanded').forEach(t => t.classList.remove('expanded'));
      // 展开当前标签
      tag.classList.add('expanded');
      if (groupsDiv) groupsDiv.classList.add('show');
    }
  }
  

});

loadMessages();
renderSavedMessages();

connect();
function toggleConfig() {
  const config = document.querySelector('.config');
  const statusBar = document.querySelector('.status-bar');
  const toggle = document.getElementById('configToggle');
  const isShowing = config.classList.contains('show');
  config.classList.toggle('show');
  statusBar.classList.toggle('show');
  toggle.classList.toggle('show', !isShowing);
  toggle.textContent = isShowing ? '⚙' : '×';
}

// 初始化：隐藏配置区域和状态栏
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.config').classList.remove('show');
  document.querySelector('.status-bar').classList.remove('show');
