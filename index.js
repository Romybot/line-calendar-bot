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

// 空品測站名稱（原桃園→林口；你家龜山、公司華亞/林口工三交界都靠林口站較準）
const AQI_STATION = '林口';

// 空品：AQI 大於此值就提醒（你鼻子敏感 → 50，普通以上就提醒）
const AQI_REMIND_ABOVE = 50;

// 行事曆衝突提醒（B1）：記行程前先查同時段有沒有撞到 → 照樣寫入，同時回你一聲
const ENABLE_CONFLICT_CHECK = true;   // 直接時段重疊就提醒
const ENABLE_BUFFER_CHECK   = false;  // 進階：間隔不到 60 分鐘也提醒（預設關）

// 運動＆入睡守門員（B2，接在晚安簡報最後）：
// 今晚 18:00–22:00 沒排行程 ＋ 空氣好(AQI≤50) ＋ 非經期 → 建議出門走走/慢跑
const ENABLE_EXERCISE_GATE = true;

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
  res.send('LINE 小管家（早/晚簡報 + 財經 + 經期/症狀 + 行事曆守門）運作中 ✅');
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
    if (type === 'stock')   {
      await pushStock();
      await safe(pushPicks);                // 接著推前一個交易日的選股結果（有資料才送）
      return res.status(200).send('已推送股市快報');
    }
    if (type === 'picks')   { await pushPicks();           return res.status(200).send('已推送選股'); }
    if (type === 'weather') { await pushSingle(await buildWeatherText()); return res.status(200).send('ok'); }
    if (type === 'news')    { await pushSingle(await buildNewsText());    return res.status(200).send('ok'); }
    if (type === 'aqi')     { await pushSingle(await buildAqiText());     return res.status(200).send('ok'); }
    if (type === 'period')  { await pushPeriodReminder();                 return res.status(200).send('ok'); }
    if (type === 'symptom-report') { await pushSingle(await buildSymptomMonthlyReport()); return res.status(200).send('ok'); }
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
// Promise.allSettled 的小幫手：平行跑，失敗的回 null，不拖垮整則
async function settleAll(promises) {
  const rs = await Promise.allSettled(promises);
  return rs.map(r => (r.status === 'fulfilled' ? r.value : null));
}

const SEP = '\n\n——————————\n\n';

// ===== 早安簡報（07:00）=====
async function pushMorningBriefing() {
  // C1：新聞、空品平行抓（其中一個慢/壞不會卡住另一個）
  const [news, aqi] = await settleAll([buildNewsText(), buildAqiText()]);
  const rem = buildReminderText();
  const parts = [];
  if (news) parts.push(news);
  if (aqi)  parts.push(aqi);
  if (rem)  parts.push(rem);
  const body = parts.length ? parts.join(SEP) : '今天沒有特別的提醒，祝你有美好的一天 🌳';
  await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text: `☀️ 早安！今天的重點：\n\n${body}` }] });
}

// ===== 晚安簡報（17:00）=====
async function pushEveningBriefing() {
  // C1：空品、明天天氣平行抓
  const [aqi, wx] = await settleAll([buildAqiText(), buildWeatherText()]);
  const parts = [];
  if (aqi) parts.push(aqi);
  if (wx)  parts.push(wx);
  let body = parts.length ? parts.join(SEP) : '🌙 今晚沒有特別提醒，早點休息喔。';
  // B2：運動＆入睡守門員（有符合條件才加一行，條件不符就安靜）
  const ex = await safe(buildExerciseGateText);
  if (ex) body += `${SEP}${ex}`;
  await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text: body }] });
}

// ===== 科技晨報 =====
const NEWS_FEEDS = [
  { name: '科技新報', url: 'https://technews.tw/feed/' },
  { name: 'INSIDE', url: 'https://www.inside.com.tw/feed' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
];
async function fetchAllNewsItems() {
  // C1：三個來源平行抓，單一壞掉不拖垮
  const results = [];
  const settled = await Promise.allSettled(NEWS_FEEDS.map(f => rssParser.parseURL(f.url)));
  settled.forEach((r, idx) => {
    const feed = NEWS_FEEDS[idx];
    if (r.status !== 'fulfilled') { console.error(`抓取 ${feed.name} RSS 失敗：`, r.reason && r.reason.message); return; }
    const items = (r.value.items || []).slice(0, 5).map((item) => ({
      source: feed.name, title: item.title || '',
      summary: (item.contentSnippet || item.summary || '').slice(0, 150),
    }));
    results.push(...items);
  });
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

// ===== 空氣品質 =====
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
// 抓測站原始 AQI（給空品提醒和運動守門員共用）
async function fetchAqiStation() {
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  const url = `https://data.moenv.gov.tw/api/v2/aqx_p_432?offset=0&limit=1000&api_key=${process.env.MOENV_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const records = Array.isArray(data) ? data : (data.records || []);
  const station = records.find(r => r.sitename === AQI_STATION);
  if (!station) return null;
  const info = describeAqi(station.aqi);
  if (!info) return null;
  return { aqi: info.aqi, level: info.level, advice: info.advice, pm25: station['pm2.5'] || '無資料' };
}
// 空品提醒（AQI > 門檻才回傳）
async function buildAqiText() {
  const a = await fetchAqiStation();
  if (!a || a.aqi <= AQI_REMIND_ABOVE) return null;
  return `🌫️ 空氣品質（${AQI_STATION}測站）\nAQI：${a.aqi}（${a.level}）  PM2.5：${a.pm25}\n${a.advice}`;
}

// ===== 明天天氣（Gemini + 搜尋）=====
async function buildWeatherText() {
  const location = '龜山（桃園）';
  const tomorrowStr = getTaipeiTomorrowString();
  const prompt = `明天的日期是 ${tomorrowStr}（台灣時區）。請查詢「${location}」明天的天氣預報，用繁體中文簡潔地回覆，內容包含：\n1. 所在地點\n2. 明天的天氣狀況與溫度範圍\n3. 是否會下雨、降雨機率\n4. 需要注意的事項（例如要不要帶傘、防曬、保暖、適合的衣著例如薄長袖等實用建議）\n\n補充：這一帶在林口台地附近，早晚容易起霧、濕氣重。如果明天濕度偏高或有霧，請提醒帶一件防風外套、在家可以開除濕機。\n\n請用口語、像在跟朋友說話的語氣，不要太長，整段控制在 120 字以內。開頭請用「☀️ 明日天氣預告」。`;
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
// ===== 選股觀察（GitHub Actions 每個交易日收盤後算好、存 Upstash；這裡只讀取、0 AI）=====
function fmtPct(v) { return (v === null || v === undefined) ? '' : `${v >= 0 ? '+' : ''}${v}%`; }
async function buildPicksText() {
  const p = await upstashGet('stock_picks');
  if (!p || !p.date) return null;
  const today = getTaipeiTodayString();
  if (daysBetween(p.date, today) > 5) return null;            // 太舊的不推
  const md = p.date.slice(5).replace('-', '/');
  const multi = (p.multi || []).map((x, i) =>
    `${i + 1}. ${x.code} ${x.name || ''} ${fmtPct(x.chg)}${x.buckets && x.buckets.length ? '｜' + x.buckets.join('·') : ''}`).join('\n');
  const empty = (p.empty || []).map((x, i) =>
    `${i + 1}. ${x.code} ${x.name || ''} ${fmtPct(x.chg)}`).join('\n');
  const rel = Object.entries(p.release || {})
    .filter(([d]) => d >= today).slice(0, 5)
    .map(([d, items]) => `${d.slice(5).replace('-', '/')}：${items.map(x => x.code + x.name).join('、')}`).join('\n');
  return `📈 選股觀察（${md} 收盤）\n\n` +
    `【多觀察】\n${multi || '（沒有符合條件的）'}\n\n` +
    `【空觀察】\n${empty || '（沒有符合條件的）'}` +
    (rel ? `\n\n【近期出關】\n${rel}` : '') +
    `\n\n※ 依收盤資料計算，僅供參考，不是投資建議。`;
}
async function pushPicks() {
  const text = await buildPicksText();
  if (text) await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text }] });
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
// Google 行事曆（B：service account 原本只新增，現在加「讀取」）
// =====================================================================
function getCalendarClient() {
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// 讀某段時間的行程；務必排除「全天事件」(只有 start.date 沒 dateTime，如假日/生日)
async function getEvents(timeMinISO, timeMaxISO) {
  try {
    const calendar = getCalendarClient();
    const r = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    return (r.data.items || [])
      .filter(e => e.start && e.start.dateTime && e.end && e.end.dateTime) // 排除全天
      .map(e => ({ id: e.id, summary: e.summary || '(無標題)', start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }));
  } catch (e) {
    console.error('讀取行事曆失敗：', e.message);
    return [];
  }
}
function fmtClock(d) {
  const t = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
// Gemini 回的時間字串多半沒帶時區(YYYY-MM-DDTHH:mm:ss)，在 UTC 伺服器上會被當 UTC。
// 一律當台灣時間解讀；若已帶 Z 或 ±hh:mm 就照原樣。
function toTaipeiDate(s) {
  if (!s) return null;
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s) : new Date(`${s}+08:00`);
}

// B1：寫入前查該時段衝突，回傳要附在確認訊息後面的提醒字串（沒事回空字串）
async function buildConflictWarning(newStart, newEnd) {
  if (!ENABLE_CONFLICT_CHECK) return '';
  const overlap = await getEvents(newStart.toISOString(), newEnd.toISOString());
  const clashes = overlap.filter(e => e.start < newEnd && e.end > newStart);
  if (clashes.length) {
    const list = clashes.map(c => `・${fmtClock(c.start)}–${fmtClock(c.end)} ${c.summary}`).join('\n');
    return `\n\n⚠️ 這個時段原本就有安排：\n${list}`;
  }
  if (ENABLE_BUFFER_CHECK) {
    const wideStart = new Date(newStart.getTime() - 60 * 60000);
    const wideEnd = new Date(newEnd.getTime() + 60 * 60000);
    const wide = await getEvents(wideStart.toISOString(), wideEnd.toISOString());
    const near = wide
      .filter(e => !(e.start < newEnd && e.end > newStart)) // 沒重疊的才算緩衝
      .filter(e => (e.end <= newStart && (newStart - e.end) < 60 * 60000) ||
                   (e.start >= newEnd && (e.start - newEnd) < 60 * 60000));
    if (near.length) {
      const list = near.map(c => `・${fmtClock(c.start)}–${fmtClock(c.end)} ${c.summary}`).join('\n');
      return `\n\n💡 前後不到 1 小時還有：\n${list}`;
    }
  }
  return '';
}

// ===== 行程 新增/刪除/改期 的共用動作 =====
async function insertEvent(summary, startLocal, endLocal) {
  const calendar = getCalendarClient();
  await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    requestBody: {
      summary,
      start: { dateTime: startLocal, timeZone: 'Asia/Taipei' },
      end: { dateTime: endLocal, timeZone: 'Asia/Taipei' },
    },
  });
}
async function patchEventTime(eventId, startLocal, endLocal) {
  const calendar = getCalendarClient();
  await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    eventId,
    requestBody: {
      start: { dateTime: startLocal, timeZone: 'Asia/Taipei' },
      end: { dateTime: endLocal, timeZone: 'Asia/Taipei' },
    },
  });
}
async function deleteEventById(eventId) {
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary', eventId });
}
// 依「名稱關鍵字 + 哪一天」找行程；名字對不上就回當天全部，讓使用者挑
async function findEventsByNameDate(name, dateKey) {
  if (!dateKey) return [];
  const dayStart = toTaipeiDate(`${dateKey}T00:00:00`).toISOString();
  const dayEnd = toTaipeiDate(`${dateKey}T23:59:59`).toISOString();
  const evs = await getEvents(dayStart, dayEnd);
  const n = (name || '').trim();
  if (!n) return evs;
  const hit = evs.filter(e => e.summary && (e.summary.includes(n) || n.includes(e.summary)));
  return hit.length ? hit : evs;
}
function listEventsText(evs) {
  return evs.map(e => `・${fmtClock(e.start)} ${e.summary}`).join('\n');
}

// ===== 待確認行程（衝突時先問你再動作；存 Upstash，10 分鐘內有效）=====
const PENDING_TTL_MIN = 10;
async function getPending() {
  const p = await upstashGet('pending_event');
  if (!p || !p.ts) return null;
  if (Date.now() - p.ts > PENDING_TTL_MIN * 60000) { await upstashSet('pending_event', null); return null; }
  return p;
}
async function setPending(obj) {
  await upstashSet('pending_event', obj ? { ...obj, ts: Date.now() } : null);
}

// ===== 全域短期記憶（最近幾句；間隔太久自動當新話題）=====
const CHAT_HISTORY_MAX = 5;         // 最多保留幾輪
const CHAT_GAP_RESET_MIN = 30;      // 間隔超過幾分鐘視為新話題
async function getChatHistory() {
  const h = (await upstashGet('chat_history')) || [];
  if (!h.length) return [];
  const last = h[h.length - 1];
  if (last && last.ts && (Date.now() - last.ts) > CHAT_GAP_RESET_MIN * 60000) return [];
  return h;
}
async function appendChatHistory(userText, botText) {
  let h = (await upstashGet('chat_history')) || [];
  const now = Date.now();
  if (h.length && h[h.length - 1].ts && (now - h[h.length - 1].ts) > CHAT_GAP_RESET_MIN * 60000) h = [];
  h.push({ role: 'user', text: userText, ts: now });
  h.push({ role: 'model', text: String(botText).slice(0, 500), ts: now });
  if (h.length > CHAT_HISTORY_MAX * 2) h = h.slice(-CHAT_HISTORY_MAX * 2);
  await upstashSet('chat_history', h);
}
function historyToPromptText(h) {
  if (!h.length) return '';
  const lines = h.map(m => `${m.role === 'user' ? '使用者' : '你'}：${m.text}`).join('\n');
  return `\n\n【最近的對話，幫助你理解上下文；不要照抄、不要重複你自己說過的話或問過的問題】\n${lines}\n`;
}

// ===== 日期/時間解析（給「改到…」用；回台灣當地字串）=====
function taipeiISOLocal(d) {
  const t = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
}
// 從文字抓「日期」(未來優先)：明天/後天/大後天/今天/M月D日/M/D
function extractDateKey(text) {
  const today = getTaipeiTodayString();
  if (/大後天/.test(text)) return addDays(today, 3);
  if (/後天/.test(text)) return addDays(today, 2);
  if (/明天|明日/.test(text)) return addDays(today, 1);
  if (/今天|今日/.test(text)) return today;
  const md = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (md) {
    const p = taipeiParts();
    let key = `${p.y}-${pad(parseInt(md[1], 10))}-${pad(parseInt(md[2], 10))}`;
    if (daysBetween(today, key) < -1) key = `${p.y + 1}-${pad(parseInt(md[1], 10))}-${pad(parseInt(md[2], 10))}`; // 已過就算明年
    return key;
  }
  return null;
}
// 中文數字→阿拉伯（1~12，支援 十/十一/十二/兩）
function cnHour(s) {
  const map = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十') return 10 + (map[s[1]] || 0);
  if (s.length === 1) return map[s] != null ? map[s] : null;
  return null;
}
function applyAmPm(h, ap) {
  if ((ap === '下午' || ap === '晚上' || ap === '傍晚') && h < 12) h += 12;
  if (ap === '中午' && h < 12) h = 12;
  if ((ap === '早上' || ap === '上午' || ap === '凌晨') && h === 12) h = 0;
  return h;
}
// 從文字抓「時間」：15:30 / 下午3點 / 晚上7點半 / 早上十點
function extractTime(text) {
  let m = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (m) return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
  m = text.match(/(上午|早上|凌晨|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*點\s*(半|\d{1,2})?/);
  if (m) {
    const h = applyAmPm(parseInt(m[2], 10), m[1]);
    const min = m[3] === '半' ? 30 : (m[3] ? parseInt(m[3], 10) : 0);
    return { h, m: min };
  }
  m = text.match(/(上午|早上|凌晨|中午|下午|晚上|傍晚)?\s*([零一二兩三四五六七八九十]{1,3})\s*點\s*(半)?/);
  if (m) {
    const hc = cnHour(m[2]);
    if (hc != null) return { h: applyAmPm(hc, m[1]), m: m[3] === '半' ? 30 : 0 };
  }
  return null;
}
// 把使用者「改到…」的話，套用到 pending（保留原本時長）；抓不到回 null
function resolveRescheduleLocal(text, pending) {
  const dateHit = extractDateKey(text);
  const timeHit = extractTime(text);
  if (!dateHit && !timeHit) return null;
  const durMs = toTaipeiDate(pending.endLocal) - toTaipeiDate(pending.startLocal);
  const dateKey = dateHit || pending.startLocal.slice(0, 10);
  const hh = timeHit ? timeHit.h : parseInt(pending.startLocal.slice(11, 13), 10);
  const mm = timeHit ? timeHit.m : parseInt(pending.startLocal.slice(14, 16), 10);
  const startLocal = `${dateKey}T${pad(hh)}:${pad(mm)}:00`;
  const endLocal = taipeiISOLocal(new Date(toTaipeiDate(startLocal).getTime() + durMs));
  return { startLocal, endLocal };
}
const RE_CONFIRM = /^(記|照記|確定|好|好的|可以|就這樣|照樣記|記吧|幫我記|ok|OK|是|對)/;
const RE_DECLINE = /^(取消|不要|不用|不記|別記|算了|先不要|不了)/;
const RE_TIMEISH = /改|點|[:：]|號|週|周|禮拜|拜|明天|後天|早上|上午|中午|下午|晚上|傍晚|\d/;

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

// 今天落在哪個週期階段（給守門員/月報用）：'period' | 'premenstrual' | 'normal'
function periodPhaseToday(starts) {
  if (!starts.length) return 'normal';
  const p = predict(starts);
  const today = getTaipeiTodayString();
  const sinceLast = daysBetween(p.last, today);
  if (sinceLast >= 0 && sinceLast < PERIOD_LEN_DEFAULT) return 'period';
  const toNext = daysBetween(today, p.nextStart);
  if (toNext >= 0 && toNext <= 5) return 'premenstrual';
  return 'normal';
}

// 把某個日期歸到週期階段（給症狀月報交叉分析用）
function cyclePhaseForDate(dateKey, starts) {
  if (!starts.length) return '未知';
  const before = starts.filter(s => daysBetween(s, dateKey) >= 0).sort();
  const after = starts.filter(s => daysBetween(s, dateKey) < 0).sort();
  const last = before.length ? before[before.length - 1] : null;
  if (last && daysBetween(last, dateKey) < PERIOD_LEN_DEFAULT) return '經期中';
  let next = after.length ? after[0] : (last ? addDays(last, computeAvgCycle(starts)) : null);
  if (next) {
    const toNext = daysBetween(dateKey, next);
    if (toNext >= 0 && toNext <= 5) return '經前';
  }
  return '非經期';
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

// A2：症狀月報 —— 最近 90 天症狀 × 週期階段交叉統計 + Gemini 保守語氣小結（1 次 AI）
async function buildSymptomMonthlyReport() {
  const log = (await upstashGet('symptom_log')) || [];
  const starts = await getPeriodStarts();
  const today = getTaipeiTodayString();
  const cutoff = addDays(today, -90);
  const recent = log.filter(x => x.date >= cutoff);
  if (!recent.length) return '最近 90 天還沒有症狀紀錄，累積一些之後，月報才有東西可以看喔 📝';

  const counts = { '經期中': 0, '經前': 0, '非經期': 0, '未知': 0 };
  let headache = 0;
  for (const x of recent) {
    const ph = cyclePhaseForDate(x.date, starts);
    counts[ph] = (counts[ph] || 0) + 1;
    if (/頭痛|頭很痛|頭好痛|偏頭痛/.test(x.text)) headache++;
  }
  const total = recent.length;
  const dataText =
    `統計區間：最近 90 天（${cutoff} ~ ${today}）\n` +
    `總症狀次數：${total}（其中含「頭痛」字樣：${headache}）\n` +
    `依週期階段分布：經期中 ${counts['經期中']} 次、經前 ${counts['經前']} 次、非經期 ${counts['非經期']} 次、無法判斷 ${counts['未知']} 次`;

  const prompt = `你是協助整理個人健康紀錄的小助理。以下是使用者最近的症狀統計。請用繁體中文、保守、不下任何診斷的語氣，寫一段 100 字以內的摘要：描述症狀是否比較集中在某個週期階段（例如「看起來比較常出現在經前」就好），並提醒這只是粗略統計、僅供參考，如果困擾建議就醫。不要 markdown、不要列點、不要誇大。\n\n${dataText}`;
  let summary;
  try {
    summary = extractText(await callGemini(
      { contents: [{ parts: [{ text: prompt }] }] },
      { models: ['gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'] }
    ));
  } catch (e) {
    summary = '（這次沒辦法產生文字小結，先附上上面的統計數字給你參考。）';
  }
  return `📊 症狀月報（參考用）\n\n${dataText}\n\n—— 小結 ——\n${summary}\n\n可以把這則截圖下來，回診時給醫生參考。`;
}

async function pushPeriodReminder() {
  const starts = await getPeriodStarts();
  const text = buildPeriodReminderText(starts);
  if (text) await client.pushMessage({ to: process.env.LINE_USER_ID, messages: [{ type: 'text', text }] });
}

// B2：運動＆入睡守門員（接在晚安簡報後；條件不符就回 null，安靜不吵）
async function buildExerciseGateText() {
  if (!ENABLE_EXERCISE_GATE) return null;
  const today = getTaipeiTodayString();
  const t18 = `${today}T18:00:00+08:00`;
  const t22 = `${today}T22:00:00+08:00`;
  const events = await getEvents(t18, t22);
  if (events.length) return null;              // 今晚 18–22 有安排 → 不吵
  const a = await fetchAqiStation();
  if (!a || a.aqi > 50) return null;           // 空氣沒到良好 → 不建議運動
  const phase = periodPhaseToday(await getPeriodStarts());
  if (phase === 'period' || phase === 'premenstrual') {
    return '🧘 今晚就做點輕伸展、放鬆一下就好，不用勉強，早點休息。';
  }
  return '🏃 今晚 18:00–22:00 沒排行程，空氣也不錯，天氣 OK 的話很適合出門走走或慢跑，建議 19:00 前結束，比較好入睡。';
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
      if (res.ok) { console.log('Gemini 使用模型：', model); return res.json(); }
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
const RE_PICKS = /^(選股|多空|選股清單|今日選股|多空觀察)$/;
const RE_SYMPTOM_REPORT = /^(症狀|健康)?月報$|症狀月報|健康月報/;
const RE_SYMPTOM_QUERY = /(症狀|頭痛).*(紀錄|記錄|歷史|清單|列表)/;
const RE_PERIOD_QUERY  = /(下次|下一次|什麼時候|何時|幾天).*(月經|經期|來)|經期預測|^(月經|經期)[?？]?$/;
const RE_PERIOD_START  = /(月經|mc|MC|大姨媽|生理期|好朋友).*(來了|來|報到)|^來了$/;
const RE_SYMPTOM       = /(偏?頭痛|頭很痛|頭好痛|頭在痛|經痛|生理痛|肚子痛|想吐|噁心|反胃|頭暈|不舒服|好痛)/;
function isQuestion(t) { return /[?？]|嗎|怎麼|如何|可不可以|可以.*嗎|該不該|要不要|多少|哪/.test(t); }

// Gemini 解析「改到…」（規則讀不懂時備援）；回 {cancel} 或 {startLocal,endLocal} 或 null
async function parseRescheduleByGemini(userMessage, pending) {
  const today = getTaipeiTodayString();
  const prompt = `使用者原本要記的行程是「${pending.summary}」，原時間 ${pending.startLocal}（台灣時間）。今天是 ${today}。使用者現在說：「${userMessage}」。\n請判斷新的時間，只回 JSON、不要其他文字：{"cancel": false, "newStartTime": "YYYY-MM-DDTHH:mm:ss", "newEndTime": "YYYY-MM-DDTHH:mm:ss"}。沒給結束時間就設開始後 1 小時。如果其實是要取消，cancel=true、時間留空。`;
  try {
    const g = JSON.parse(extractText(await callGemini(
      { contents: [{ parts: [{ text: prompt }] }] },
      { models: ['gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'] }
    )).replace(/```json|```/g, '').trim());
    if (g.cancel) return { cancel: true };
    if (g.newStartTime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(g.newStartTime)) {
      let s = g.newStartTime; if (s.length === 16) s += ':00'; s = s.slice(0, 19);
      let e = (g.newEndTime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(g.newEndTime)) ? g.newEndTime : '';
      if (e.length === 16) e += ':00'; e = e.slice(0, 19);
      if (!e) e = taipeiISOLocal(new Date(toTaipeiDate(s).getTime() + 60 * 60000));
      return { startLocal: s, endLocal: e };
    }
  } catch (err) { console.error('改期解析失敗：', err.message); }
  return null;
}

// 共用：把一筆 pending 以指定時間寫入，撞到就再問、沒撞就記
async function commitOrAsk(replyToken, userMessage, summary, startLocal, endLocal) {
  let warn = '';
  try { warn = await buildConflictWarning(toTaipeiDate(startLocal), toTaipeiDate(endLocal)); }
  catch (e) { console.error('衝突檢查失敗：', e.message); }
  if (warn) {
    await setPending({ summary, startLocal, endLocal });
    return respond(replyToken, userMessage,
      `📌 ${summary}\n⏰ ${String(startLocal).replace('T', ' ')}${warn}\n\n要我怎麼做？回「記」照記、回「改到○月○日○點」改期、回「取消」放棄。`);
  }
  await insertEvent(summary, startLocal, endLocal);
  await setPending(null);
  return respond(replyToken, userMessage,
    `📅 已寫入 Google 日曆！\n\n📌 ${summary}\n⏰ ${String(startLocal).replace('T', ' ')}`);
}

async function handleTextMessage(event) {
  const userMessage = (event.message.text || '').trim();
  const replyToken = event.replyToken;
  console.log('=== 你的 LINE userId 是：', event.source.userId, '===');

  try {
    // ===== 0. 有「待確認行程」時，這句優先當作你的回覆 =====
    const pending = await getPending();
    if (pending) {
      if (RE_DECLINE.test(userMessage)) {
        await setPending(null);
        return respond(replyToken, userMessage, '好，那這筆就不記了 👌');
      }
      if (RE_CONFIRM.test(userMessage)) {
        await insertEvent(pending.summary, pending.startLocal, pending.endLocal);
        await setPending(null);
        return respond(replyToken, userMessage, `📅 好，照原時間記進去了！\n\n📌 ${pending.summary}\n⏰ ${pending.startLocal.replace('T', ' ')}`);
      }
      const resolved = resolveRescheduleLocal(userMessage, pending);
      if (resolved) return commitOrAsk(replyToken, userMessage, pending.summary, resolved.startLocal, resolved.endLocal);
      if (RE_TIMEISH.test(userMessage)) {
        const g = await parseRescheduleByGemini(userMessage, pending);
        if (g && g.cancel) { await setPending(null); return respond(replyToken, userMessage, '好，那這筆就不記了 👌'); }
        if (g && g.startLocal) return commitOrAsk(replyToken, userMessage, pending.summary, g.startLocal, g.endLocal);
        return respond(replyToken, userMessage, '我沒抓到要改到什麼時候，這筆先幫你保留著。你可以回「記」、「取消」，或再講一次新的日期時間。');
      }
      // 看起來是換話題 → 放掉 pending，繼續照一般流程處理
      await setPending(null);
    }

    // ---- 規則快速通道（不花 Gemini 額度）----
    if (RE_PICKS.test(userMessage)) {
      return respond(replyToken, userMessage, (await buildPicksText()) || '目前還沒有選股資料，等 GitHub 每天收盤後跑完才會有喔 📈');
    }
    if (RE_SYMPTOM_REPORT.test(userMessage)) {
      return respond(replyToken, userMessage, await buildSymptomMonthlyReport());
    }
    if (RE_SYMPTOM_QUERY.test(userMessage)) {
      return respond(replyToken, userMessage, await buildSymptomHistoryText());
    }
    if (RE_PERIOD_QUERY.test(userMessage) && !RE_PERIOD_START.test(userMessage)) {
      return respond(replyToken, userMessage, buildPredictionReplyText(await getPeriodStarts()));
    }
    if (RE_PERIOD_START.test(userMessage) && !isQuestion(userMessage)) {
      const d = parseWhen(userMessage);
      const starts = await logPeriodStart(d);
      const periodEnd = addDays(d, PERIOD_LEN_DEFAULT - 1);
      return respond(replyToken, userMessage, `📝 已記錄月經開始：${d}（生理期約 ${d} ~ ${periodEnd}）\n\n${buildPredictionReplyText(starts)}`);
    }
    if (RE_SYMPTOM.test(userMessage) && !isQuestion(userMessage)) {
      const d = parseWhen(userMessage);
      await logSymptom(d, userMessage);
      return respond(replyToken, userMessage, `📝 已記錄：${d}　${userMessage} 🤕\n記得多休息，不舒服就別硬撐。`);
    }

    // ---- 交給 Gemini（帶最近對話；判斷 calendar/刪除/改期/period/symptom/chat）----
    const history = await getChatHistory();
    const todayStr = getTaipeiTodayString();
    const prompt = `你是一個 LINE 個人助理。請判斷使用者訊息屬於哪一類，並依規則給出處理結果。

今天的正確日期是 ${todayStr}（台灣時區）。${historyToPromptText(history)}

請嚴格只回傳以下 JSON（不要 markdown、不要多餘文字）：
{
  "action": "calendar | calendar_delete | calendar_update | period | symptom | chat",
  "summary": "",
  "startTime": "",
  "endTime": "",
  "targetSummary": "",
  "targetDate": "",
  "newStartTime": "",
  "newEndTime": "",
  "periodDate": "",
  "symptomText": "",
  "symptomDate": "",
  "chatReply": ""
}

規則：
1. 新增/記錄行程或請假 → action=calendar；summary=標題；startTime/endTime 用 YYYY-MM-DDTHH:mm:ss（沒給時間預設當天09:00，沒給結束時間設開始後1小時）。
2. 要刪除/取消某個已存在的行程 → action=calendar_delete；targetSummary=行程名稱關鍵字；targetDate=那天 YYYY-MM-DD（講不清楚就留空）。
3. 要把某個已存在的行程改時間/改期 → action=calendar_update；targetSummary=行程名稱關鍵字；targetDate=原本那天 YYYY-MM-DD；newStartTime/newEndTime=新時間 YYYY-MM-DDTHH:mm:ss（沒給結束設開始後1小時）。
4. 「表示月經/生理期來了」（陳述，不是提問）→ action=period；periodDate 填開始日 YYYY-MM-DD（沒指明就今天）。
5. 「描述自己身體不適或症狀」如頭痛、偏頭痛、經痛、想吐等（陳述，不是提問）→ action=symptom；symptomText 簡短描述；symptomDate 用 YYYY-MM-DD（沒指明就今天）。
6. 其他（提問、查資料、聊天）→ action=chat；chatReply 用繁體中文口語簡潔回答，可參考上面最近的對話。需要最新資訊時主動用搜尋工具。

回答聊天時的原則（很重要）：
- 使用者住桃園龜山、上班在林口（華亞科技園區附近）。問「附近」的店、餐廳、地點時，直接用這兩區搜尋，不要反問在哪裡。
- 使用者說「隨便」「你決定」「都可以」「不知道」時，代表要你直接做決定：馬上給 2～3 個具體推薦（店名或品項＋一句理由），不要再反問。
- 最多只能反問一次。上面最近的對話裡你已經問過的問題，絕對不要再問第二次，改成直接給答案。
- 不要重複你上一則講過的話。

使用者訊息："${userMessage}"`;

    const geminiData = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    });
    const parsed = JSON.parse(extractText(geminiData).replace(/```json|```/g, '').trim());

    if (parsed.action === 'calendar') {
      // B1：衝突就先問你再動作（commitOrAsk 內會查衝突）
      return commitOrAsk(replyToken, userMessage, parsed.summary, parsed.startTime, parsed.endTime);
    }

    if (parsed.action === 'calendar_delete') {
      if (!parsed.targetDate) {
        return respond(replyToken, userMessage, '要刪哪一天的行程呢？跟我說日期＋名稱，例如「刪掉 12/28 的家庭聚餐」。');
      }
      const hits = await findEventsByNameDate(parsed.targetSummary, parsed.targetDate);
      if (!hits.length) {
        return respond(replyToken, userMessage, `${parsed.targetDate} 那天沒找到${parsed.targetSummary ? `「${parsed.targetSummary}」` : '有時間的行程'}。`);
      }
      if (hits.length > 1) {
        return respond(replyToken, userMessage, `${parsed.targetDate} 那天有好幾筆，告訴我是哪個時間的：\n${listEventsText(hits)}`);
      }
      await deleteEventById(hits[0].id);
      return respond(replyToken, userMessage, `🗑️ 已刪除：${hits[0].summary}（${parsed.targetDate} ${fmtClock(hits[0].start)}）`);
    }

    if (parsed.action === 'calendar_update') {
      if (!parsed.targetDate || !parsed.newStartTime) {
        return respond(replyToken, userMessage, '要改哪一筆、改到什麼時候呢？例如「把 12/28 的家庭聚餐改到 12/30 晚上7點」。');
      }
      const hits = await findEventsByNameDate(parsed.targetSummary, parsed.targetDate);
      if (!hits.length) {
        return respond(replyToken, userMessage, `${parsed.targetDate} 那天沒找到${parsed.targetSummary ? `「${parsed.targetSummary}」` : '可改的行程'}。`);
      }
      if (hits.length > 1) {
        return respond(replyToken, userMessage, `${parsed.targetDate} 那天有好幾筆，先告訴我是哪個時間的：\n${listEventsText(hits)}`);
      }
      const newEnd = parsed.newEndTime || taipeiISOLocal(new Date(toTaipeiDate(parsed.newStartTime).getTime() + 60 * 60000));
      // 改期前先查新時段（此時原行程還在舊時間，不會查到自己）
      let warn = '';
      try { warn = await buildConflictWarning(toTaipeiDate(parsed.newStartTime), toTaipeiDate(newEnd)); } catch (e) { /* 忽略 */ }
      await patchEventTime(hits[0].id, parsed.newStartTime, newEnd);
      return respond(replyToken, userMessage, `🔁 已改期：${hits[0].summary}\n⏰ ${String(parsed.newStartTime).replace('T', ' ')}${warn ? `${warn}\n（新時間也有安排，自己確認一下）` : ''}`);
    }

    if (parsed.action === 'period') {
      const d = (parsed.periodDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.periodDate)) ? parsed.periodDate : getTaipeiTodayString();
      const starts = await logPeriodStart(d);
      const periodEnd = addDays(d, PERIOD_LEN_DEFAULT - 1);
      return respond(replyToken, userMessage, `📝 已記錄月經開始：${d}（生理期約 ${d} ~ ${periodEnd}）\n\n${buildPredictionReplyText(starts)}`);
    }

    if (parsed.action === 'symptom') {
      const d = (parsed.symptomDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.symptomDate)) ? parsed.symptomDate : getTaipeiTodayString();
      const txt = parsed.symptomText || userMessage;
      await logSymptom(d, txt);
      return respond(replyToken, userMessage, `📝 已記錄：${d}　${txt} 🤕\n記得多休息，不舒服就別硬撐。`);
    }

    return respond(replyToken, userMessage, parsed.chatReply || '嗯...我沒想到要怎麼回答，可以換個方式問我嗎？');

  } catch (error) {
    console.error('詳細錯誤記錄：', error);
    await reply(replyToken, '系統處理時發生錯誤，請再試一次！（若是查詢類問題，也可能是搜尋功能暫時無法使用）');
  }
}

async function reply(replyToken, text) {
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
}
// 回覆並把這一輪存進短期記憶（供下一句理解上下文）
async function respond(replyToken, userMessage, text) {
  await reply(replyToken, text);
  try { await appendChatHistory(userMessage, text); } catch (e) { console.error('存對話失敗：', e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server is running on port ${PORT}`); });
