/*
 * Kenzen shared engine.
 * Runs unchanged in Node (server.js, scripts) and in the browser (window.KenzenEngine),
 * so the dashboard keeps working even with no server or API keys.
 *
 *  - Tier 1: linear Student Risk Index (SRI) regression, 0-100
 *  - Synthetic 500-student cohort (seeded, deterministic; Rahul = STU-1208, SRI 78)
 *  - Tier 2 fallback: keyword distress scan + templated counselor summary
 *  - Fast-Track Voucher + calendar invite builders
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KenzenEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- Tier 1 model
  const MODEL = {
    version: 'sri-linreg-v1.3',
    threshold: 65,
    intercept: 0,
    weights: {
      attendance_drop_pct: 0.35,
      sports_inactivity_pct: 0.25,
      library_drop_pct: 0.15,
      gpa_drift_score: 0.25,
    },
    labels: {
      attendance_drop_pct: 'Attendance drop',
      sports_inactivity_pct: 'Sports / activity inactivity',
      library_drop_pct: 'Library activity drop',
      gpa_drift_score: 'GPA drift',
    },
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  /** GPA delta -> 0-100 score. A 2.0-point fall (on a 10-point scale) saturates. */
  function gpaDriftScore(gpaPrev, gpaCurr) {
    const drop = Math.max(0, gpaPrev - gpaCurr);
    return round1(clamp((drop / 2) * 100, 0, 100));
  }

  function featuresFromMetrics(m) {
    return {
      attendance_drop_pct: clamp(+m.attendance_drop_pct || 0, 0, 100),
      sports_inactivity_pct: clamp(+m.sports_inactivity_pct || 0, 0, 100),
      library_drop_pct: clamp(+m.library_drop_pct || 0, 0, 100),
      gpa_drift_score: gpaDriftScore(+m.gpa_prev || 0, +m.gpa_curr || 0),
    };
  }

  function urgencyFor(sri) {
    if (sri >= MODEL.threshold) return 'High';
    if (sri >= 40) return 'Moderate';
    return 'Low';
  }

  /** Score one student. Accepts raw metrics (with gpa_prev/gpa_curr). */
  function computeSRI(metrics) {
    const f = featuresFromMetrics(metrics);
    const contributions = {};
    let total = MODEL.intercept;
    for (const k of Object.keys(MODEL.weights)) {
      contributions[k] = round1(MODEL.weights[k] * f[k]);
      total += MODEL.weights[k] * f[k];
    }
    const sri = round1(clamp(total, 0, 100));
    const tier2 = sri >= MODEL.threshold;
    return {
      sri,
      features: f,
      contributions,
      urgency: urgencyFor(sri),
      tier: tier2 ? 2 : 1,
      route: tier2 ? 'tier2_llm_triage' : 'tier1_automated_wellness_check',
      threshold: MODEL.threshold,
      model_version: MODEL.version,
    };
  }

  function riskFactors(m) {
    const out = [];
    if (m.attendance_drop_pct >= 30) out.push(`Attendance Drop: ${Math.round(m.attendance_drop_pct)}%`);
    if (m.sports_inactivity_pct >= 40) out.push(`Sports Inactivity: ${Math.round(m.sports_inactivity_pct)}%`);
    if (m.library_drop_pct >= 50) out.push(`Library Drop: ${Math.round(m.library_drop_pct)}%`);
    if (m.gpa_prev - m.gpa_curr >= 0.5) out.push('GPA Drift');
    return out;
  }

  // ---------------------------------------------------------------- Synthetic cohort
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FIRST = ['Aarav','Aditi','Aditya','Ananya','Arjun','Avni','Dev','Diya','Ishaan','Ishita','Kabir','Kavya','Krish','Meera','Neel','Nisha','Omkar','Pooja','Pranav','Priya','Rohan','Riya','Sahil','Saanvi','Siddharth','Sneha','Tanvi','Tanmay','Varun','Vedika','Yash','Zoya','Harsh','Ira','Kunal','Lavanya','Manav','Nandini','Parth','Rhea','Shreya','Tejas','Uday','Vihaan','Aisha','Farhan','Gauri','Hrithik','Jahnavi','Karthik','Lakshmi','Mihir','Naveen','Ojas','Rakesh','Simran','Tara','Uma','Vikram','Anjali'];
  const LAST = ['Sharma','Iyer','Reddy','Patel','Nair','Gupta','Menon','Rao','Singh','Kulkarni','Joshi','Das','Mehta','Banerjee','Chopra','Pillai','Verma','Shetty','Kapoor','Mishra','Bhat','Agarwal','Khan','Ghosh','Desai','Saxena','Naidu','Pandey','Sinha','Chauhan'];
  const PROGRAMS = ['B.Tech CSE','B.Tech ECE','B.Tech ME','B.Tech EE','B.Tech Civil','B.Tech Chemical','B.Tech MnC','B.Tech Aerospace','Dual Degree EP','B.Tech Metallurgy'];
  const ACTIVITIES = ['Basketball','Football','Cricket','Badminton','Athletics','Music Club','Robotics Club','Dramatics','Debating','Photography','None'];
  const HOSTELS = ['H1','H2','H3','H4','H5','H6','H7','H8','H9','H10'];

  const RAHUL = {
    id: 'STU-1208',
    name: 'Rahul',
    full_name: 'Rahul (name withheld)',
    program: 'B.Tech CSE',
    year: 2,
    hostel: 'H4',
    primary_activity: 'Basketball',
    metrics: {
      attendance_drop_pct: 80,
      sports_inactivity_pct: 100,
      library_drop_pct: 40,
      gpa_prev: 8.5,
      gpa_curr: 6.98,
    },
    context: {
      entrance: 'JEE Mains rank 1208 · JEE Advanced rank 7000',
      history: 'Former hostel basketball regular. Stopped playing in Sem 3 to study more, under family pressure.',
      last_court_checkin_days: 41,
    },
    last_signal_days: 2,
  };

  function bandSample(rng, tier) {
    // returns metrics drawn from ranges appropriate for the target tier
    const r = (lo, hi) => lo + rng() * (hi - lo);
    let m;
    if (tier === 'high') {
      const prev = r(7.2, 9.4);
      m = { attendance_drop_pct: r(45, 95), sports_inactivity_pct: r(50, 100), library_drop_pct: r(20, 90), gpa_prev: prev, gpa_curr: prev - r(0.8, 2.4) };
    } else if (tier === 'moderate') {
      const prev = r(6.5, 9.5);
      m = { attendance_drop_pct: r(20, 80), sports_inactivity_pct: r(20, 90), library_drop_pct: r(10, 80), gpa_prev: prev, gpa_curr: prev - r(0.1, 1.6) };
    } else {
      const prev = r(5.8, 9.8);
      m = { attendance_drop_pct: r(0, 40), sports_inactivity_pct: r(0, 60), library_drop_pct: r(0, 50), gpa_prev: prev, gpa_curr: clamp(prev + r(-0.6, 0.5), 4, 10) };
    }
    return {
      attendance_drop_pct: Math.round(m.attendance_drop_pct),
      sports_inactivity_pct: Math.round(m.sports_inactivity_pct),
      library_drop_pct: Math.round(m.library_drop_pct),
      gpa_prev: Math.round(m.gpa_prev * 100) / 100,
      gpa_curr: Math.round(clamp(m.gpa_curr, 4, 10) * 100) / 100,
    };
  }

  const BANDS = { high: [65.5, 93], moderate: [40, 64.9], low: [0, 39.9] };

  /**
   * 500 students. Counts are fixed so the dashboard KPIs line up:
   *  14 high (all fast-tracked, Rahul included) · 462 automated check-ins · 11 pending approval · 13 paused by student
   */
  function generateCohort(seed) {
    const rng = mulberry32(seed || 20261001);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const students = [];
    const usedIds = new Set(['1208']);

    const rahulScore = computeSRI(RAHUL.metrics);
    students.push(Object.assign({}, RAHUL, {
      sri: rahulScore.sri,
      urgency: rahulScore.urgency,
      tier: rahulScore.tier,
      risk_factors: riskFactors(RAHUL.metrics),
      status: 'Fast-track: awaiting reply',
      override_active: true,
      highlighted: true,
    }));

    const plan = [].concat(Array(13).fill('high'), Array(70).fill('moderate'), Array(416).fill('low'));
    // shuffle plan
    for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }

    const HIGH_STATUSES = ['Fast-track: slot booked', 'Fast-track: slot booked', 'Fast-track: outreach sent', 'Fast-track: slot booked', 'Fast-track: seen by counselor'];
    let pending = 0, paused = 0;

    plan.forEach((tier) => {
      let id;
      do { id = String(1000 + Math.floor(rng() * 9000)); } while (usedIds.has(id));
      usedIds.add(id);

      let metrics, score, tries = 0;
      const [lo, hi] = BANDS[tier];
      do { metrics = bandSample(rng, tier); score = computeSRI(metrics); tries++; }
      while ((score.sri < lo || score.sri > hi) && tries < 400);

      const first = pick(FIRST);
      let status, override = false;
      if (tier === 'high') { status = pick(HIGH_STATUSES); override = true; }
      else if (tier === 'moderate' && pending < 11 && rng() < 0.3) { status = 'Pending dept. approval'; pending++; }
      else if (tier === 'low' && paused < 13 && rng() < 0.05) { status = 'Check-ins paused by student'; paused++; }
      else status = 'Automated check-in';

      students.push({
        id: 'STU-' + id,
        name: first + ' ' + pick(LAST)[0] + '.',
        program: pick(PROGRAMS),
        year: 1 + Math.floor(rng() * 4),
        hostel: pick(HOSTELS),
        primary_activity: pick(ACTIVITIES),
        metrics,
        sri: score.sri,
        urgency: score.urgency,
        tier: score.tier,
        risk_factors: riskFactors(metrics),
        status,
        override_active: override,
        last_signal_days: 1 + Math.floor(rng() * 14),
      });
    });

    // top up exact counts if the random draw fell short
    for (const s of students) {
      if (pending >= 11) break;
      if (s.urgency === 'Moderate' && s.status === 'Automated check-in') { s.status = 'Pending dept. approval'; pending++; }
    }
    for (const s of students) {
      if (paused >= 13) break;
      if (s.urgency === 'Low' && s.status === 'Automated check-in') { s.status = 'Check-ins paused by student'; paused++; }
    }
    return students;
  }

  function cohortStats(students) {
    const high = students.filter((s) => s.sri >= MODEL.threshold);
    return {
      total: students.length,
      automated_checkins: students.filter((s) => s.status === 'Automated check-in').length,
      overrides: students.filter((s) => s.override_active).length,
      high_risk: high.length,
      pending: students.filter((s) => s.status === 'Pending dept. approval').length,
      avg_wait_days: 1.8,
      baseline_wait_days: 21,
    };
  }

  // ---------------------------------------------------------------- Tier 2 fallback triage
  const LEXICON = {
    acute: ["kill myself", "end it all", "end my life", "suicide", "want to die", "don't want to live", "dont want to live", "not be here anymore", "better off without me", "hurt myself"],
    burden: ["wasting everyone's time", "wasting everyones time", "burden", "waste of space", "letting everyone down", "disappointing my parents", "let my parents down"],
    hopelessness: ["cooked", "no point", "pointless", "hopeless", "give up", "giving up", "can't do this", "cant do this", "nothing matters", "what's the use", "whats the use", "failure", "useless"],
    withdrawal: ["not feeling it", "alone", "lonely", "isolated", "nobody", "no one", "don't want to talk", "skip", "stay in my room"],
    exhaustion: ["tired", "exhausted", "can't sleep", "cant sleep", "drained", "burnt out", "burned out"],
  };
  const CATEGORY_LABEL = {
    acute: 'possible risk to self',
    burden: 'feeling like a burden',
    hopelessness: 'hopelessness',
    withdrawal: 'withdrawal',
    exhaustion: 'exhaustion',
  };

  function scanText(messages) {
    const studentLines = (messages || []).filter((m) => m.from === 'student').map((m) => m.text);
    const hits = [];
    studentLines.forEach((line) => {
      const t = line.toLowerCase().replace(/[’‘]/g, "'");
      for (const cat of Object.keys(LEXICON)) {
        for (const phrase of LEXICON[cat]) {
          if (t.includes(phrase)) hits.push({ phrase, category: cat, label: CATEGORY_LABEL[cat], line });
        }
      }
    });
    const acute = hits.some((h) => h.category === 'acute');
    // most distressed line = the one with most hits
    let quote = studentLines[studentLines.length - 1] || '';
    let best = -1;
    studentLines.forEach((l) => { const n = hits.filter((h) => h.line === l).length; if (n > best) { best = n; quote = l; } });
    return { hits, acute, quote };
  }

  function nextSlot(now) {
    const d = new Date(now || Date.now());
    d.setDate(d.getDate() + 1);
    d.setHours(16, 0, 0, 0);
    return d;
  }

  function formatSlot(d) {
    const day = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
    return `${day}, 4:00 PM`;
  }

  function topDrivers(score) {
    return Object.keys(score.contributions)
      .sort((a, b) => score.contributions[b] - score.contributions[a])
      .slice(0, 2);
  }

  function syntheticTriage(student, messages, opts) {
    const score = computeSRI(student.metrics);
    const scan = scanText(messages);
    const m = student.metrics;
    const first = (student.name || 'there').split(' ')[0];

    const drivers = topDrivers(score).map((k) => {
      if (k === 'attendance_drop_pct') return `attendance down ${Math.round(m.attendance_drop_pct)}%`;
      if (k === 'sports_inactivity_pct') return student.primary_activity && student.primary_activity !== 'None'
        ? `no ${student.primary_activity.toLowerCase()} check-ins (${Math.round(m.sports_inactivity_pct)}% inactive)`
        : `campus activity down ${Math.round(m.sports_inactivity_pct)}%`;
      if (k === 'library_drop_pct') return `library visits down ${Math.round(m.library_drop_pct)}%`;
      return `CGPA ${m.gpa_prev.toFixed(2)} → ${m.gpa_curr.toFixed(2)}`;
    });

    const cats = Array.from(new Set(scan.hits.map((h) => h.label)));
    const b1 = student.context && student.context.last_court_checkin_days
      ? `Pulled back from what used to steady him: ${drivers.join(' and ')}; last basketball court check-in was ${student.context.last_court_checkin_days} days ago.`
      : `Engagement has dropped: ${drivers.join(' and ')} over the current term.`;
    const b2 = scan.hits.length
      ? `In their own words: “${scan.quote.trim()}” Signals: ${cats.join(', ')}.${scan.acute ? ' Includes language about risk to self. Treat as immediate.' : ' No direct mention of self-harm.'}`
      : `Messages read as low-energy but contain no clear distress phrases. The score is driven by behaviour change, not by anything they said.`;
    const ctx = student.context ? ` ${student.context.history}` : '';
    const b3 = scan.acute
      ? `Next step: a counselor calls now and stays with them until they are connected to in-person support. Share Tele-MANAS (14416) in the meantime.${ctx}`
      : `${ctx ? 'Context:' + ctx + ' ' : ''}Next step: a warm, low-pressure 15-minute conversation within 24 hours. Ask gently and directly about safety.`;

    const slot = nextSlot(opts && opts.now);
    const booked = (messages || []).some((x) => x.kind === 'confirm');
    const reply = scan.acute
      ? `Thank you for telling me, ${first}. You don't have to carry this alone. Dr. Ananya from the counselling team is calling you in the next few minutes. If you feel unsafe right now, call Tele-MANAS on 14416 (free, 24×7) or walk into the campus health centre.`
      : booked
      ? `That sounds really heavy, ${first}. Thank you for telling me. Your chat with Dr. Ananya is still on for tomorrow at 4:00 PM, and I've passed this on to her so you don't have to repeat yourself. If it gets harder before then, Tele-MANAS (14416) is free and open 24×7.`
      : `I hear you, ${first}. Thanks for sharing. We've reserved a confidential 15-minute chat with Dr. Ananya tomorrow at 4:00 PM. No paperwork, no fee clearance needed.`;

    return {
      engine: 'synthetic-fallback',
      tier: 2,
      sri: score.sri,
      urgency: scan.acute ? 'Immediate' : 'High',
      acute_risk: scan.acute,
      distress_signals: scan.hits.map((h) => ({ phrase: h.phrase, category: h.label })),
      summary: [b1, b2, b3],
      student_reply: reply,
      slot: { counselor: 'Dr. Ananya', starts_at: slot.toISOString(), label: scan.acute ? 'Call within minutes' : formatSlot(slot), minutes: 15 },
    };
  }

  /** Tier-1 automated wellness nudge for students under the threshold. */
  function tier1Nudge(student) {
    const first = (student.name || 'there').split(' ')[0];
    const act = student.primary_activity && student.primary_activity !== 'None' ? student.primary_activity.toLowerCase() : 'the quiet room in the library';
    return `Hey ${first}, quick check-in from campus wellbeing. How's the week going? If you want a break, ${act} is on this evening. Reply anytime; a real person reads these.`;
  }

  // ---------------------------------------------------------------- Bureaucracy override
  const DEPARTMENTS = [
    { dept: 'Accounts Office', check: 'Fee clearance statement' },
    { dept: 'Dean of Students', check: 'Referral sign-off' },
    { dept: 'Dean, Academic Affairs', check: 'Academic standing letter' },
    { dept: 'Head of Department', check: 'HoD approval' },
    { dept: 'Faculty Advisor', check: 'Advisor recommendation' },
    { dept: 'Hostel Warden', check: 'Residence verification' },
    { dept: 'Medical Centre', check: 'GP pre-screening note' },
    { dept: 'Registrar', check: 'Enrolment verification' },
    { dept: 'Scholarship Office', check: 'Scholarship status check' },
    { dept: 'Proctor’s Office', check: 'Disciplinary clearance' },
    { dept: 'Student Welfare Board', check: 'Welfare committee review' },
    { dept: 'Counselling Cell Admin', check: 'Intake form + waitlist' },
  ];

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36).toUpperCase().slice(0, 5);
  }

  function issueVoucher(student, now) {
    const t = new Date(now || Date.now());
    const num = student.id.replace('STU-', '');
    return {
      voucher_id: `FTV-${t.getFullYear()}-${num}-${hash(student.id + t.toDateString())}`,
      student_id: student.id,
      issued_at: t.toISOString(),
      valid_hours: 72,
      reason: `SRI ${student.sri} ≥ ${MODEL.threshold}: Tier 2 escalation`,
      approvals_bypassed: DEPARTMENTS.length,
      approvals_total: DEPARTMENTS.length,
      overrides: DEPARTMENTS.map((d) => Object.assign({ status: 'auto-bypassed' }, d)),
      confidentiality: 'Only the assigned counselor sees the summary. No department is notified.',
    };
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function icsStamp(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`; }

  function buildICS(student, slotIso) {
    const start = new Date(slotIso);
    const end = new Date(start.getTime() + 15 * 60000);
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kenzen//Campus Wellbeing//EN', 'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${student.id}-${start.getTime()}@kenzen.local`,
      `DTSTAMP:${icsStamp(new Date())}`,
      `DTSTART;TZID=Asia/Kolkata:${icsStamp(start)}`,
      `DTEND;TZID=Asia/Kolkata:${icsStamp(end)}`,
      'SUMMARY:Confidential 15-min chat (Kenzen fast-track)',
      'LOCATION:Counselling Centre, Room 2 (or video, student’s choice)',
      `DESCRIPTION:Fast-track slot for ${student.id}. No paperwork or fee clearance required.`,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
  }

  return {
    MODEL, DEPARTMENTS,
    computeSRI, gpaDriftScore, riskFactors, urgencyFor,
    generateCohort, cohortStats, RAHUL,
    scanText, syntheticTriage, tier1Nudge,
    issueVoucher, buildICS, nextSlot, formatSlot,
  };
});
