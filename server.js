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

function parseReminder(text) {
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

    const parsed = parseReminder(incoming);

    if (!parsed) {
      res.set("Content-Type", "text/xml");
      return res.send(
        createTwimlMessage(
          "לא הבנתי 😅\nשלח למשל:\nדיון 14:00\nדיון מחר 10:30\nפגישה עוד שעה\nפגישה עוד 2 שעות\nטיפול רכב 12/4 09:00"
        )
      );
    }

    const { eventText, eventTime } = parsed;
    const reminderTime = new Date(eventTime.getTime() - 5 * 60 * 1000);
    const now = new Date();

    if (reminderTime <= now) {
      res.set("Content-Type", "text/xml");
      return res.send(
        createTwimlMessage("הזמן קרוב מדי או כבר עבר. תשלח זמן רחוק ביותר מ-5 דקות.")
      );
    }

    const reminders = loadReminders();

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
