const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

app.post("/whatsapp", async (req, res) => {

    const incoming = req.body.Body;
    const from = req.body.From;

    const match = incoming.match(/(\d{1,2}):(\d{2})/);

    if (!match) {
        res.send(`<Response><Message>שלח זמן כמו: דיון 14:00</Message></Response>`);
        return;
    }

    let hour = parseInt(match[1]);
    let minute = parseInt(match[2]);

    minute -= 5;
    if (minute < 0) {
        minute += 60;
        hour -= 1;
    }

    const now = new Date();
    const reminderTime = new Date();

    reminderTime.setHours(hour);
    reminderTime.setMinutes(minute);
    reminderTime.setSeconds(0);

    const delay = reminderTime - now;

    setTimeout(async () => {

        await client.messages.create({
            from: "whatsapp:+14155238886",
            to: from,
            body: "תזכורת: הדיון שלך עוד 5 דקות"
        });

    }, delay);

    res.send(`<Response><Message>סבבה, אזכיר לך ב ${hour}:${minute}</Message></Response>`);
});

app.listen(3000, () => console.log("Bot running"));
