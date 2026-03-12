const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

const PORT = process.env.PORT || 3000;
const FROM_NUMBER = "whatsapp:+14155238886";
const FILE_PATH = path.join(__dirname, "reminders.json");

const MY_KEYWORDS = ["רמדים", 'רמ"דים', "רמ״דים", "רועי"];

function pad(num) {
  return String(num).padStart(2, "0");
}

function formatDate(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function createTwimlMessage(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`;
}

function loadReminders() {
  try {
    if (!fs.existsSync(FILE_PATH)) {
      fs.writeFileSync(FILE_PATH, "[]");
    }
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  } catch (err) {
    console.error("Failed to load reminders:", err.message);
    return [];
  }
}

function saveReminders(reminders) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(reminders, null, 2), "utf8");
}

function lineBelongsToMe(line) {
  const normalized = line.toLowerCase();
  return MY_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function parseScheduleMessage(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  const firstLine = lines[0];
  const now = new Date();

  let baseDate = new Date(now);
  baseDate.setSeconds(0, 0);

  // אם כתוב "לוז למחר"
  if (firstLine.includes("למחר")) {
    baseDate.setDate(baseDate.getDate() + 1);
  }

  const relevantItems = [];

  for (const line of lines.slice(1)) {
    const match = line.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+(.+)$/);
    if (!match) continue;

    if (!lineBelongsToMe(line)) continue;

    const startHour = parseInt(match[1], 10);
    const startMinute = parseInt(match[2], 10);
    const title = match[5].trim();

    const eventTime = new Date(baseDate);
    eventTime.setHours(startHour, startMinute, 0, 0);

    if (!firstLine.includes("למחר") && eventTime <= now) {
      eventTime.setDate(eventTime.getDate() + 1);
    }

    const reminderTime = new Date(eventTime.getTime() - 5 * 60 * 1000);

    relevantItems.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      eventText: title,
      eventTime,
      reminderTime
    });
  }

  return relevantItems.length ? relevantItems : null;
}

function parseSingleReminder(text) {
  const input = text.trim();
  const now = new Date();
  let eventText = input;

  if (/עוד שעה/.test(input)) {
    const eventTime = new Date(now.getTime() + 60 * 60 * 1000);
    eventText = input.replace(/עוד שעה/g, "").trim() || "תזכורת";
    return { eventText, eventTime };
  }

  const hoursLaterMatch = input.match(/עוד\s+(\d+)\s+שעות?/);
  if (hoursLaterMatch) {
    const hours = parseInt(hoursLaterMatch[1], 10);
    const eventTime = new Date(now.getTime() + hours * 60 * 60 * 1000);
    eventText = input.replace(/עוד\s+\d+\s+שעות?/g, "").trim() || "תזכורת";
    return { eventText, eventTime };
  }

  const tomorrowMatch = input.match(/^(.*)\s+מחר\s+(\d{1,2}):(\d{2})$/);
  if (tomorrowMatch) {
    eventText = tomorrowMatch[1].trim() || "תזכורת";
    const hour = parseInt(tomorrowMatch[2], 10);
    const minute = parseInt(tomorrowMatch[3], 10);

    const eventTime = new Date(now);
    eventTime.setDate(eventTime.getDate() + 1);
    eventTime.setHours(hour, minute, 0, 0);

    return { eventText, eventTime };
  }

  const fullDateMatch = input.match(/^(.*)\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (fullDateMatch) {
    eventText = fullDateMatch[1].trim() || "תזכורת";
    const day = parseInt(fullDateMatch[2], 10);
    const month = parseInt(fullDateMatch[3], 10) - 1;
    const hour = parseInt(fullDateMatch[4], 10);
    const minute = parseInt(fullDateMatch[5], 10);

    let year = now.getFullYear();
    let eventTime = new Date(year, month, day, hour, minute, 0, 0);

    if (eventTime <= now) {
      year += 1;
      eventTime = new Date(year, month, day, hour, minute, 0, 0);
    }

    return { eventText, eventTime };
  }

  const todayTimeMatch = input.match(/^(.*)\s+(\d{1,2}):(\d{2})$/);
  if (todayTimeMatch) {
    eventText = todayTimeMatch[1].trim() || "תזכורת";
    const hour = parseInt(todayTimeMatch[2], 10);
    const minute = parseInt(todayTimeMatch[3], 10);

    const eventTime = new Date(now);
    eventTime.setHours(hour, minute, 0, 0);

    if (eventTime <= now) {
      eventTime.setDate(eventTime.getDate() + 1);
    }

    return { eventText, eventTime };
  }

  return null;
}

app.get("/", (req, res) => {
  res.send("WhatsApp reminder bot is running");
});

app.post("/whatsapp", async (req, res) => {
  try {
    const incoming = (req.body.Body || "").trim();
    const from = req.body.From;
    const reminders = loadReminders();

    // קודם בודקים אם זו הודעת לו"ז מרובת שורות
    const scheduleItems = parseScheduleMessage(incoming);

    if (scheduleItems) {
      const now = new Date();
      const addedItems = [];

      for (const item of scheduleItems) {
        if (item.reminderTime <= now) continue;

        reminders.push({
          id: item.id,
          to: from,
          eventText: item.eventText,
          eventTime: item.eventTime.toISOString(),
          reminderTime: item.reminderTime.toISOString(),
          sent: false
        });

        addedItems.push(item);
      }

      saveReminders(reminders);

      if (!addedItems.length) {
        res.set("Content-Type", "text/xml");
        return res.send(createTwimlMessage("מצאתי את הלוזים שלך, אבל כולם כבר עברו או קרובים מדי."));
      }

      const summary = addedItems
        .map((item, index) => `${index + 1}. ${formatDate(item.eventTime)} - ${item.eventText}`)
        .join("\n");

      res.set("Content-Type", "text/xml");
      return res.send(
        createTwimlMessage(`מצאתי ${addedItems.length} לוזים שלך ✅\n\n${summary}\n\nאזכיר לך 5 דקות לפני כל אחד.`)
      );
    }

    // אם זו לא הודעת לו"ז, מתייחסים לזה כתזכורת בודדת
    const parsed = parseSingleReminder(incoming);

    if (!parsed) {
      res.set("Content-Type", "text/xml");
      return res.send(
        createTwimlMessage(
          "לא הבנתי 😅\nאפשר לשלוח:\nדיון 14:00\nדיון מחר 10:30\nפגישה עוד שעה\nאו פשוט להדביק לו״ז מלא, ואני אקח רק שורות של רמדים / רמ״דים / רועי."
        )
      );
    }

    const { eventText, eventTime } = parsed;
    const reminderTime = new Date(eventTime.getTime() - 5 * 60 * 1000);
    const now = new Date();

    if (reminderTime <= now) {
      res.set("Content-Type", "text/xml");
      return res.send(createTwimlMessage("הזמן קרוב מדי או כבר עבר. תשלח זמן רחוק ביותר מ-5 דקות."));
    }

    reminders.push({
      id: Date.now().toString(),
      to: from,
      eventText,
      eventTime: eventTime.toISOString(),
      reminderTime: reminderTime.toISOString(),
      sent: false
    });

    saveReminders(reminders);

    res.set("Content-Type", "text/xml");
    return res.send(
      createTwimlMessage(
        `קבעתי ✅\n${eventText}\nזמן אירוע: ${formatDate(eventTime)}\nאזכיר לך ב: ${formatDate(reminderTime)}`
      )
    );
  } catch (err) {
    console.error("Webhook error:", err);
    res.set("Content-Type", "text/xml");
    return res.send(createTwimlMessage("הייתה שגיאה, נסה שוב."));
  }
});

setInterval(async () => {
  try {
    const reminders = loadReminders();
    const now = new Date();
    let changed = false;

    for (const reminder of reminders) {
      if (reminder.sent) continue;

      const reminderTime = new Date(reminder.reminderTime);

      if (now >= reminderTime) {
        try {
          await client.messages.create({
            from: FROM_NUMBER,
            to: reminder.to,
            body: `תזכורת: ${reminder.eventText} בעוד 5 דקות`
          });

          reminder.sent = true;
          changed = true;
          console.log(`Reminder sent to ${reminder.to}`);
        } catch (err) {
          console.error("Failed to send reminder:", err.message);
        }
      }
    }

    if (changed) {
      saveReminders(reminders);
    }
  } catch (err) {
    console.error("Interval error:", err.message);
  }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
