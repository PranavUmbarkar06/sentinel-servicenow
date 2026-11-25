#!/usr/bin/env node
/*
 * Kenzen server: zero npm dependencies. Requires Node 18+.
 *   node server.js        → http://localhost:3000
 *
 * Reads optional keys from .env. Any key left empty switches that integration
 * to synthetic mode, so the whole app runs out of the box.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const E = require('./public/engine.js');

// ------------------------------------------------------------------ env
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const CFG = {
  PORT: +(process.env.PORT || 3000),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_WHATSAPP_NUMBER: process.env.TWILIO_WHATSAPP_NUMBER || '',
  DEMO_STUDENT_WHATSAPP: process.env.DEMO_STUDENT_WHATSAPP || '',
  COUNSELOR_WHATSAPP: process.env.COUNSELOR_WHATSAPP || '',
};
const llmLive = () => !!CFG.GEMINI_API_KEY;
const twilioLive = () => !!(CFG.TWILIO_ACCOUNT_SID && CFG.TWILIO_AUTH_TOKEN && CFG.TWILIO_WHATSAPP_NUMBER);

// ------------------------------------------------------------------ data
const DATA_DIR = path.join(__dirname, 'data');
function loadStudents() {
  const f = path.join(DATA_DIR, 'students.json');
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const cohort = E.generateCohort();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cohort, null, 2));
  return cohort;
}
const students = loadStudents();
const byId = new Map(students.map((s) => [s.id, s]));
const outreachLog = new Map(); // student_id -> outreach result
const threads = new Map();     // student_id -> chat messages (for the Twilio webhook)

// ------------------------------------------------------------------ Tier 2: LLM triage
const TRIAGE_SYSTEM = `You support a university counselling team. You read a short WhatsApp exchange with a student whose behavioural risk score has crossed the escalation threshold.
Return ONLY a JSON object with these keys:
  "distress_signals": array of {"phrase": exact words from the student, "category": one of "hopelessness","feeling like a burden","withdrawal","exhaustion","possible risk to self"},
  "acute_risk": true only if the student mentions harming themselves or not wanting to live,
  "summary": exactly 3 short bullet strings for the counselor: (1) behaviour change, (2) what the student said in their own words, (3) suggested next step,
  "student_reply": a warm, brief WhatsApp reply in plain conversational language. If acute_risk is false, offer the reserved confidential 15-minute chat with Dr. Ananya tomorrow at 4:00 PM and say no paperwork or fee clearance is needed. If slot_already_confirmed is true, don't offer a new slot: acknowledge what they said and remind them the chat is still on. If acute_risk is true, say a counselor is calling within minutes and give Tele-MANAS 14416.
Use plain human language. Do not diagnose or use psychiatric labels.`;

async function llmTriage(student, messages) {
  const fallback = E.syntheticTriage(student, messages);
  if (!llmLive()) return fallback;
  try {
    const payload = {
      student: { first_name: student.name.split(' ')[0], program: student.program, year: student.year, primary_activity: student.primary_activity, context: student.context || null },
      telemetry: student.metrics, sri: student.sri,
      conversation: messages.map((m) => ({ from: m.from, text: m.text })),
      slot_already_confirmed: messages.some((m) => m.kind === 'confirm'),
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(CFG.GEMINI_MODEL)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': CFG.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: TRIAGE_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          // Triage is a short structured task: skip extended thinking for lower latency.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('')
      : '';
    if (!text) throw new Error(`Gemini returned no text (finishReason: ${(cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || 'unknown'})`);
    const out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    // Safety guard: the local keyword scan can only raise urgency, never lower it.
    const acute = !!out.acute_risk || fallback.acute_risk;
    return Object.assign({}, fallback, {
      engine: `gemini:${CFG.GEMINI_MODEL}`,
      acute_risk: acute,
      urgency: acute ? 'Immediate' : 'High',
      distress_signals: Array.isArray(out.distress_signals) ? out.distress_signals : fallback.distress_signals,
      summary: Array.isArray(out.summary) && out.summary.length ? out.summary.slice(0, 3) : fallback.summary,
      student_reply: acute && !out.acute_risk ? fallback.student_reply : (out.student_reply || fallback.student_reply),
    });
  } catch (err) {
    console.warn('[triage] LLM call failed, using synthetic fallback:', err.message);
    return Object.assign({}, fallback, { engine: 'synthetic-fallback (LLM error)', error: err.message });
  }
}

async function triage(student, messages) {
  const score = E.computeSRI(student.metrics);
  if (score.sri < E.MODEL.threshold) {
    return { tier: 1, sri: score.sri, urgency: score.urgency, route: score.route, engine: 'tier1-regression', student_reply: E.tier1Nudge(student) };
  }
  const t2 = await llmTriage(student, messages);
  t2.voucher = E.issueVoucher(student);
  return t2;
}

// ------------------------------------------------------------------ Twilio
async function sendWhatsApp(to, body) {
  if (!twilioLive() || !to) {
    return { simulated: true, sid: 'SM_SIM_' + Math.random().toString(36).slice(2, 12).toUpperCase(), to: to || '(demo number not set)', body, status: 'simulated' };
  }
  const wa = (n) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${CFG.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CFG.TWILIO_ACCOUNT_SID}:${CFG.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: wa(CFG.TWILIO_WHATSAPP_NUMBER), To: wa(to), Body: body }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { simulated: false, error: data.message || `Twilio ${res.status}`, to, body, status: 'failed' };
  return { simulated: false, sid: data.sid, to, body, status: data.status };
}

async function fastTrackOutreach(student) {
  const slot = E.nextSlot();
  const first = student.name.split(' ')[0];
  const studentMsg = `Hi ${first}, this is the campus counselling team. Your confidential 15-min chat with Dr. Ananya is held for ${E.formatSlot(slot)}. No forms, no fee clearance. Reply OK to confirm or CHANGE for another time.`;
  const counselorMsg = `Kenzen fast-track: ${student.id} (SRI ${student.sri}) booked with you ${E.formatSlot(slot)}. Triage summary is in your dashboard. All 12 departmental checks bypassed.`;
  const [toStudent, toCounselor] = await Promise.all([
    sendWhatsApp(CFG.DEMO_STUDENT_WHATSAPP, studentMsg),
    sendWhatsApp(CFG.COUNSELOR_WHATSAPP, counselorMsg),
  ]);
  const result = {
    student_id: student.id,
    slot: { counselor: 'Dr. Ananya', starts_at: slot.toISOString(), label: E.formatSlot(slot), minutes: 15 },
    calendar_invite: `/api/outreach/${student.id}/invite.ics`,
    messages: { student: toStudent, counselor: toCounselor },
    voucher: E.issueVoucher(student),
    sent_at: new Date().toISOString(),
  };
  outreachLog.set(student.id, result);
  return result;
}

// ------------------------------------------------------------------ http helpers
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.ics': 'text/calendar' };
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      try {
        if (ct.includes('application/json')) return resolve(JSON.parse(raw || '{}'));
        if (ct.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch (_) { /* fallthrough */ }
      resolve({});
    });
  });
}
function serveStatic(res, rel) {
  const root = path.join(__dirname, 'public');
  const file = path.normalize(path.join(root, rel === '/' ? 'index.html' : rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Not found' });
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

// ------------------------------------------------------------------ routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/config') {
      return send(res, 200, {
        server: true,
        model: E.MODEL,
        integrations: {
          GEMINI_API_KEY: llmLive() ? 'set' : '',
          TWILIO_ACCOUNT_SID: CFG.TWILIO_ACCOUNT_SID ? 'set' : '',
          TWILIO_AUTH_TOKEN: CFG.TWILIO_AUTH_TOKEN ? 'set' : '',
          TWILIO_WHATSAPP_NUMBER: CFG.TWILIO_WHATSAPP_NUMBER ? 'set' : '',
        },
        llm_mode: llmLive() ? `live (${CFG.GEMINI_MODEL})` : 'synthetic',
        twilio_mode: twilioLive() ? 'live' : 'synthetic',
      });
    }
    if (req.method === 'GET' && p === '/api/students') return send(res, 200, { students, stats: E.cohortStats(students) });
    if (req.method === 'GET' && p === '/api/telemetry/rahul') {
      const f = path.join(DATA_DIR, 'rahul_data.json');
      return send(res, 200, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : { error: 'run npm run data' });
    }
    if (req.method === 'POST' && p === '/api/sri') {
      const body = await readBody(req);
      return send(res, 200, E.computeSRI(body.metrics || body));
    }
    if (req.method === 'POST' && p === '/api/triage') {
      const body = await readBody(req);
      const s = byId.get(body.student_id);
      if (!s) return send(res, 404, { error: `No student with id ${body.student_id}` });
      return send(res, 200, await triage(s, body.messages || []));
    }
    if (req.method === 'POST' && p === '/api/outreach') {
      const body = await readBody(req);
      const s = byId.get(body.student_id);
      if (!s) return send(res, 404, { error: `No student with id ${body.student_id}` });
      return send(res, 200, await fastTrackOutreach(s));
    }
    let m = p.match(/^\/api\/outreach\/(STU-\d+)\/invite\.ics$/);
    if (req.method === 'GET' && m) {
      const s = byId.get(m[1]);
      if (!s) return send(res, 404, { error: 'Unknown student' });
      const slot = (outreachLog.get(s.id) || {}).slot || { starts_at: E.nextSlot().toISOString() };
      res.writeHead(200, { 'Content-Type': 'text/calendar', 'Content-Disposition': `attachment; filename="kenzen-${s.id}.ics"` });
      return res.end(E.buildICS(s, slot.starts_at));
    }
    if (req.method === 'POST' && p === '/api/confirm') {
      const body = await readBody(req);
      const s = byId.get(body.student_id);
      if (!s) return send(res, 404, { error: 'Unknown student' });
      s.status = 'Fast-track: slot booked';
      return send(res, 200, { confirmed: true, student_id: s.id, status: s.status, slot: (outreachLog.get(s.id) || {}).slot || { label: E.formatSlot(E.nextSlot()) } });
    }
    // Twilio inbound WhatsApp webhook → Tier 2 triage → TwiML reply.
    // Point your Twilio sandbox "WHEN A MESSAGE COMES IN" at https://<your-tunnel>/api/whatsapp/webhook
    if (req.method === 'POST' && p === '/api/whatsapp/webhook') {
      const body = await readBody(req);
      const s = byId.get('STU-1208'); // demo: inbound messages are treated as Rahul's thread
      const thread = threads.get(s.id) || [];
      thread.push({ from: 'student', text: String(body.Body || '') });
      threads.set(s.id, thread);
      const out = await triage(s, thread);
      thread.push({ from: 'system', text: out.student_reply });
      const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc(out.student_reply)}</Message></Response>`, 'text/xml');
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(CFG.PORT, () => {
  console.log(`\n  Kenzen running → http://localhost:${CFG.PORT}`);
  console.log(`  LLM triage:   ${llmLive() ? 'live (' + CFG.GEMINI_MODEL + ')' : 'synthetic fallback (GEMINI_API_KEY empty)'}`);
  console.log(`  WhatsApp:     ${twilioLive() ? 'live via Twilio' : 'simulated (Twilio keys empty)'}`);
  console.log(`  Students:     ${students.length} loaded\n`);
});
