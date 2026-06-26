const express = require('express');
const { middleware, messagingApi } = require('@line/bot-sdk');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');

const app = express();
// 注意：不能用 app.use(express.json()) 套用到全部路由，
// 否則會搶先解析掉 LINE webhook 需要的原始內容，導致簽章驗證失敗。
// 改成只在需要 JSON 的路由上個別套用（見下方 /api/location-update）。

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

app.get('/', (req, res) => {
  res.send('LINE 行事曆管家（Gemini + 連網搜尋 + 定位天氣版）運作中 ✅');
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

// ===== Upstash Redis 簡易存取（用來存「最新一次手機回傳的座標」）=====

async function upstashSet(key, value) {
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(value)
  });
  if (!res.ok) throw new Error('寫入 Upstash 失敗: ' + (await res.text()));
  return res.json();
}

async function upstashGet(key) {
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  });
  if (!res.ok) throw new Error('讀取 Upstash 失敗: ' + (await res.text()));
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

// ===== 手機捷徑會打這個網址，把目前 GPS 座標送進來存起來 =====
app.post('/api/location-update', express.json(), async (req, res) => {
  const secret = req.headers['x-location-secret'] || req.query.secret;
  if (!process.env.LOCATION_SECRET || secret !== process.env.LOCATION_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const { lat, lon, latitude, longitude } = req.body;
  const finalLat = lat !== undefined ? lat : latitude;
  const finalLon = lon !== undefined ? lon : longitude;

  if (finalLat === undefined || finalLon === undefined) {
    return res.status(400).send('缺少座標資料（需要 lat/lon 或 latitude/longitude）');
  }

  try {
    await upstashSet('latest_location', { latitude: finalLat, longitude: finalLon, updatedAt: new Date().toISOString() });
    res.status(200).send('座標已收到並存好囉');
  } catch (err) {
    console.error('儲存座標時發生錯誤：', err);
    res.status(500).send('儲存失敗');
  }
});

// ===== 定時提醒功能 =====

// Cron 排程會打這個網址，目前只用來推送「定位天氣」
app.get('/api/remind', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return res.status(401).send('Unauthorized');
  }

  const type = req.query.type;

  try {
    if (type === 'weather') {
      await pushLocationWeather();
      return res.status(200).send('已推送定位天氣');
    }
    res.status(400).send(`未知的提醒類型: ${type}`);
  } catch (err) {
    console.error('推播提醒時發生錯誤：', err);
    res.status(500).send('推播失敗');
  }
});

async function pushLocationWeather() {
  const location = await upstashGet('latest_location');

  let text;
  if (!location) {
    text = '🌅 早安！不過我還沒收到你手機回傳的位置資料，沒辦法幫你查當地天氣，麻煩確認一下手機捷徑有沒有正常執行喔。';
  } else {
    const todayStr = getTaipeiTodayString();
    const prompt = `今天日期是 ${todayStr}（台灣時區）。使用者目前的座標是：緯度 ${location.latitude}, 經度 ${location.longitude}。\n\n請先利用搜尋判斷這個座標大致位於哪個城市/行政區，然後查詢該地點今天的天氣預報，用繁體中文簡潔地回覆，內容包含：\n1. 所在地點（city/區）\n2. 目前天氣狀況與溫度\n3. 是否會下雨、降雨機率\n4. 需要注意的事項（例如要不要帶傘、防曬、保暖等實用建議）\n\n請用口語、像在跟朋友說話的語氣，不要太長，整段控制在 100 字以內。開頭請用「🌅 早安！」。`;

    const geminiData = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    });
    text = extractText(geminiData);
  }

  await client.pushMessage({
    to: process.env.LINE_USER_ID,
    messages: [{ type: 'text', text }],
  });
}

// 取得台灣時區的今天日期字串 YYYY-MM-DD（自動抓系統當天）
function getTaipeiTodayString() {
  const now = new Date();
  const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = taipeiNow.getFullYear();
  const m = String(taipeiNow.getMonth() + 1).padStart(2, '0');
  const d = String(taipeiNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 通用的 Gemini API 呼叫函式（共用：可選擇要不要帶 tools）
async function callGemini(body, retries = 2) {
  const secureApiKey = (process.env.GEMINI_API_KEY || '').trim();
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${secureApiKey}`;
  const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.ok) return res.json();

    const errorText = await res.text();
    const isRetryable = res.status === 503 && attempt < retries;
    if (!isRetryable) {
      throw new Error(`Gemini API 回傳錯誤: ${res.status} - ${errorText}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
}

function extractText(geminiData) {
  if (!geminiData.candidates || !geminiData.candidates[0] || !geminiData.candidates[0].content || !geminiData.candidates[0].content.parts || !geminiData.candidates[0].content.parts[0]) {
    throw new Error("Gemini API 未回傳有效的文字內容：" + JSON.stringify(geminiData));
  }
  return geminiData.candidates[0].content.parts[0].text.trim();
}

// 合併版：一次呼叫 Gemini，同時判斷意圖「並」給出處理結果（行程資料 或 聊天回覆）
async function handleTextMessage(event) {
  const userMessage = event.message.text;
  const replyToken = event.replyToken;

  // 偵測用：把使用者的 LINE userId 印到 log，方便你去 Vercel Logs 複製
  console.log('=== 你的 LINE userId 是：', event.source.userId, '===');

  try {
    const todayStr = getTaipeiTodayString();

    const prompt = `你是一個 LINE 機器人助理，請判斷使用者這句訊息屬於哪一種類型，並依規則直接給出處理結果。

今天的正確日期是 ${todayStr}（台灣時區）。

請嚴格遵循以下 JSON 格式回覆，不要包含任何 markdown 標籤（如 \`\`\`json），也不要有其他文字：
{
  "action": "calendar 或 chat",
  "summary": "（action 為 calendar 時填寫：行程標題；其他情況留空字串）",
  "startTime": "（action 為 calendar 時填寫：YYYY-MM-DDTHH:mm:ss；其他情況留空字串）",
  "endTime": "（action 為 calendar 時填寫：YYYY-MM-DDTHH:mm:ss；其他情況留空字串）",
  "chatReply": "（action 為 chat 時填寫：用繁體中文口語、簡潔地回答使用者的問題；其他情況留空字串）"
}

判斷規則：
1. 如果使用者是要「新增/記錄一個行程或請假」，action 設為 calendar，並解析出：
   - summary：行程標題
   - startTime：精確換算成西元年月日與24小時制時間（沒給具體時間預設為當天09:00）
   - endTime：如果使用者明確提到結束時間或時段（例如「3點到5點」），直接使用；如果完全沒提到，則自動設為開始時間的一小時後
2. 其他所有情況（問問題、查天氣、查旅遊資訊、查評價、聊天等），action 設為 chat，並在 chatReply 填入完整回答。如果問題需要最新資訊（例如天氣、新聞、評價、營業時間等），請主動使用搜尋工具查詢後再回答。

使用者訊息："${userMessage}"`;

    const geminiData = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    });

    const aiText = extractText(geminiData);
    const cleanJsonText = aiText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJsonText);

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

      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `📅 報告！已成功為您寫入 Google 日曆囉！\n\n📌 項目：${parsed.summary}\n⏰ 時間：${parsed.startTime.replace('T', ' ')}` }]
      });
    } else {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: parsed.chatReply || '嗯...我沒有想到要怎麼回答，可以換個方式問我嗎？' }]
      });
    }

  } catch (error) {
    console.error("詳細錯誤記錄：", error);
    await client.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text: `系統處理時發生錯誤，請再試一次！（如果是查詢類問題，也可能是搜尋功能暫時無法使用）` }]
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
