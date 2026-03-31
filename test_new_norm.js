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
const CQ_IMAGE_REG = /\[CQ:image,[^\]]+\]/g;
const CLEAN_TAO_REG = /([^\u4e00-\u9fa5a-zA-Z0-9]*[a-z0-9]{11}[^\u4e00-\u9fa5a-zA-Z0-9]*)/gi;

function normalizeChars(text) {
  for(const [from, to] of Object.entries(CHAR_MAP)) {
    text = text.split(from).join(to);
  }
  return text;
}

function normalizeOCR(text) {
  for (const [from, to] of Object.entries(OCR_MAP)) {
    text = text.split(from).join(to);
  }
  return text;
}

function getNormalizedText(text) {
  let t = text;
  
  t = t.replace(CQ_IMAGE_REG, '');
  t = t.replace(CLEAN_TAO_REG, '');
  t = t.replace(/https?:\/\/[^\s<>]+/gi, '');
  t = t.replace(/\s+/g, '');
  t = t.replace(/[→←↑↓💰￥¥$¥￥~〰～⭕✔✖⚠❗❕📢📣📅📆⏰⏳🎁🔔🔵📌❤💚💛💜🧡✅❌🔴🟠🟡🟢⚫⚪🏠👤👍👏🤝⭐🌟★🎉🎊🛒🛍🧧🔥]+/gu, '');
  t = normalizeChars(t);
  t = normalizeOCR(t);
  
  return t.trim();
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

function textSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const lenA = a.length, lenB = b.length;
  const maxLen = Math.max(lenA, lenB);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(a, b);
  return 1 - dist / maxLen;
}

const msg1 = "1亓 100包零食";
const msg2 = "1亓零食100包";

const norm1 = getNormalizedText(msg1);
const norm2 = getNormalizedText(msg2);
const similarity = textSimilarity(norm1, norm2);

console.log('====================================');
console.log('消息1:', msg1);
console.log('规范化1:', norm1);
console.log('消息2:', msg2);
console.log('规范化2:', norm2);
console.log('====================================');
console.log('规范化结果是否相同:', norm1 === norm2);
console.log('相似度:', similarity.toFixed(4));
console.log('是否超过0.75阈值:', similarity >= 0.75);
console.log('====================================');
