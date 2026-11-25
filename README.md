# Kenzen: campus mental health early warning and zero-friction triage

Co-Innovation Day prototype. It catches students like Rahul before a crisis, skips the 12-department approval chain, and gets them a counselor slot in under 48 hours instead of 21 days.

## Run it (zero config)

```bash
node server.js          # Node 18+, no npm install needed
# open http://localhost:3000
```

`public/index.html` also opens on its own, straight from disk. It then runs fully offline on the built-in synthetic engine. The page needs internet access to load React and fonts from public CDNs.

## The three views

| Tab | Who it's for | What to show judges |
|---|---|---|
| **Student** | Rahul | WhatsApp-style chat. Tap **Confirm Confidential 15-Min Slot**, then type your own reply (try *"I feel like giving up"*, or something stronger to see the urgent path). |
| **Counselor** | University staff | KPIs (500 · 462 · 14 · 1.8 days), a filterable table of all 500 students with Rahul pinned, the 3-bullet triage summary, the override toggle (12/12 approvals bypassed), and **Fast-Track Direct Outreach**. |
| **Engine** | Technical judges | Drag the sliders. The SRI recalculates live, `rahul_data.json` updates, and the pipeline lights up when the score crosses **65.0**. |

## Architecture

```
telemetry ─► Tier 1: linear regression (SRI 0-100, all students, ~0 cost)
                 │ SRI < 65 ─► automated wellness check-in (no LLM)
                 │ SRI ≥ 65
                 ▼
            Tier 2: LLM triage (only ~3% of students)
                 ├─ distress signals in the student's own words
                 ├─ 3-bullet counselor summary
                 └─ Fast-Track Voucher → bypasses all 12 dept checks → slot + WhatsApp + calendar invite
```

**SRI = 0.35·attendance_drop + 0.25·sports_inactivity + 0.15·library_drop + 0.25·gpa_drift**
(gpa_drift = CGPA fall ÷ 2.0 × 100, capped at 100). Rahul: 28 + 25 + 6 + 19 = **78**.

**Safety guard:** a local keyword scan runs alongside the LLM. It can only raise urgency, never lower it. Any language about self-harm switches the reply to "a counselor is calling you now" and gives Tele-MANAS (14416).

## Files

```
server.js                  zero-dependency Node server + API
public/index.html          the app (React 18 + htm via CDN, no build step)
public/engine.js           shared engine: SRI model, cohort generator, fallback triage, voucher, .ics
data/students.json         500 synthetic students (Rahul = STU-1208, SRI 78)
data/rahul_data.json       telemetry record shown in the Engine tab
scripts/generate-data.js   regenerate the data: node scripts/generate-data.js [seed]
.env.example               API key placeholders
```

## Going live with real keys

Copy `.env.example` to `.env` and fill in what you have. Any key left empty keeps that part in synthetic mode.

- `GEMINI_API_KEY` (+ optional `GEMINI_MODEL`, default `gemini-2.5-flash`) enables real Tier 2 triage through the Gemini API. Get a key at https://aistudio.google.com/apikey.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_WHATSAPP_NUMBER` (the sandbox is `+14155238886`), plus `DEMO_STUDENT_WHATSAPP` and `COUNSELOR_WHATSAPP`, make **Fast-Track Direct Outreach** send real WhatsApp messages.
- Two-way WhatsApp: expose the server (e.g. `ngrok http 3000`) and set the Twilio sandbox's incoming-message webhook to `https://<tunnel>/api/whatsapp/webhook`. Real replies then go through the same triage.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | integration modes |
| GET | `/api/students` | 500 students + KPI stats |
| GET | `/api/telemetry/rahul` | `rahul_data.json` |
| POST | `/api/sri` | `{metrics}` → score, contributions, route |
| POST | `/api/triage` | `{student_id, messages}` → Tier 1 nudge or Tier 2 summary + voucher |
| POST | `/api/outreach` | `{student_id}` → WhatsApp to student, message to counselor, calendar invite |
| GET | `/api/outreach/:id/invite.ics` | calendar file |
| POST | `/api/confirm` | student confirms the slot |
| POST | `/api/whatsapp/webhook` | Twilio inbound → TwiML reply |

## Responsible-design notes for the pitch

- Monitoring is opt-in, and students can pause check-ins (13 have, in the dataset).
- The LLM reads a student's messages only after the behavioural score crosses the threshold.
- Summaries go only to the assigned counselor. No department is notified when its check is bypassed.
- Every automated message is labelled as automated, and counselling is always done by a person.
- All data is synthetic. This is a prototype, not a clinical tool.
