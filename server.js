
const express = require("express");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "20kb" }));

// ==========================================
// ENVIRONMENT VARIABLES
// ==========================================

const MOCKAPI_URL = process.env.MOCKAPI_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const TELEGRAM_WEBHOOK_SECRET =
    process.env.TELEGRAM_WEBHOOK_SECRET;

// ==========================================
// HELPERS
// ==========================================

function requiredEnvironment() {
    return (
        MOCKAPI_URL &&
        BOT_TOKEN &&
        ADMIN_CHAT_ID &&
        ADMIN_USER_ID &&
        TELEGRAM_WEBHOOK_SECRET
    );
}

function safeCompare(a, b) {
    if (!a || !b) return false;

    const first = Buffer.from(String(a));
    const second = Buffer.from(String(b));

    return (
        first.length === second.length &&
        crypto.timingSafeEqual(first, second)
    );
}

async function mockApiRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const text = await response.text();

    let data = {};

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!response.ok) {
        throw new Error(
            "MockAPI error: " + response.status
        );
    }

    return data;
}

async function telegramRequest(method, payload) {
    const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(
            "Telegram error: " +
            (data.description || response.status)
        );
    }

    return data.result;
}

function formatMoney(value) {
    return "BWP " + Number(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        message: "Loan demo backend is running."
    });
});

// ==========================================
// SUBMIT APPLICATION
// ==========================================

app.post("/api/submit", async (req, res) => {
    try {
        if (!requiredEnvironment()) {
            return res.status(500).json({
                error: "Server environment variables are missing."
            });
        }

        const {
            full_name,
            phone_number,
            loan_amount_bwp,
            period_months
        } = req.body;

        const name = String(full_name || "").trim();
        const phone = String(phone_number || "").trim();

        const amount = Number(loan_amount_bwp);
        const period = Number(period_months);

        if (name.length < 2 || name.length > 100) {
            return res.status(400).json({
                error: "Please provide a valid name."
            });
        }

        if (!/^7[0-9]{7}$/.test(phone)) {
            return res.status(400).json({
                error: "Invalid phone number."
            });
        }

        if (
            !Number.isFinite(amount) ||
            amount < 100000 ||
            amount > 1000000
        ) {
            return res.status(400).json({
                error: "Invalid loan amount."
            });
        }

        if (
            !Number.isInteger(period) ||
            period < 3 ||
            period > 24 ||
            period % 3 !== 0
        ) {
            return res.status(400).json({
                error: "Invalid loan period."
            });
        }

        // Recalculate payment on the server.
        const monthlyRate = 0.05 / 12;

        const monthlyPayment =
            amount * monthlyRate /
            (1 - Math.pow(1 + monthlyRate, -period));

        const totalPayment = monthlyPayment * period;

        // A private token lets the applicant check
        // only their own application status.
        const statusToken =
            crypto.randomBytes(32).toString("hex");

        const application = {
            full_name: name,
            phone_number: phone,

            loan_amount_bwp: amount,
            period_months: period,

            monthly_payment_bwp:
                Number(monthlyPayment.toFixed(2)),

            total_repayment_bwp:
                Number(totalPayment.toFixed(2)),

            status: "pending",
            status_token: statusToken,

            submitted_at: new Date().toISOString()
        };

        // Save the application.
        const saved = await mockApiRequest(
            MOCKAPI_URL,
            {
                method: "POST",
                body: JSON.stringify(application)
            }
        );

        if (!saved.id) {
            throw new Error("MockAPI did not return an application ID.");
        }

        // Notify the Telegram administrator.
        const message =
            "NEW LOAN DEMO APPLICATION\n\n" +
            "Application ID: " + saved.id + "\n" +
            "Name: " + name + "\n" +
            "Phone: " + phone + "\n" +
            "Amount: " + formatMoney(amount) + "\n" +
            "Period: " + period + " months\n" +
            "Monthly: " + formatMoney(monthlyPayment) + "\n" +
            "Total: " + formatMoney(totalPayment) + "\n\n" +
            "Current status: PENDING";

        await telegramRequest("sendMessage", {
            chat_id: ADMIN_CHAT_ID,
            text: message,
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: "APPROVE",
                            callback_data:
                                "loan:approve:" + saved.id
                        },
                        {
                            text: "REJECT",
                            callback_data:
                                "loan:reject:" + saved.id
                        }
                    ]
                ]
            }
        });

        return res.status(201).json({
            success: true,
            id: String(saved.id),
            status_token: statusToken,
            status: "pending"
        });

    } catch (error) {
        console.error("SUBMIT ERROR:", error);

        return res.status(500).json({
            error: "Unable to submit application. Please try again."
        });
    }
});

// ==========================================
// CHECK APPLICATION STATUS
// ==========================================

app.get("/api/status", async (req, res) => {
    try {
        const id = String(req.query.id || "");
        const token = String(req.query.token || "");

        if (!id || !token || id.length > 100) {
            return res.status(400).json({
                error: "Missing application credentials."
            });
        }

        const record = await mockApiRequest(
            MOCKAPI_URL + "/" + encodeURIComponent(id)
        );

        if (!safeCompare(record.status_token, token)) {
            return res.status(403).json({
                error: "Invalid application credentials."
            });
        }

        return res.json({
            status: record.status
        });

    } catch (error) {
        console.error("STATUS ERROR:", error);

        return res.status(404).json({
            error: "Application not found."
        });
    }
});

// ==========================================
// TELEGRAM WEBHOOK
// ==========================================

app.post("/telegram/webhook", async (req, res) => {
    const suppliedSecret =
        req.headers["x-telegram-bot-api-secret-token"];

    if (!safeCompare(
        suppliedSecret,
        TELEGRAM_WEBHOOK_SECRET
    )) {
        return res.status(401).send("Unauthorized");
    }

    // Respond to Telegram promptly.
    res.status(200).json({ ok: true });

    try {
        const callback = req.body.callback_query;

        if (!callback) return;

        const callbackId = callback.id;
        const telegramUserId = String(callback.from.id);

        // Only the configured admin can decide.
        if (telegramUserId !== String(ADMIN_USER_ID)) {
            await telegramRequest("answerCallbackQuery", {
                callback_query_id: callbackId,
                text: "You are not authorized.",
                show_alert: true
            });

            return;
        }

        const match = String(
            callback.data || ""
        ).match(/^loan:(approve|reject):([A-Za-z0-9_-]+)$/);

        if (!match) {
            await telegramRequest("answerCallbackQuery", {
                callback_query_id: callbackId,
                text: "Invalid action."
            });

            return;
        }

        const decision = match[1];
        const applicationId = match[2];

        const newStatus =
            decision === "approve" ? "approved" : "rejected";

        const recordUrl =
            MOCKAPI_URL + "/" +
            encodeURIComponent(applicationId);

        const record = await mockApiRequest(recordUrl);

        if (record.status !== "pending") {
            await telegramRequest("answerCallbackQuery", {
                callback_query_id: callbackId,
                text: "This application has already been decided.",
                show_alert: true
            });

            return;
        }

        // Update the MockAPI application.
        await mockApiRequest(recordUrl, {
            method: "PATCH",
            body: JSON.stringify({
                status: newStatus,
                decision_at: new Date().toISOString()
            })
        });

        await telegramRequest("answerCallbackQuery", {
            callback_query_id: callbackId,
            text: "Application " + newStatus + "."
        });

        // Remove the decision buttons after a decision.
        if (callback.message) {
            await telegramRequest("editMessageText", {
                chat_id: callback.message.chat.id,
                message_id: callback.message.message_id,
                text:
                    callback.message.text +
                    "\n\nADMIN DECISION: " +
                    newStatus.toUpperCase(),
                reply_markup: {
                    inline_keyboard: []
                }
            });
        }

    } catch (error) {
        console.error("TELEGRAM WEBHOOK ERROR:", error);
    }
});

// ==========================================
// VERCEL ENTRY POINT
// ==========================================

// Do not call app.listen() on this deployment.
module.exports = app;
