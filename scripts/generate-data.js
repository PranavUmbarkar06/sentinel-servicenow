#!/usr/bin/env node
// Regenerates data/students.json (500 synthetic students) and data/rahul_data.json.
// Usage: node scripts/generate-data.js [seed]
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../public/engine.js');

const seed = +(process.argv[2] || 20261001);
const cohort = E.generateCohort(seed);
const dir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(cohort, null, 2));

const rahul = cohort.find((s) => s.id === 'STU-1208');
const score = E.computeSRI(rahul.metrics);
const telemetry = {
  student_id: rahul.id,
  name: rahul.name,
  program: rahul.program,
  year: rahul.year,
  window: '2026-08-01/2026-09-30',
  telemetry: {
    attendance_drop_pct: rahul.metrics.attendance_drop_pct,
    sports_rfid_inactivity_pct: rahul.metrics.sports_inactivity_pct,
    library_drop_pct: rahul.metrics.library_drop_pct,
    gpa_prev: rahul.metrics.gpa_prev,
    gpa_curr: rahul.metrics.gpa_curr,
    last_court_checkin_days: rahul.context.last_court_checkin_days,
  },
  tier1: { model: score.model_version, sri: score.sri, contributions: score.contributions, threshold: score.threshold, route: score.route },
  context: rahul.context,
};
fs.writeFileSync(path.join(dir, 'rahul_data.json'), JSON.stringify(telemetry, null, 2));
console.log(E.cohortStats(cohort));
console.log(`Wrote data/students.json and data/rahul_data.json (Rahul SRI = ${score.sri})`);
