const express = require('express');
const { middleware, messagingApi } = require('@line/bot-sdk');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const Parser = require('rss-parser');
const rssParser = new Parser();

const app = express();
// 注意：不能用 app.use(express.json()) 套用到全部路由，否則會搶先解析掉
// LINE webhook 需要的原始內容，導致簽章驗證失敗。

// =====================================================================
// ★★★ 你可以自己編輯的設定區（不用懂程式，照範例改就好）★★★
// =====================================================================

// 股市快報追蹤標的（陣列順序＝顯示順序）
// source: 'twse'=證交所官方(台股大盤)；'yahoo'=Yahoo Finance(美股/美元/ADR，query1→query2 備援)
const STOCK_SYMBOLS = [
  { source: 'twse',  label: '台指' },                       // 發行量加權股價指數（官方）
  { source: 'yahoo', symbol: 'TSM',      label: '台積電ADR' },
  { source: 'yahoo', symbol: 'DX-Y.NYB', label: '美元' },
  { source: 'yahoo', symbol: '^IXIC',    label: '那斯' },
  { source: 'yahoo', symbol: '^DJI',     label: '道瓊' },
  { source: 'yahoo', symbol: '^SOX',     label: '費城' },
  { source: 'yahoo', symbol: '^GSPC',    label: 'S&P' },
];

// 固定/週期雜事提醒（到日子當天早上提醒）；type: monthly/yearly/weekly
const RECURRING_REMINDERS = [
  // { title: '信用卡繳費', type: 'monthly', day: 15 },
  // { title: '報稅',       type: 'yearly',  month: 5, day: 1 },
  // { title: '資源回收日', type: 'weekly',  weekday: 3 },  // 0=日 1=一 ... 6=六
];

// 空品：AQI 大於此值就提醒（你鼻子敏感 → 50，普通以上就提醒）
const AQI_REMIND_ABOVE = 50;

// 經期設定
const PERIOD_LEN_DEFAULT = 5;   // 生理期天數（來了之後自動算這麼多天都是生理期）
const CYCLE_RECENT_N     = 6;   // 平均週期只取「最近幾次」計算（越近越準）
const CYCLE_LEN_FALLBACK = 40;  // 還沒有足夠紀錄時的預設週期（依你近期平均）

// =====================================================================
// 以下為程式邏輯
// =====================================================================

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

app.get('/', (req, res) => {
  res.send('LINE 小管家（早/晚簡報 + 財經 + 經期/症狀紀錄）運作中 ✅');
});

app.post('/webhook', middleware(lineConfig), async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleTextMessage(event);
    }
  }
  res.sendStatus(200);
});

// ===== Upstash Redis 存取（存經期紀錄與症狀紀錄）=====
async function upstashSet(key, value) {
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!res.ok) throw new Error('寫入 Upstash 失敗: ' + (await res.text()));
  return res.json();
}
async function upstashGet(key) {
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  if (!res.ok) throw new Error('讀取 Upstash 失敗: ' + (await res.text()));
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

// ===== 定時提醒入口 =====
app.get('/api/remind', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }
  const type = req.query.type;
  try {
    if (type === 'morning') {
      await pushMorningBriefing();
      await pushPeriodReminder();           // 經期提醒：獨立一則，有內容才送
      return res.status(200).send('已推送早安簡報');
    }
    if (type === 'evening') { await pushEveningBriefing(); return res.status(200).send('已推送晚安簡報'); }
    if (type === 'stock')   { await pushStock();           return res.status(200).send('已推送股市快報'); }
    if (type === 'weather') { await pushSingle(await buildWeatherText()); return res.status(200).send('ok'); }
    if (type === 'news')    { await pushSingle(await buildNewsText());    return res.status(200).send('ok'); }
    if (type === 'aqi')     { await pushSingle(await buildAqiText());     return res.status(200).send('ok'); }
    if (type === 'period')  { await pushPeriodReminder();                 return res.status(200).send('ok'); }
    res.status(400).send(`未知的提醒類型: ${type}`);
  } catch (err) {
    console.error('推播提醒時發生錯誤：', err);
    res.status(500).send('推播失敗');
  }
});

async function pushSingle(text) {
  await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text: text || '（這個項目目前沒有內容）' }] });
}
async function safe(fn) {
  try { return await fn(); } catch (e) { console.error('區塊失敗：', fn.name, e.message); return null; }
}

// ===== 早安簡報（07:00）=====
async function pushMorningBriefing() {
  const parts = [];
  const news = await safe(buildNewsText);    if (news) parts.push(news);
  const aqi  = await safe(buildAqiText);      if (aqi)  parts.push(aqi);
  const rem  = buildReminderText();           if (rem)  parts.push(rem);
  const body = parts.length ? parts.join('\n\n——————————\n\n') : '今天沒有特別的提醒，祝你有美好的一天 🌳';
  await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text: `☀️ 早安！今天的重點：\n\n${body}` }] });
}

// ===== 晚安簡報（17:00）=====
async function pushEveningBriefing() {
  const parts = [];
  const aqi = await safe(buildAqiText);     if (aqi) parts.push(aqi);
  const wx  = await safe(buildWeatherText); if (wx)  parts.push(wx);
  const body = parts.length ? parts.join('\n\n——————————\n\n') : '🌙 今晚沒有特別提醒，早點休息喔。';
  await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text: body }] });
}

// ===== 科技晨報 =====
const NEWS_FEEDS = [
  { name: '科技新報', url: 'https://technews.tw/feed/' },
  { name: 'INSIDE', url: 'https://www.inside.com.tw/feed' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
];
async function fetchAllNewsItems() {
  const results = [];
  for (const feed of NEWS_FEEDS) {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 5).map((item) => ({
        source: feed.name, title: item.title || '',
        summary: (item.contentSnippet || item.summary || '').slice(0, 150),
      }));
      results.push(...items);
    } catch (err) { console.error(`抓取 ${feed.name} RSS 失敗：`, err.message); }
  }
  return results;
}
async function buildNewsText() {
  const newsItems = await fetchAllNewsItems();
  if (newsItems.length === 0) return '📰 科技晨報：今天抓不到新聞來源，晚點再試。';
  const newsListText = newsItems.map((it, i) => `${i + 1}. [${it.source}] ${it.title}：${it.summary}`).join('\n');
  const prompt = `以下是今天從幾個科技媒體抓到的新聞標題與摘要：\n\n${newsListText}\n\n請從中挑選 3 個今天最重要、最值得知道的科技大事，每條用約 30 個字總結精華，用繁體中文。請嚴格遵循以下格式回覆，不要有其他文字、不要markdown：\n\n📰 科技晨報：\n\n1. （第一條摘要）\n2. （第二條摘要）\n3. （第三條摘要）`;
  const geminiData = await callGemini(
    { contents: [{ parts: [{ text: prompt }] }] },
    { models: ['gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'] }
  );
  return extractText(geminiData);
}

// ===== 空氣品質（AQI > 門檻才回傳）=====
function describeAqi(aqiValue) {
  const aqi = parseInt(aqiValue, 10);
  if (isNaN(aqi)) return null;
  if (aqi <= 50)  return { aqi, level: '良好 🟢', advice: '空氣品質良好。' };
  if (aqi <= 100) return { aqi, level: '普通 🟡', advice: '你鼻子敏感，建議外出戴口罩 😷' };
  if (aqi <= 150) return { aqi, level: '對敏感族群不健康 🟠', advice: '減少戶外活動，外出戴口罩 😷' };
  if (aqi <= 200) return { aqi, level: '對所有族群不健康 🔴', advice: '減少戶外活動，外出務必戴口罩 😷' };
  if (aqi <= 300) return { aqi, level: '非常不健康 🟣', advice: '避免戶外活動，外出務必戴口罩 😷' };
  return { aqi, level: '危害 🟤', advice: '盡量待在室內，避免外出。' };
}
async function buildAqiText() {
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  const url = `https://data.moenv.gov.tw/api/v2/aqx_p_432?offset=0&limit=1000&api_key=${process.env.MOENV_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const records = Array.isArray(data) ? data : (data.records || []);
  const station = records.find(r => r.sitename === '桃園');
  if (!station) return null;
  const info = describeAqi(station.aqi);
  if (!info || info.aqi <= AQI_REMIND_ABOVE) return null;
  const pm25 = station['pm2.5'] || '無資料';
  return `🌫️ 空氣品質（桃園測站）\nAQI：${info.aqi}（${info.level}）  PM2.5：${pm25}\n${info.advice}`;
}

// ===== 明天天氣（Gemini + 搜尋）=====
async function buildWeatherText() {
  const location = '龜山（桃園）';
  const tomorrowStr = getTaipeiTomorrowString();
  const prompt = `明天的日期是 ${tomorrowStr}（台灣時區）。請查詢「${location}」明天的天氣預報，用繁體中文簡潔地回覆，內容包含：\n1. 所在地點\n2. 明天的天氣狀況與溫度範圍\n3. 是否會下雨、降雨機率\n4. 需要注意的事項（例如要不要帶傘、防曬、保暖、適合的衣著例如薄長袖等實用建議）\n\n請用口語、像在跟朋友說話的語氣，不要太長，整段控制在 100 字以內。開頭請用「☀️ 明日天氣預告」。`;
  const geminiData = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }]
  });
  return extractText(geminiData);
}

// ===== 股市快報（台股證交所官方 + 美股 Yahoo 雙主機備援，0 AI）=====
function fmtNum(n) { return Number(n).toFixed(2); }

// Yahoo：query1 主、query2 備
async function yahooQuote(symbol) {
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const j = await res.json();
      const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (meta && typeof meta.regularMarketPrice === 'number') {
        const price = meta.regularMarketPrice;
        const prev = (typeof meta.chartPreviousClose === 'number') ? meta.chartPreviousClose : meta.previousClose;
        return { price, chg: (typeof prev === 'number') ? (price - prev) : 0 };
      }
    } catch (e) { /* 換下一個主機 */ }
  }
  return null;
}

// 證交所官方：發行量加權股價指數（台股大盤）
async function twseTaiex() {
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const arr = await res.json();
    const row = Array.isArray(arr) && arr.find(r => r['指數'] === '發行量加權股價指數');
    if (!row) return null;
    const price = parseFloat(String(row['收盤指數']).replace(/,/g, ''));
    let chg = parseFloat(String(row['漲跌點數']).replace(/,/g, ''));
    if (isNaN(price)) return null;
    chg = isNaN(chg) ? 0 : (row['漲跌'] === '-' ? -Math.abs(chg) : Math.abs(chg));
    return { price, chg };
  } catch (e) { return null; }
}

async function buildStockText() {
  const lines = [];
  for (const s of STOCK_SYMBOLS) {
    let q = null;
    if (s.source === 'twse') { q = await twseTaiex(); if (!q) q = await yahooQuote('^TWII'); } // 官方掛了退回 Yahoo
    else q = await yahooQuote(s.symbol);
    if (!q) { console.error('股市抓取失敗：', s.label); continue; }
    lines.push(`${s.label} ${fmtNum(q.price)}(${q.chg >= 0 ? '🔺' : '🔽'}${fmtNum(Math.abs(q.chg))})`);
  }
  if (!lines.length) return null;
  const p = taipeiParts();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `📊 股市快報 ${p.m}/${p.d} ${pad(now.getHours())}:${pad(now.getMinutes())}\n${lines.join('\n')}`;
}
async function pushStock() {
  const text = await buildStockText();
  if (text) await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text }] });
}

// ===== 固定/週期雜事提醒 =====
function buildReminderText() {
  if (!RECURRING_REMINDERS.length) return null;
  const t = taipeiParts();
  const hits = [];
  for (const r of RECURRING_REMINDERS) {
    let due = false;
    if (r.type === 'monthly') due = (t.d === r.day);
    else if (r.type === 'yearly') due = (t.m === r.month && t.d === r.day);
    else if (r.type === 'weekly') due = (t.wd === r.weekday);
    if (due) hits.push(`🔔 ${r.title}`);
  }
  return hits.length ? `✅ 今天別忘了\n${hits.join('\n')}` : null;
}

// =====================================================================
// 經期追蹤 + 症狀紀錄（資料存 Upstash，純規則、0 AI）
// =====================================================================
async function getPeriodStarts() { return (await upstashGet('period_starts')) || []; }
async function savePeriodStarts(arr) { await upstashSet('period_starts', arr); }

// 記錄一次月經開始（10 天內視為「補登/更正」同一次，直接取代）
async function logPeriodStart(dateKeyStr) {
  let arr = await getPeriodStarts();
  let replaced = false;
  for (let i = 0; i < arr.length; i++) {
    if (Math.abs(daysBetween(arr[i], dateKeyStr)) < 10) { arr[i] = dateKeyStr; replaced = true; break; }
  }
  if (!replaced) arr.push(dateKeyStr);
  arr = Array.from(new Set(arr)).sort();
  await savePeriodStarts(arr);
  return arr;
}

function recentDiffs(starts) {
  const r = starts.slice(-(CYCLE_RECENT_N + 1));
  const d = [];
  for (let i = 1; i < r.length; i++) d.push(daysBetween(r[i - 1], r[i]));
  return d;
}
function computeAvgCycle(starts) {
  const d = recentDiffs(starts);
  if (!d.length) return CYCLE_LEN_FALLBACK;
  return Math.round(d.reduce((a, b) => a + b, 0) / d.length);
}
function computeSpread(starts) {
  const d = recentDiffs(starts);
  if (d.length < 2) return 7;
  return Math.min(15, Math.max(3, Math.round((Math.max(...d) - Math.min(...d)) / 2)));
}
function predict(starts) {
  if (!starts.length) return null;
  const last = starts[starts.length - 1];
  const cycle = computeAvgCycle(starts);
  const nextStart = addDays(last, cycle);
  const ovulation = addDays(nextStart, -14);
  return {
    last, cycle, nextStart, ovulation,
    fertileStart: addDays(ovulation, -5),
    fertileEnd: addDays(ovulation, 1),
    spread: computeSpread(starts),
  };
}

// 每天早上的經期提醒（有內容才回傳）
function buildPeriodReminderText(starts) {
  if (!starts.length) return null;
  const p = predict(starts);
  const today = getTaipeiTodayString();
  const parts = [];

  const sinceLast = daysBetween(p.last, today);
  if (sinceLast >= 0 && sinceLast < PERIOD_LEN_DEFAULT) {
    parts.push(`今天是生理期第 ${sinceLast + 1} 天，多喝溫水、別太累 💗`);
  }

  if (today >= p.fertileStart && today <= p.fertileEnd) {
    parts.push(`💛 易孕期（參考）：約 ${p.fertileStart} ~ ${p.fertileEnd}。`);
  }
  if (Math.abs(daysBetween(today, p.ovulation)) <= 1) {
    parts.push(`🥚 接近排卵日（約 ${p.ovulation}，參考）：可能有輕微腹痛、分泌物變化。`);
  }

  const toNext = daysBetween(today, p.nextStart);
  if (toNext <= 10 && toNext >= 0) {
    parts.push(`⚠️ 經前留意期：預計約 ${toNext} 天後來（±${p.spread} 天）。注意偏頭痛，建議多休息、規律睡眠、補水，避開誘因（熬夜、咖啡因忽多忽少、紅酒/起司/巧克力、強光與壓力），必要時先備藥。`);
  } else if (toNext < 0 && sinceLast >= PERIOD_LEN_DEFAULT) {
    parts.push(`⏰ 已超過預計來潮日約 ${-toNext} 天，可能隨時會來，請留意偏頭痛。來了記得跟我說「月經來了」唷。`);
  }

  if (!parts.length) return null;
  return `🌸 小管家・經期提醒\n\n${parts.join('\n\n')}\n\n（你的週期較不規則，以上為估計、僅供參考）`;
}

function buildPredictionReplyText(starts) {
  if (!starts.length) {
    return '目前還沒有任何月經紀錄喔～你可以跟我說「月經來了」或「11/11 月經來了」，我就會開始幫你記錄並預測 🌸';
  }
  const p = predict(starts);
  const today = getTaipeiTodayString();
  const toNext = daysBetween(today, p.nextStart);
  const lo = addDays(p.nextStart, -p.spread);
  const hi = addDays(p.nextStart, p.spread);
  const whenTxt = toNext >= 0 ? `大約還有 ${toNext} 天` : `已超過預計約 ${-toNext} 天`;
  return `🌸 經期預測（參考用）\n上次開始：${p.last}\n近期平均週期：約 ${p.cycle} 天\n預計下次：約 ${lo} ~ ${hi}（${whenTxt}）\n排卵日約：${p.ovulation}（易孕期約 ${p.fertileStart} ~ ${p.fertileEnd}）\n\n⚠️ 你的週期較不規則，以上為估計、僅供參考。`;
}

async function logSymptom(dateKeyStr, text) {
  let arr = (await upstashGet('symptom_log')) || [];
  arr.push({ date: dateKeyStr, text });
  if (arr.length > 300) arr = arr.slice(-300);
  await upstashSet('symptom_log', arr);
  return arr;
}
async function buildSymptomHistoryText() {
  const arr = (await upstashGet('symptom_log')) || [];
  if (!arr.length) return '目前還沒有症狀紀錄～你不舒服時跟我說一聲（例如「頭痛」），我就會幫你記下來 📝';
  const recent = arr.slice(-10).reverse().map(x => `・${x.date}　${x.text}`).join('\n');
  return `📋 最近的症狀紀錄：\n${recent}`;
}

async function pushPeriodReminder() {
  const starts = await getPeriodStarts();
  const text = buildPeriodReminderText(starts);
  if (text) await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text }] });
}

// ===== 日期工具（台灣時區；date key = YYYY-MM-DD）=====
function pad(n) { return String(n).padStart(2, '0'); }
function taipeiParts() {
  const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), wd: t.getDay() };
}
function getTaipeiTodayString() { const p = taipeiParts(); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
function getTaipeiTomorrowString() { return addDays(getTaipeiTodayString(), 1); }
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function daysBetween(k1, k2) { return Math.round((parseKey(k2) - parseKey(k1)) / 86400000); }
function addDays(k, n) {
  const d = new Date(parseKey(k) + n * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
// 把「今天/昨天/前天/大前天/M/D/M月D日」解析成 date key；預設今天
function parseWhen(text) {
  const today = getTaipeiTodayString();
  if (/大前天/.test(text)) return addDays(today, -3);
  if (/前天/.test(text)) return addDays(today, -2);
  if (/昨天|昨日/.test(text)) return addDays(today, -1);
  const md = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (md) {
    const p = taipeiParts();
    let key = `${p.y}-${pad(parseInt(md[1], 10))}-${pad(parseInt(md[2], 10))}`;
    if (daysBetween(today, key) > 1) key = `${p.y - 1}-${pad(parseInt(md[1], 10))}-${pad(parseInt(md[2], 10))}`; // 未來日期視為去年
    return key;
  }
  return today;
}

// ===== Gemini 呼叫（撞額度自動換模型）=====
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
async function callGemini(body, { models = GEMINI_MODELS, retries = 1 } = {}) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } catch (e) { lastErr = e; break; }
      if (res.ok) return res.json();
      const errorText = await res.text();
      if (res.status === 429) { lastErr = new Error(`${model} 今日額度用盡`); break; }
      if (res.status === 503 && attempt < retries) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      lastErr = new Error(`Gemini ${model} 錯誤 ${res.status}: ${errorText}`); break;
    }
  }
  throw lastErr || new Error('Gemini 呼叫失敗');
}
function extractText(geminiData) {
  const parts = geminiData && geminiData.candidates && geminiData.candidates[0]
    && geminiData.candidates[0].content && geminiData.candidates[0].content.parts;
  if (!parts || !parts[0] || !parts[0].text) throw new Error('Gemini 未回傳有效文字：' + JSON.stringify(geminiData));
  return parts[0].text.trim();
}

// ===== 對話主流程 =====
// 先用規則處理常見指令（0 AI）；處理不了才交給 Gemini（Gemini 也會判斷經期/症狀）
const RE_SYMPTOM_QUERY = /(症狀|頭痛).*(紀錄|記錄|歷史|清單|列表)/;
const RE_PERIOD_QUERY  = /(下次|下一次|什麼時候|何時|幾天).*(月經|經期|來)|經期預測|^(月經|經期)[?？]?$/;
const RE_PERIOD_START  = /(月經|mc|MC|大姨媽|生理期|好朋友).*(來了|來|報到)|^來了$/;
const RE_SYMPTOM       = /(偏?頭痛|頭很痛|頭好痛|頭在痛|經痛|生理痛|肚子痛|想吐|噁心|反胃|頭暈|不舒服|好痛)/;
function isQuestion(t) { return /[?？]|嗎|怎麼|如何|可不可以|可以.*嗎|該不該|要不要|多少|哪/.test(t); }

async function handleTextMessage(event) {
  const userMessage = (event.message.text || '').trim();
  const replyToken = event.replyToken;
  console.log('=== 你的 LINE userId 是：', event.source.userId, '===');

  try {
    // ---- 規則快速通道（不花 Gemini 額度）----
    if (RE_SYMPTOM_QUERY.test(userMessage)) {
      return reply(replyToken, await buildSymptomHistoryText());
    }
    if (RE_PERIOD_QUERY.test(userMessage) && !RE_PERIOD_START.test(userMessage)) {
      return reply(replyToken, buildPredictionReplyText(await getPeriodStarts()));
    }
    if (RE_PERIOD_START.test(userMessage) && !isQuestion(userMessage)) {
      const d = parseWhen(userMessage);
      const starts = await logPeriodStart(d);
      const periodEnd = addDays(d, PERIOD_LEN_DEFAULT - 1);
      return reply(replyToken, `📝 已記錄月經開始：${d}（生理期約 ${d} ~ ${periodEnd}）\n\n${buildPredictionReplyText(starts)}`);
    }
    if (RE_SYMPTOM.test(userMessage) && !isQuestion(userMessage)) {
      const d = parseWhen(userMessage);
      await logSymptom(d, userMessage);
      return reply(replyToken, `📝 已記錄：${d}　${userMessage} 🤕\n記得多休息，不舒服就別硬撐。`);
    }

    // ---- 交給 Gemini（同一次呼叫同時判斷 calendar/period/symptom/chat）----
    const todayStr = getTaipeiTodayString();
    const prompt = `你是一個 LINE 個人助理。請判斷使用者訊息屬於哪一類，並依規則給出處理結果。

今天的正確日期是 ${todayStr}（台灣時區）。

請嚴格只回傳以下 JSON（不要 markdown、不要多餘文字）：
{
  "action": "calendar | period | symptom | chat",
  "summary": "",
  "startTime": "",
  "endTime": "",
  "periodDate": "",
  "symptomText": "",
  "symptomDate": "",
  "chatReply": ""
}

規則：
1. 要新增/記錄行程或請假 → action=calendar；summary=標題；startTime/endTime 用 YYYY-MM-DDTHH:mm:ss（沒給時間預設當天09:00，沒給結束時間設開始後1小時）。
2. 使用者「表示月經/生理期來了」（陳述，不是提問）→ action=period；periodDate 填開始日 YYYY-MM-DD（沒指明日期就用今天）。
3. 使用者「描述自己身體不適或症狀」如頭痛、偏頭痛、經痛、想吐等（陳述，不是提問）→ action=symptom；symptomText 用簡短描述；symptomDate 用 YYYY-MM-DD（沒指明就今天）。
4. 其他（提問、查資料、聊天，包含「問頭痛怎麼辦」這種提問）→ action=chat；chatReply 用繁體中文口語簡潔回答。需要最新資訊時主動用搜尋工具。

使用者訊息："${userMessage}"`;

    const geminiData = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    });
    const parsed = JSON.parse(extractText(geminiData).replace(/```json|```/g, '').trim());

    if (parsed.action === 'calendar') {
      const auth = new GoogleAuth({
        credentials: {
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
          private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
        },
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.insert({
        calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
        requestBody: {
          summary: parsed.summary,
          start: { dateTime: parsed.startTime, timeZone: 'Asia/Taipei' },
          end: { dateTime: parsed.endTime, timeZone: 'Asia/Taipei' },
        },
      });
      return reply(replyToken, `📅 已寫入 Google 日曆！\n\n📌 ${parsed.summary}\n⏰ ${String(parsed.startTime).replace('T', ' ')}`);
    }

    if (parsed.action === 'period') {
      const d = (parsed.periodDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.periodDate)) ? parsed.periodDate : getTaipeiTodayString();
      const starts = await logPeriodStart(d);
      const periodEnd = addDays(d, PERIOD_LEN_DEFAULT - 1);
      return reply(replyToken, `📝 已記錄月經開始：${d}（生理期約 ${d} ~ ${periodEnd}）\n\n${buildPredictionReplyText(starts)}`);
    }

    if (parsed.action === 'symptom') {
      const d = (parsed.symptomDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.symptomDate)) ? parsed.symptomDate : getTaipeiTodayString();
      const txt = parsed.symptomText || userMessage;
      await logSymptom(d, txt);
      return reply(replyToken, `📝 已記錄：${d}　${txt} 🤕\n記得多休息，不舒服就別硬撐。`);
    }

    return reply(replyToken, parsed.chatReply || '嗯...我沒想到要怎麼回答，可以換個方式問我嗎？');

  } catch (error) {
    console.error('詳細錯誤記錄：', error);
    await reply(replyToken, '系統處理時發生錯誤，請再試一次！（若是查詢類問題，也可能是搜尋功能暫時無法使用）');
  }
}

async function reply(replyToken, text) {
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
