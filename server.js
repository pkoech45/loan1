
require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();

// --------------------------------------------------
// 1. MIDDLEWARE
// --------------------------------------------------

app.use(express.json({ limit: "100kb" }));

app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// 2. ENVIRONMENT VARIABLES
// --------------------------------------------------

const {
  MOCKAPI_URL,
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  ADMIN_USER_ID,
  TELEGRAM_WEBHOOK_SECRET
} = process.env;

const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected"
];

// --------------------------------------------------
// 3. HOMEPAGE
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------------------------------------
// 4. HEALTH CHECK
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "loan-demo-api"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "loan-demo-api"
  });
});

// --------------------------------------------------
// 5. MOCKAPI HELPER
// --------------------------------------------------

async function mockApi(method, url, data) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json"
    },
    ...(data ? {
      body: JSON.stringify(data)
    } : {})
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `MockAPI error ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : {};
}

// --------------------------------------------------
// 6. TELEGRAM HELPER
// --------------------------------------------------

async function telegram(method, data) {
  if (!BOT_TOKEN) {
    throw new Error("Telegram bot token is missing.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || "Telegram request failed."
    );
  }

  return result.result;
}

// --------------------------------------------------
// 7. MONEY FORMATTER
// --------------------------------------------------

function money(value) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// --------------------------------------------------
// 8. SUBMIT DEMO LOAN APPLICATION
// --------------------------------------------------

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

    // Validate applicant details

    if (
      name.length < 2 ||
      !/^7[0-9]{7}$/.test(phone)
    ) {
      return res.status(400).json({
        error: "Please provide a valid name and phone number."
      });
    }

    // Validate demo loan details

    if (
      !Number.isFinite(amount) ||
      amount < 100000 ||
      amount > 1000000 ||
      !Number.isInteger(months) ||
      months < 3 ||
      months > 24 ||
      months % 3 !== 0 ||
      !Number.isFinite(monthly) ||
      !Number.isFinite(total) ||
      monthly <= 0 ||
      total <= 0
    ) {
      return res.status(400).json({
        error: "Invalid demo loan details."
      });
    }

    // Generate private status token

    const status_token = crypto
      .randomBytes(32)
      .toString("hex");

    // Save application to MockAPI

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

    if (!record.id) {
      throw new Error("MockAPI did not return an application ID.");
    }

    // Telegram approval buttons

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

    // Telegram notification

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

    // Save Telegram message information

    await mockApi(
      "PUT",
      `${MOCKAPI_URL}/${encodeURIComponent(record.id)}`,
      {
        telegram_message_id: sent.message_id,
        telegram_chat_id: String(ADMIN_CHAT_ID)
      }
    );

    // Return application details to HTML

    return res.json({
      ok: true,
      id: String(record.id),
      status_token
    });

  } catch (error) {
    console.error("Submit error:", error);

    return res.status(500).json({
      error: "Could not submit the demo application."
    });
  }
});

// --------------------------------------------------
// 9. APPLICANT STATUS CHECK
// --------------------------------------------------

app.get("/api/status", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    const token = String(req.query.token || "");

    if (!id || !token || !MOCKAPI_URL) {
      return res.status(400).json({
        error: "Missing status details."
      });
    }

    const record = await mockApi(
      "GET",
      `${MOCKAPI_URL}/${encodeURIComponent(id)}`
    );

    const supplied = Buffer.from(token);
    const stored = Buffer.from(
      String(record.status_token || "")
    );

    if (
      supplied.length !== stored.length ||
      !crypto.timingSafeEqual(supplied, stored)
    ) {
      return res.status(403).json({
        error: "Invalid status token."
      });
    }

    return res.json({
      status: APPROVAL_STATUSES.includes(record.status)
        ? record.status
        : "pending"
    });

  } catch (error) {
    console.error("Status error:", error);

    return res.status(500).json({
      error: "Could not check application status."
    });
  }
});

// --------------------------------------------------
// 10. TELEGRAM WEBHOOK
// --------------------------------------------------

app.post("/telegram/webhook", async (req, res) => {
  try {
    const suppliedSecret =
      req.headers["x-telegram-bot-api-secret-token"] || "";

    // Verify Telegram webhook secret

    if (
      !TELEGRAM_WEBHOOK_SECRET ||
      suppliedSecret !== TELEGRAM_WEBHOOK_SECRET
    ) {
      return res.sendStatus(401);
    }

    const callback =
      req.body && req.body.callback_query;

    if (!callback) {
      return res.sendStatus(200);
    }

    // Verify administrator

    const adminId = String(
      callback.from && callback.from.id || ""
    );

    if (!ADMIN_USER_ID || adminId !== String(ADMIN_USER_ID)) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "You are not authorized to make this decision.",
        show_alert: true
      });

      return res.sendStatus(200);
    }

    // Read approval or rejection action

    const match = /^loan:(approve|reject):([A-Za-z0-9_-]+)$/.exec(
      callback.data || ""
    );

    if (!match) {
      return res.sendStatus(200);
    }

    const decision =
      match[1] === "approve" ? "approved" : "rejected";

    const id = match[2];

    if (!MOCKAPI_URL) {
      throw new Error("MockAPI URL is missing.");
    }

    // Retrieve application

    const record = await mockApi(
      "GET",
      `${MOCKAPI_URL}/${encodeURIComponent(id)}`
    );

    // Prevent duplicate decisions

    if (record.status !== "pending") {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "This application has already been reviewed."
      });

      return res.sendStatus(200);
    }

    // Update application status

    await mockApi(
      "PUT",
      `${MOCKAPI_URL}/${encodeURIComponent(id)}`,
      {
        status: decision,
        decision_at: new Date().toISOString(),
        decided_by: adminId
      }
    );

    // Respond to Telegram button click

    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `Application ${decision}.`
    });

    // Update original Telegram message

    if (callback.message && callback.message.chat) {
      const originalText =
        callback.message.text ||
        "Demo loan application";

      await telegram("editMessageText", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        text:
          originalText +
          `\n\nADMIN DECISION: ${decision.toUpperCase()}`,
        reply_markup: {
          inline_keyboard: []
        }
      });
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error("Telegram webhook error:", error);

    return res.sendStatus(500);
  }
});

// --------------------------------------------------
// 11. LOCAL DEVELOPMENT SERVER
// --------------------------------------------------

if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

// --------------------------------------------------
// 12. EXPORT EXPRESS APP FOR VERCEL
// --------------------------------------------------

module.exports = app;
