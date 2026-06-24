const express = require('express');
const { middleware, messagingApi } = require('@line/bot-sdk');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

app.get('/', (req, res) => {
  res.send('LINE 行事曆管家（Gemini 免費大腦版）運作中 ✅');
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

async function handleTextMessage(event) {
  const userMessage = event.message.text;
  const replyToken = event.replyToken;

  try {
    // 1. 呼叫 Gemini API 解析訊息（修正：正確的官方端點 + 模型名稱 + ?key= 帶金鑰）
    const secureApiKey = (process.env.GEMINI_API_KEY || '').trim();
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${secureApiKey}`;

    // 修正：拿掉 ${userMessage} 前面多餘的反斜線，否則訊息內容不會真的被代入
    const prompt = `你是一個時間與行程解析助手。請幫我解析使用者傳來的這段 LINE 訊息：\n"${userMessage}"\n\n目前的正確時間是 2026年6月24日。請精確換算出該行程的正確西元年月日與具體時間（24小時制，如果沒給具體時間則預設為上午09:00）。請嚴格遵循以下 JSON 格式回覆，不要包含任何 markdown 標籤（如 \`\`\`json）：\n{\n  "summary": "行程的標題",\n  "startTime": "YYYY-MM-DDTHH:mm:ss",\n  "endTime": "YYYY-MM-DDTHH:mm:ss（請自動設為開始時間的一小時後）"\n}`;

    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      throw new Error(`Gemini API 回傳錯誤: ${geminiResponse.status} - ${errorText}`);
    }

    const geminiData = await geminiResponse.json();

    // 安全防護：確保 API 回傳結構完整
    if (!geminiData.candidates || !geminiData.candidates[0] || !geminiData.candidates[0].content || !geminiData.candidates[0].content.parts || !geminiData.candidates[0].content.parts[0]) {
      throw new Error("Gemini API 未回傳有效的文字內容：" + JSON.stringify(geminiData));
    }

    const aiText = geminiData.candidates[0].content.parts[0].text.trim();

    // 強制移除 AI 有時會自動加上的 ```json 標籤
    const cleanJsonText = aiText.replace(/```json|```/g, '').trim();
    const parsedEvent = JSON.parse(cleanJsonText);

    // 2. 呼叫 Google Calendar API 寫入日曆（修正：scopes 要用正確的 Calendar 授權範圍網址）
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
        summary: parsedEvent.summary,
        start: { dateTime: parsedEvent.startTime, timeZone: 'Asia/Taipei' },
        end: { dateTime: parsedEvent.endTime, timeZone: 'Asia/Taipei' },
      },
    });

    // 3. 回覆 LINE 成功訊息
    await client.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text: `📅 報告！已成功為您寫入 Google 日曆囉！\n\n📌 項目：${parsedEvent.summary}\n⏰ 時間：${parsedEvent.startTime.replace('T', ' ')}` }]
    });

  } catch (error) {
    console.error("詳細錯誤記錄：", error);
    await client.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text: `系統解析或寫入日曆時發生錯誤，請再試一次！` }]
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
