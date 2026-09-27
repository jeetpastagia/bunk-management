/**
 * Attendance Engine
 * ------------------
 * Pure, side-effect-free calculation functions for lecture-wise attendance.
 * No database or framework dependency on purpose — this is the single
 * source of truth for every attendance number shown anywhere in the app
 * (dashboard, subject analytics, faculty analytics, calculator, predictor,
 * simulator). Every other layer (controllers, cron jobs, widgets API)
 * must call into this module rather than re-deriving math elsewhere.
 *
 * LECTURE STATUS VALUES (see models/LectureRecord.js for the enum):
 *   'attended'  -> counts toward conducted AND attended
 *   'bunked'    -> counts toward conducted only
 *   'holiday'   -> excluded entirely (does not affect attendance)
 *   'cancelled' -> excluded entirely (does not affect attendance)
 *   'extra'     -> counts toward conducted AND attended (treated like an
 *                  attended lecture; it only exists if it was held)
 *   'exam'      -> excluded entirely (does not affect attendance) — same
 *                  treatment as 'holiday', kept as a distinct status so
 *                  exam-period days are visibly different in history/
 *                  calendar views instead of just looking like a holiday
 *   'pending'   -> not yet marked; excluded from calculations until marked
 */

'use strict';

const COUNTS_AS_CONDUCTED = new Set(['attended', 'bunked', 'extra']);
const COUNTS_AS_ATTENDED = new Set(['attended', 'extra']);

/**
 * Reduce an array of lecture records down to {conducted, attended, bunked}.
 * @param {Array<{status:string}>} records
 */
function summarize(records) {
  let conducted = 0;
  let attended = 0;

  for (const r of records) {
    const status = r && r.status;
    if (COUNTS_AS_CONDUCTED.has(status)) {
      conducted += 1;
      if (COUNTS_AS_ATTENDED.has(status)) attended += 1;
    }
  }

  return {
    conducted,
    attended,
    bunked: conducted - attended,
    percentage: percentage(attended, conducted),
  };
}

/**
 * Safe percentage: returns 0 (not NaN/Infinity) when nothing has been conducted yet.
 */
function percentage(attended, conducted) {
  if (!conducted || conducted <= 0) return 0;
  return round2((attended / conducted) * 100);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Group lecture records by an arbitrary key function and summarize each group.
 * Used for subject-wise, faculty-wise, monthly, day-of-week breakdowns, etc.
 * @param {Array} records
 * @param {(record:any) => string} keyFn
 * @returns {Record<string, {conducted:number, attended:number, bunked:number, percentage:number}>}
 */
function groupSummarize(records, keyFn) {
  const groups = {};
  for (const r of records) {
    const key = keyFn(r);
    if (key === null || key === undefined) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  const result = {};
  for (const key of Object.keys(groups)) {
    result[key] = summarize(groups[key]);
  }
  return result;
}

/**
 * How many additional lectures (all attended) are needed to reach targetPct,
 * given the CURRENT conducted/attended totals, assuming every future
 * lecture that gets conducted is attended.
 *
 * Formula derivation:
 *   (attended + n) / (conducted + n) >= target/100
 *   attended + n >= (target/100) * (conducted + n)
 *   n - (target/100)*n >= (target/100)*conducted - attended
 *   n * (1 - target/100) >= (target/100)*conducted - attended
 *   n >= [(target/100)*conducted - attended] / (1 - target/100)
 *
 * If target is 100, it's mathematically unreachable unless already at 100%
 * (returns Infinity in that edge case, surfaced to the caller to handle).
 */
function lecturesNeededForTarget(attended, conducted, targetPct) {
  const t = targetPct / 100;
  if (t >= 1) {
    return attended >= conducted && conducted > 0 ? 0 : Infinity;
  }
  const currentPct = percentage(attended, conducted);
  if (currentPct >= targetPct) return 0;

  const numerator = t * conducted - attended;
  const denominator = 1 - t;
  const n = numerator / denominator;
  return Math.max(0, Math.ceil(n));
}

/**
 * How many of the upcoming lectures can be safely bunked while KEEPING
 * attendance at or above targetPct. This does not look at a real future
 * timetable — it answers "if N more lectures are conducted and I attend
 * none of them, would I still be >= target?" by finding the maximum N
 * such that attended / (conducted + N) >= target/100.
 *
 * Formula:
 *   attended / (conducted + n) >= target/100
 *   attended * 100 / target >= conducted + n
 *   n <= (attended * 100 / target) - conducted
 */
function safeBunksRemaining(attended, conducted, targetPct) {
  if (targetPct <= 0) return Infinity;
  const maxConducted = (attended * 100) / targetPct;
  const n = maxConducted - conducted;
  return Math.max(0, Math.floor(n));
}

/**
 * Smart Attendance Calculator: what does attendance become if the next
 * lecture is bunked vs attended.
 */
function projectNextLecture(attended, conducted) {
  return {
    ifBunked: percentage(attended, conducted + 1),
    ifAttended: percentage(attended + 1, conducted + 1),
  };
}

/**
 * Smart Attendance Calculator (multi-target view): lectures needed to hit
 * several common thresholds at once, e.g. [75, 80, 85, 90].
 */
function lecturesNeededForTargets(attended, conducted, targets = [75, 80, 85, 90]) {
  const out = {};
  for (const t of targets) {
    out[t] = lecturesNeededForTarget(attended, conducted, t);
  }
  return out;
}

/**
 * Future Lecture Simulator: given the CURRENT totals and a list of
 * upcoming lecture "slots" (typically resolved from the timetable for a
 * chosen date range), compute the two extreme outcomes:
 *   - bunkAll: attend none of the upcoming lectures
 *   - attendAll: attend every upcoming lecture
 * `upcomingCount` is the number of lecture slots that would be conducted
 * in that window (holidays should already be excluded by the caller).
 */
function simulateFuture(attended, conducted, upcomingCount, requiredPct = 75) {
  const bunkAll = percentage(attended, conducted + upcomingCount);
  const attendAll = percentage(attended + upcomingCount, conducted + upcomingCount);

  return {
    bunkAllScenario: {
      resultingPercentage: bunkAll,
      status: classify(bunkAll, requiredPct),
    },
    attendAllScenario: {
      resultingPercentage: attendAll,
      status: classify(attendAll, requiredPct),
    },
  };
}

/**
 * Classify a percentage relative to the required threshold into a
 * Safe / Risky / Danger band. Risky band is the 5-point cushion above
 * the requirement — close enough that a single bad day tips it over.
 */
function classify(pct, requiredPct = 75) {
  if (pct < requiredPct) return 'danger';
  if (pct < requiredPct + 5) return 'risky';
  return 'safe';
}

/**
 * Day-of-week bunk pattern insight: which weekday (0=Sun..6=Sat) has the
 * highest bunk rate, useful for the "You usually bunk afternoon lectures"
 * style AI insights. Accepts records already carrying a `date` (JS Date
 * or ISO string) and `status`.
 */
function dayOfWeekBunkPattern(records) {
  const byDay = groupSummarize(records, (r) => {
    if (!r.date) return null;
    const d = new Date(r.date);
    if (Number.isNaN(d.getTime())) return null;
    return d.getDay(); // 0-6
  });

  let worstDay = null;
  let worstBunkRate = -1;
  for (const [day, stats] of Object.entries(byDay)) {
    const bunkRate = stats.conducted > 0 ? stats.bunked / stats.conducted : 0;
    if (bunkRate > worstBunkRate) {
      worstBunkRate = bunkRate;
      worstDay = Number(day);
    }
  }

  return { byDay, worstDay, worstBunkRate: worstDay === null ? 0 : round2(worstBunkRate * 100) };
}

/**
 * Quick Bunk Backfill: a user who didn't mark attendance day-by-day often
 * only remembers HOW MANY lectures of a subject they bunked, not which
 * specific dates. Given the count of still-`pending` lecture records for
 * that subject (already generated for real past dates from the timetable)
 * and how many of those the user says were bunked, this resolves how many
 * should be marked 'bunked' vs 'attended' — clamped so it can never exceed
 * what's actually available, so the caller can safely apply it without a
 * separate validation pass.
 */
function resolveBackfillCounts(pendingCount, bunkedCount) {
  const bunked = Math.max(0, Math.min(Math.floor(bunkedCount) || 0, pendingCount));
  const attended = pendingCount - bunked;
  return { bunked, attended };
}

module.exports = {
  COUNTS_AS_CONDUCTED,
  COUNTS_AS_ATTENDED,
  summarize,
  percentage,
  groupSummarize,
  lecturesNeededForTarget,
  lecturesNeededForTargets,
  safeBunksRemaining,
  projectNextLecture,
  simulateFuture,
  classify,
  dayOfWeekBunkPattern,
  resolveBackfillCounts,
  round2,
};
