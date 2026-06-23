require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { google } = require('googleapis');

const app = express();

// ===== LINE 設定 =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// ===== Google Calendar 設定（使用 Service Account）=====
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    // Railway 環境變數中的換行會被存成 \n 字串，這裡轉回真正的換行字元
    private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

/**
 * 呼叫 Claude API，把使用者輸入的自然語言解析成結構化行程資料
 */
async function parseEventWithClaude(userText) {
  const taipeiNow = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })
  );
  const todayStr = taipeiNow.toISOString().split('T')[0];

  const systemPrompt = `你是一個行程解析助理。今天日期是 ${todayStr}（台灣時區，格式 YYYY-MM-DD）。
請把使用者輸入的請假或行程文字，解析成下列 JSON 格式，且只回傳 JSON 本身，不要有任何其他文字、不要加 markdown 的 \`\`\` 區塊：

{
  "title": "事件標題",
  "date": "YYYY-MM-DD",
  "start_time": "HH:mm",
  "end_time": "HH:mm",
  "type": "工作行程 或 請假 或 會議 或 其他",
  "all_day": false
}

規則：
1. 若使用者沒有明確說結束時間，預設為開始時間加 1 小時。
2. 若是請假且沒有指定時段，all_day 設為 true，start_time 用 "09:00"、end_time 用 "18:00"。
3. 日期一定要換算成實際日期（例如「明天」「下週一」要依今天日期推算，輸出實際的 YYYY-MM-DD）。
4. type 請依語意判斷最貼近的分類。
5. 無法判斷的欄位也要給出合理預設值，絕對不要省略欄位。`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
  });

  const data = await response.json();

  if (!data.content || !Array.isArray(data.content)) {
    throw new Error('Claude API 回應格式異常: ' + JSON.stringify(data));
  }

  const rawText = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

  return JSON.parse(cleaned);
}

/**
 * 把解析後的資料寫入 Google Calendar
 */
async function createCalendarEvent(eventData) {
  const { title, date, start_time, end_time, all_day } = eventData;

  let eventBody;
  if (all_day) {
    eventBody = {
      summary: title,
      start: { date, timeZone: 'Asia/Taipei' },
      end: { date, timeZone: 'Asia/Taipei' },
    };
  } else {
    eventBody = {
      summary: title,
      start: { dateTime: `${date}T${start_time}:00`, timeZone: 'Asia/Taipei' },
      end: { dateTime: `${date}T${end_time}:00`, timeZone: 'Asia/Taipei' },
    };
  }

  const result = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: eventBody,
  });

  return result.data;
}

// ===== LINE Webhook =====
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  // 先回 200，避免 LINE 因為等待太久而判定逾時
  res.status(200).end();

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userText = event.message.text;
    const replyToken = event.replyToken;

    try {
      const eventData = await parseEventWithClaude(userText);
      await createCalendarEvent(eventData);

      const confirmMsg = eventData.all_day
        ? `✅ 已新增行程\n標題：${eventData.title}\n日期：${eventData.date}\n類型：${eventData.type}（全天）`
        : `✅ 已新增行程\n標題：${eventData.title}\n日期：${eventData.date}\n時間：${eventData.start_time} - ${eventData.end_time}\n類型：${eventData.type}`;

      await lineClient.replyMessage(replyToken, {
        type: 'text',
        text: confirmMsg,
      });
    } catch (err) {
      console.error('處理訊息發生錯誤:', err);
      try {
        await lineClient.replyMessage(replyToken, {
          type: 'text',
          text: '⚠️ 抱歉，我沒有成功解析或建立這個行程，可以再說一次清楚一點嗎？（例如：7/10 我要請假，工作行程）',
        });
      } catch (replyErr) {
        console.error('回覆 LINE 訊息也失敗了:', replyErr);
      }
    }
  }
});

// 健康檢查路由，方便確認服務是否啟動成功
app.get('/', (req, res) => {
  res.send('LINE 行事曆管家運作中 ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`伺服器已啟動，監聽埠號 ${PORT}`);
});
