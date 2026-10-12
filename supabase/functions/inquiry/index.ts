/**
 * HAICE Apparel - inquiry form backend (Supabase Edge Function, Deno)
 *
 * POST https://exvsglemldxqunmrbvez.supabase.co/functions/v1/inquiry
 *   { name, company, email, country, category, type, quantity, delivery,
 *     message, lang, website(honeypot) }
 *
 * Why this exists: *.workers.dev is unreachable from mainland-China
 * mobile networks (user phone retest 2026-10-12 failed), while
 * *.supabase.co is reachable (verified by the user pasting the live
 * gateway response). Same contract/logic as the Cloudflare Worker
 * version (MarchCao/apparel worker/worker.js) and the Vercel version
 * (api/inquiry.js in this repo).
 *
 * Sends via Resend API:
 *   1) inquiry email  -> INQUIRY_TO (default dual "sales@haice.top,
 *      junhcao@163.com" - Tencent exmail silently drops Resend mail
 *      to sales@, the 163 copy is the no-loss backup)
 *   2) auto-reply (4 langs) -> customer's email
 *
 * Secrets (Supabase function secrets, never in code/git):
 *   RESEND_API_KEY  (required) - set via `supabase secrets set`
 *   FROM_EMAIL / INQUIRY_TO (optional overrides)
 *
 * Deployed with verify_jwt = false (public form endpoint); protection
 * is the same as the Worker version: Origin allowlist + validation +
 * honeypot + per-IP rate limit.
 */

// deno-lint-ignore-file no-unused-vars

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

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= MAX_PER_HOUR) return true;
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

Deno.serve(async (request) => {
  const env = {
    RESEND_API_KEY: Deno.env.get("RESEND_API_KEY"),
    FROM_EMAIL: Deno.env.get("FROM_EMAIL"),
    INQUIRY_TO: Deno.env.get("INQUIRY_TO"),
  };
  const origin = request.headers.get("Origin");
  // Path is not checked: Supabase routes /functions/v1/inquiry to this
  // function; the runtime may present the path with or without prefix.

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "not_found" }, 404, origin);
  }
  if (origin && origin !== ALLOWED_ORIGIN) {
    return json({ ok: false, error: "forbidden" }, 403, origin);
  }

  let d;
  try {
    d = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400, origin);
  }

  const v = validateInquiry(d);
  if (v === "honeypot") return json({ ok: true }, 200, origin);
  if (!v) return json({ ok: false, error: "invalid" }, 400, origin);
  const lang = v;

  const fwd = request.headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json({ ok: false, error: "rate_limited" }, 429, origin);

  if (!env.RESEND_API_KEY) {
    return json({ ok: false, error: "not_configured" }, 500, origin);
  }

  const from = env.FROM_EMAIL || "HAICE Apparel <sales@haice.top>";
  const toList = parseRecipients(env.INQUIRY_TO || "sales@haice.top, junhcao@163.com");

  try {
    const inquiry = buildInquiryEmail(d, lang, { time: new Date().toISOString(), ip });
    await resendSend(env, { from, to: toList, subject: inquiry.subject, text: inquiry.text, replyTo: str(d.email, 254) });
  } catch (e) {
    console.error("Resend inquiry error:", e);
    return json({ ok: false, error: "send_failed" }, 502, origin);
  }

  try {
    const auto = buildAutoReply(d, lang);
    await resendSend(env, { from, to: str(d.email, 254), subject: auto.subject, text: auto.text, replyTo: toList[0] });
  } catch (e) {
    console.error("Resend auto-reply error:", e);
    return json({ ok: true, autoReply: false }, 200, origin);
  }
  return json({ ok: true }, 200, origin);
});
