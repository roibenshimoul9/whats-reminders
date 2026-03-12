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

const REMINDERS_FILE = path.join(__dirname, "reminders.json");
const USERS_FILE = path.join(__dirname, "users.json");

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

function readJson(filePath, defaultValue) {
  try {
    ensureFile(filePath, defaultValue);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed reading ${filePath}:`, err.message);
    return defaultValue;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function loadUsers() {
  return readJson(USERS_FILE, []);
}

function saveUsers(users) {
  writeJson(USERS_FILE, users);
}

function loadReminders() {
  return readJson(REMINDERS_FILE, []);
}

function saveReminders(reminders) {
  writeJson(REMINDERS_FILE, reminders);
}

function pad(num) {
  return String(num).padStart(2, "0");
}

function formatDate(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function createTwimlMessage(message) {
  const safe = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function normalizeText(text) {
  return String(text)
    .replace(/״/g, '"')
    .replace(/׳/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getUserByPhone(phone) {
  const users = loadUsers();
  return users.find((user) => user.phone === phone);
}

function parseRegistrationMessage(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return null;
  if (normalizeText(lines[0]) !== "הרשמה") return null;

  const nameLine = lines.find((line) => line.startsWith("שם:"));
  const keywordsLine = lines.find((line) => line.startsWith("מילים:"));

  if (!nameLine || !keywordsLine) return { error: "missing_fields" };

  const name = nameLine.replace("שם:", "").trim();
  const keywords = keywordsLine
    .replace("מילים:", "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  if (!name || !keywords.length) return { error: "invalid_fields" };

  return { name, keywords };
}

function parseUpdateMessage(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return null;
  if (normalizeText(lines[0]) !== "עדכון") return null;

  const keywordsLine = lines.find((line) => line.startsWith("מילים:"));
  if (!keywordsLine) return { error: "missing_keywords" };

  const keywords = keywordsLine
    .replace("מילים:", "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  if (!keywords.length) return { error: "invalid_keywords" };

  return { keywords };
}

function lineBelongsToUser(line, user) {
  if (!user || !user.keywords || !user.keywords.length) return false;

  const normalizedLine = normalizeText(line);
  return user.keywords.some((keyword) => normalizedLine.includes(normalizeText(keyword)));
}

function parseScheduleMessage(text, user) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  const header = normalizeText(lines[0]);
  const isTomorrow = header.includes("למחר");
  const isSchedule = header.includes("לוז");

  if (!isSchedule) return null;

  const now = new Date();
  const baseDate = new Date(now);
  baseDate.setSeconds(0, 0);
  baseDate.setMilliseconds(0);

  if (isTomorrow) {
    baseDate.setDate(baseDate.getDate() + 1);
  }

  const relevantItems = [];

  for (const line of lines.slice(1)) {
    const match = line.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+(.+)$/);
    if (!match) continue;
    if (!lineBelongsToUser(line, user)) continue;

    const startHour = parseInt(match[1], 10);
    const startMinute = parseInt(match[2], 10);
    const title = match[5].trim();

    const eventTime = new Date(baseDate);
    eventTime.setHours(startHour, startMinute, 0, 0);

    if (!isTomorrow && eventTime <= now) {
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

  return relevantItems.length ? relevantItems : [];
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

function buildProfileMessage(user) {
  return `הפרופיל שלך ✅
שם: ${user.name}
מספר: ${user.phone}
מילים: ${user.keywords.join(", ")}`;
}

app.get("/", (req, res) => {
  res.send("WhatsApp reminder bot is running");
});

app.post("/whatsapp", async (req, res) => {
  try {
    const incoming = (req.body.Body || "").trim();
    const from = req.body.From;

    if (!incoming) {
      res.set("Content-Type", "text/xml");
      return res.send(createTwimlMessage("לא התקבלה הודעה."));
    }

    // הרשמה
    const registration = parseRegistrationMessage(incoming);
    if (registration) {
      if (registration.error) {
        res.set("Content-Type", "text/xml");
        return res.send(
          createTwimlMessage(
            'פורמט הרשמה לא תקין.\nשלח כך:\nהרשמה\nשם: רועי\nמילים: רועי, רועי בן שימול, רמדים, רמ"דים'
          )
        );
      }

      const users = loadUsers();
      const existingIndex = users.findIndex((user) => user.phone === from);

      const newUser = {
        phone: from,
        name: registration.name,
        keywords: registration.keywords
      };

      if (existingIndex >= 0) {
        users[existingIndex] = newUser;
      } else {
        users.push(newUser);
      }

      saveUsers(users);

      res.set("Content-Type", "text/xml");
      return res.send(
        createTwimlMessage(
          `נרשמת בהצלחה ✅\nשם: ${newUser.name}\nמילים: ${newUser.keywords.join(", ")}`
        )
      );
    }

    // עדכון
    const update = parseUpdateMessage(incoming);
    if (update) {
      if (update.error) {
        res.set("Content-Type", "text/xml");
        return res.send(
          createTwimlMessage('פורמט עדכון לא תקין.\nשלח כך:\nעדכון\nמילים: רועי, רמדים, רמ"דים')
        );
      }

      const users = loadUsers();
      const index = users.findIndex((user) => user.phone === from);

      if (index === -1) {
        res.set("Content-Type", "text/xml");
        return res.send(createTwimlMessage("אתה עדיין לא רשום. שלח קודם הודעת הרשמה."));
      }

      users[index].keywords = update.keywords;
      saveUsers(users);

      res.set("Content-Type", "text/xml");
      return res.send(createTwimlMessage(`עודכן בהצלחה ✅\nמילים: ${update.keywords.join(", ")}`));
    }

    // פרופיל
    if (normalizeText(incoming) === "הפרופיל שלי") {
      const user = getUserByPhone(from);

      res.set("Content-Type", "text/xml");
      if (!user) {
        return res.send(createTwimlMessage("אתה עדיין לא רשום. שלח קודם הודעת הרשמה."));
      }

      return res.send(createTwimlMessage(buildProfileMessage(user)));
    }

    const user = getUserByPhone(from);

    if (!user) {
      res.set("Content-Type", "text/xml");
      return res.send(
        createTwimlMessage(
          'כדי להתחיל צריך להירשם.\nשלח כך:\nהרשמה\nשם: רועי\nמילים: רועי, רועי בן שימול, רמדים, רמ"דים'
        )
      );
    }

    // לו"ז
    const scheduleItems = parseScheduleMessage(incoming, user);
    if (scheduleItems !== null) {
      if (!scheduleItems.length) {
        res.set("Content-Type", "text/xml");
        return res.send(createTwimlMessage("לא מצאתי בלו״ז שורות שמתאימות למילים שלך."));
      }

      const now = new Date();
      const reminders = loadReminders();
      const addedItems = [];

      for (const item of scheduleItems) {
        if (item.reminderTime <= now) continue;

        reminders.push({
          id: item.id,
          to: from,
          userName: user.name,
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
        createTwimlMessage(
          `מצאתי ${addedItems.length} לוזים שלך ✅\n\n${summary}\n\nאזכיר לך 5 דקות לפני כל אחד.`
        )
      );
    }

    // תזכורת בודדת
    const parsed = parseSingleReminder(incoming);
    if (!parsed) {
      res.set("Content-Type", "text/xml");
      return res.send(
        createTwimlMessage(
          'לא הבנתי 😅\nאפשר לשלוח:\nדיון 14:00\nדיון מחר 10:30\nפגישה עוד שעה\nאו להדביק לו״ז מלא אחרי שנרשמת.'
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

    const reminders = loadReminders();
    reminders.push({
      id: Date.now().toString(),
      to: from,
      userName: user.name,
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

      if (now >= reminderTime && now - reminderTime < 10 * 60 * 1000) {
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
