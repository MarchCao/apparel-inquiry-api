/**
 * HAICE Apparel - inquiry form backend (Vercel Serverless Function)
 *
 * POST /api/inquiry  { name, company, email, country, category, type,
 *                       quantity, delivery, message, lang, website(honeypot) }
 *
 * Same contract and logic as the Cloudflare Worker version
 * (MarchCao/apparel worker/worker.js). It exists because *.workers.dev
 * is unreachable from mainland-China mobile networks; this function is
 * served behind the custom domain apparel-api.haice.top instead.
 *
 * Sends via Resend API:
 *   1) inquiry email  -> INQUIRY_TO (comma-separated; default dual:
 *      sales@haice.top + junhcao@163.com, because Tencent exmail
 *      silently drops Resend mail to sales@)
 *   2) auto-reply (4 langs) -> customer's email
 *
 * Env vars (Vercel project settings, never in code/git):
 *   RESEND_API_KEY  (required, secret)
 *   FROM_EMAIL      (optional, default "HAICE Apparel <sales@haice.top>")
 *   INQUIRY_TO      (optional, default "sales@haice.top, junhcao@163.com")
 */

const ALLOWED_ORIGIN = "https://apparel.haice.top";
const MAX_PER_HOUR = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map(); // ip -> [timestamps] (best-effort, per isolate)

const LABELS = {
  ja: {
    name: "お名前", company: "会社名", email: "メールアドレス",
    country: "国・地域", category: "製品カテゴリー", type: "OEM / ODM",
    quantity: "予定数量", delivery: "希望納期", message: "お問い合わせ内容",
    inquiryTag: "お問い合わせ",
    autoSubject: "お問い合わせを受け付けました｜HAICE Apparel",
    autoBody: (n) =>
      `${n} 様\n\nこのたびは HAICE Apparel にお問い合わせいただき、ありがとうございます。\nお問い合わせを受け付けました。内容を確認のうえ、担当者よりご返信いたします。\n\n※本メールは自動送信です。このメールへのご返信も届きます。\n—\nHAICE Apparel\nsales@haice.top\nhttps://apparel.haice.top/ja/`,
  },
  zh: {
    name: "姓名", company: "公司名称", email: "邮箱",
    country: "国家/地区", category: "产品类别", type: "OEM / ODM",
    quantity: "预计数量", delivery: "希望交期", message: "询盘内容",
    inquiryTag: "询盘",
    autoSubject: "我们已收到您的询盘｜HAICE Apparel",
    autoBody: (n) =>
      `${n} 您好：\n\n感谢您联系 HAICE Apparel。\n我们已收到您的询盘，确认内容后会尽快回复您。\n\n※本邮件为系统自动发送，直接回复本邮件亦可送达。\n—\nHAICE Apparel\nsales@haice.top\nhttps://apparel.haice.top/zh/`,
  },
  en: {
    name: "Name", company: "Company", email: "Email",
    country: "Country / Region", category: "Product category", type: "OEM / ODM",
    quantity: "Estimated quantity", delivery: "Desired lead time", message: "Message",
    inquiryTag: "Inquiry",
    autoSubject: "We've received your inquiry｜HAICE Apparel",
    autoBody: (n) =>
      `Dear ${n},\n\nThank you for contacting HAICE Apparel.\nWe have received your inquiry and will get back to you after reviewing it.\n\n*This is an automated email; replies to it will reach us.\n—\nHAICE Apparel\nsales@haice.top\nhttps://apparel.haice.top/en/`,
  },
  ko: {
    name: "이름", company: "회사명", email: "이메일",
    country: "국가/지역", category: "제품 카테고리", type: "OEM / ODM",
    quantity: "예상 수량", delivery: "희망 납기", message: "문의 내용",
    inquiryTag: "문의",
    autoSubject: "문의를 접수했습니다｜HAICE Apparel",
    autoBody: (n) =>
      `${n} 님\n\nHAICE Apparel 에 문의해 주셔서 감사합니다.\n문의가 접수되었습니다. 내용을 확인한 후 담당자가 답변드리겠습니다.\n\n※본 메일은 자동 발송 메일입니다. 답장하셔도 수신됩니다.\n—\nHAICE Apparel\nsales@haice.top\nhttps://apparel.haice.top/ko/`,
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";

export function validateInquiry(d) {
  if (!d || typeof d !== "object") return false;
  if (d.website) return "honeypot"; // bot — handled as silent success
  const lang = ["ja", "zh", "en", "ko"].includes(d.lang) ? d.lang : "en";
  if (!str(d.name, 100)) return false;
  if (!EMAIL_RE.test(str(d.email, 254))) return false;
  if (!str(d.message, 5000)) return false;
  return lang;
}

export function buildInquiryEmail(d, lang, meta) {
  const L = LABELS[lang];
  const line = (k, v) => (v ? `${L[k]}: ${v}\n` : "");
  const text =
    `New inquiry from apparel.haice.top (${lang})\n` +
    `----------------------------------------\n` +
    line("name", str(d.name, 100)) +
    line("company", str(d.company, 200)) +
    line("email", str(d.email, 254)) +
    line("country", str(d.country, 100)) +
    line("category", str(d.category, 100)) +
    line("type", str(d.type, 50)) +
    line("quantity", str(d.quantity, 100)) +
    line("delivery", str(d.delivery, 100)) +
    `\n${L.message}:\n${str(d.message, 5000)}\n` +
    `----------------------------------------\n` +
    `Submitted: ${meta.time} | IP: ${meta.ip}\n`;
  const who = str(d.company, 200) || str(d.name, 100);
  return { subject: `[HAICE Apparel ${L.inquiryTag}] ${who}`, text };
}

export function buildAutoReply(d, lang) {
  const L = LABELS[lang];
  return { subject: L.autoSubject, text: L.autoBody(str(d.name, 100)) };
}

async function resendSend(env, { from, to, subject, text, replyTo }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, text, reply_to: replyTo }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`resend ${r.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// INQUIRY_TO supports comma-separated multiple recipients, e.g.
// "sales@haice.top, backup@example.com". Tencent exmail silently drops
// Resend mail to sales@haice.top (confirmed again 2026-10-12: inquiry
// never arrived, auto-reply to 163 did), so a backup address guarantees
// no lost inquiry.
function parseRecipients(v) {
  return String(v || "sales@haice.top").split(",").map((s) => s.trim()).filter(Boolean);
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= MAX_PER_HOUR) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }

  let d;
  try {
    d = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { ok: false, error: "bad_request" });
    return;
  }

  const v = validateInquiry(d);
  if (v === "honeypot") { sendJson(res, 200, { ok: true }); return; }
  if (!v) { sendJson(res, 400, { ok: false, error: "invalid" }); return; }
  const lang = v;

  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || "")).split(",")[0].trim()
    || (req.socket && req.socket.remoteAddress) || "unknown";
  if (rateLimited(ip)) { sendJson(res, 429, { ok: false, error: "rate_limited" }); return; }

  const env = process.env;
  if (!env.RESEND_API_KEY) { sendJson(res, 500, { ok: false, error: "not_configured" }); return; }

  const from = env.FROM_EMAIL || "HAICE Apparel <sales@haice.top>";
  const toList = parseRecipients(env.INQUIRY_TO || "sales@haice.top, junhcao@163.com");

  try {
    const inquiry = buildInquiryEmail(d, lang, { time: new Date().toISOString(), ip });
    await resendSend(env, { from, to: toList, subject: inquiry.subject, text: inquiry.text, replyTo: str(d.email, 254) });
  } catch (e) {
    console.error("Resend inquiry error:", e);
    sendJson(res, 502, { ok: false, error: "send_failed" });
    return;
  }

  try {
    const auto = buildAutoReply(d, lang);
    await resendSend(env, { from, to: str(d.email, 254), subject: auto.subject, text: auto.text, replyTo: toList[0] });
  } catch (e) {
    console.error("Resend auto-reply error:", e);
    sendJson(res, 200, { ok: true, autoReply: false });
    return;
  }
  sendJson(res, 200, { ok: true });
}
