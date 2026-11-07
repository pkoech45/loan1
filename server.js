require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express(); // Initialize app FIRST

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
    res.sendFile(path.join("index.html"));
});

const {
  MOCKAPI_URL,
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  ADMIN_USER_ID,
  TELEGRAM_WEBHOOK_SECRET
} = process.env;

const APPROVAL_STATUSES = ["pending", "approved", "rejected"];

async function mockApi(method, url, data) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {})
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`MockAPI error ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

async function telegram(method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.description || "Telegram request failed");
  }

  return result.result;
}

function money(value) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

app.get("/", (req, res) => {
  res.sendFile(path.join("public", "index.html"));
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "loan-demo-api" });
});

// Submit a demo application
app.post("/api/submit", async (req, res) => {
  try {
    if (!MOCKAPI_URL || !BOT_TOKEN || !ADMIN_CHAT_ID) {
      return res.status(500).json({
        error: "Server environment variables are incomplete."
      });
    }

    const {
      full_name,
      phone_number,
      loan_amount_bwp,
      period_months,
      monthly_payment_bwp,
      total_repayment_bwp
    } = req.body || {};

    const name = String(full_name || "").trim();
    const phone = String(phone_number || "").trim();
    const amount = Number(loan_amount_bwp);
    const months = Number(period_months);
    const monthly = Number(monthly_payment_bwp);
    const total = Number(total_repayment_bwp);

    if (name.length < 2 || !/^7[0-9]{7}$/.test(phone)) {
      return res.status(400).json({
        error: "Please provide a valid name and phone number."
      });
    }

    if (
      !Number.isFinite(amount) ||
      amount < 100000 ||
      amount > 1000000 ||
      !Number.isInteger(months) ||
      months < 3 ||
      months > 24 ||
      months % 3 !== 0 ||
      !Number.isFinite(monthly) ||
      !Number.isFinite(total)
    ) {
      return res.status(400).json({
        error: "Invalid demo loan details."
      });
    }

    const status_token = crypto.randomBytes(32).toString("hex");

    const record = await mockApi("POST", MOCKAPI_URL, {
      full_name: name,
      phone_number: phone,
      loan_amount_bwp: amount,
      period_months: months,
      monthly_payment_bwp: monthly,
      total_repayment_bwp: total,
      status: "pending",
      status_token,
      created_at: new Date().toISOString()
    });

    const keyboard = {
      inline_keyboard: [[
        {
          text: "Approve",
          callback_data: `loan:approve:${record.id}`
        },
        {
          text: "Reject",
          callback_data: `loan:reject:${record.id}`
        }
      ]]
    };

    const message =
      "📝 DEMO LOAN APPLICATION\n\n" +
      "⚠️ NOT AN OFFICIAL MASCOM SERVICE\n\n" +
      `Name: ${name}\n` +
      `Phone: ${phone}\n` +
      `Amount: BWP ${money(amount)}\n` +
      `Period: ${months} months\n` +
      `Monthly estimate: BWP ${money(monthly)}\n` +
      `Total estimate: BWP ${money(total)}\n\n` +
      "Status: PENDING ADMIN REVIEW";

    const sent = await telegram("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: message,
      reply_markup: keyboard
    });

    await mockApi("PUT", `${MOCKAPI_URL}/${record.id}`, {
      telegram_message_id: sent.message_id,
      telegram_chat_id: String(ADMIN_CHAT_ID)
    });

    res.json({
      ok: true,
      id: String(record.id),
      status_token
    });
  } catch (error) {
    console.error("Submit error:", error);
    res.status(500).json({
      error: "Could not submit the demo application."
    });
  }
});

// Applicant checks the decision
app.get("/api/status", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    const token = String(req.query.token || "");

    if (!id || !token || !MOCKAPI_URL) {
      return res.status(400).json({ error: "Missing status details." });
    }

    const record = await mockApi("GET", `${MOCKAPI_URL}/${encodeURIComponent(id)}`);

    const supplied = Buffer.from(token);
    const stored = Buffer.from(String(record.status_token || ""));

    if (
      supplied.length !== stored.length ||
      !crypto.timingSafeEqual(supplied, stored)
    ) {
      return res.status(403).json({ error: "Invalid status token." });
    }

    res.json({
      status: APPROVAL_STATUSES.includes(record.status)
        ? record.status
        : "pending"
    });
  } catch (error) {
    console.error("Status error:", error);
    res.status(500).json({ error: "Could not check application status." });
  }
});

// Telegram sends button clicks to this endpoint
app.post("/telegram/webhook", async (req, res) => {
  try {
    const suppliedSecret =
      req.headers["x-telegram-bot-api-secret-token"] || "";

    if (
      !TELEGRAM_WEBHOOK_SECRET ||
      suppliedSecret !== TELEGRAM_WEBHOOK_SECRET
    ) {
      return res.sendStatus(401);
    }

    const callback = req.body && req.body.callback_query;

    if (!callback) {
      return res.sendStatus(200);
    }

    const adminId = String(callback.from && callback.from.id || "");

    if (!ADMIN_USER_ID || adminId !== String(ADMIN_USER_ID)) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "You are not authorized to make this decision.",
        show_alert: true
      });
      return res.sendStatus(200);
    }

    const match = /^loan:(approve|reject):([A-Za-z0-9_-]+)$/.exec(
      callback.data || ""
    );

    if (!match) {
      return res.sendStatus(200);
    }

    const decision = match[1] === "approve" ? "approved" : "rejected";
    const id = match[2];

    const record = await mockApi(
      "GET",
      `${MOCKAPI_URL}/${encodeURIComponent(id)}`
    );

    if (record.status !== "pending") {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "This application has already been reviewed."
      });
      return res.sendStatus(200);
    }

    await mockApi("PUT", `${MOCKAPI_URL}/${encodeURIComponent(id)}`, {
      status: decision,
      decision_at: new Date().toISOString(),
      decided_by: adminId
    });

    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Application ${decision}.`
    });

    const originalText =
      callback.message && callback.message.text
        ? callback.message.text
        : "Demo loan application";

    await telegram("editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: originalText + `\n\nADMIN DECISION: ${decision.toUpperCase()}`,
      reply_markup: { inline_keyboard: [] }
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error("Telegram webhook error:", error);
    return res.sendStatus(500);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found", path: req.path });
});
if (require.main === module) {
    const PORT = process.env.PORT || 3000;

    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}
module.exports = app;
