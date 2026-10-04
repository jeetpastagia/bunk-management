'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const aiTools = require('../services/aiTools');

// Bunk AI — a chat assistant over the student's own real attendance data.
// Claude never computes an attendance number itself: every tool call below
// runs deterministic math in src/services/aiTools.js (which in turn reuses
// attendanceEngine.js, the app's single source of truth for that math), and
// Claude's only job is deciding which tool(s) to call and explaining the
// JSON result in plain language. The key stays server-side (read from
// process.env here, never sent to the frontend) and every tool call is
// scoped to req.user — set by middleware/auth.js's requireAuth from the
// caller's own JWT — so there is no code path by which Bunk AI can read or
// report on a different student's data.

const MODEL = 'claude-opus-5-5';
const MAX_HISTORY_MESSAGES = 20; // bounds cost/latency regardless of how long the client-side chat history grows
const MAX_TOOL_ROUNDS = 6; // safety cap on the tool-call loop below

let client = null;
function getClient() {
  // .trim() guards against the single most common cause of "invalid API
  // key" despite a correct key: a stray trailing newline/space picked up
  // when pasting into a dashboard's env var field, which silently breaks
  // the Bearer header without looking wrong to the human eye.
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

const TOOLS = [
  {
    name: 'get_attendance_overview',
    description:
      "Overall and this-month attendance totals, the required attendance percentage, safe bunks remaining, and (if the semester has an end date set) whether reaching the requirement by then is still mathematically possible. Call this for any general 'how am I doing' / 'my attendance summary' question.",
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'get_subject_breakdown',
    description:
      "Per-subject attendance (attended/conducted/percentage/safe bunks/lectures still needed to hit the requirement), for every subject or one named subject. Call this for 'which subject has the lowest attendance', 'how is my DBMS attendance', or any subject-specific question.",
    input_schema: {
      type: 'object',
      properties: { subjectName: { type: ['string', 'null'], description: 'A subject name or code to filter to just that subject, e.g. "DBMS". Pass null for all subjects.' } },
      required: ['subjectName'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'get_timetable',
    description:
      "The lectures scheduled on a given date, with each one's subject and status (attended/bunked/pending/not yet conducted). Call this for 'what classes do I have tomorrow', 'can I bunk tomorrow', or any date-specific timetable question.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: ['string', 'null'], description: 'ISO date (YYYY-MM-DD). Resolve relative terms like "tomorrow" to an actual calendar date yourself before calling. Pass null for today.' },
      },
      required: ['date'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'calculate_bunk_limit',
    description:
      "How many more lectures can be missed while still staying at or above the required attendance percentage — overall, or for one named subject. Call this for 'how many lectures can I bunk' questions, and combine with get_timetable for 'can I bunk tomorrow'.",
    input_schema: {
      type: 'object',
      properties: { subjectName: { type: ['string', 'null'], description: 'Limit the calculation to this subject. Pass null for overall.' } },
      required: ['subjectName'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'calculate_required_lectures',
    description:
      "How many more lectures (all attended) are needed to reach a target attendance percentage — overall or for one named subject. Call this for 'how many lectures do I need for 80%' questions.",
    input_schema: {
      type: 'object',
      properties: {
        targetPercentage: { type: ['number', 'null'], description: "The target attendance percentage, e.g. 80. Pass null to use the semester's own required percentage." },
        subjectName: { type: ['string', 'null'], description: 'Limit the calculation to this subject. Pass null for overall.' },
      },
      required: ['targetPercentage', 'subjectName'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'simulate_attendance',
    description:
      "What attendance percentage results if N more lectures are conducted and either all missed or all attended — overall or for one named subject. Call this for 'what happens if I miss 3 lectures' questions.",
    input_schema: {
      type: 'object',
      properties: {
        lecturesToMiss: { type: ['number', 'null'], description: 'How many upcoming lectures to simulate, e.g. 3. Pass null to default to 1.' },
        subjectName: { type: ['string', 'null'], description: 'Limit the simulation to this subject. Pass null for overall.' },
      },
      required: ['lecturesToMiss', 'subjectName'],
      additionalProperties: false,
    },
    strict: true,
  },
];

const TOOL_IMPLS = {
  get_attendance_overview: (user) => aiTools.getAttendanceOverview(user),
  get_subject_breakdown: (user, input) => aiTools.getSubjectBreakdown(user, { subjectName: input.subjectName || undefined }),
  get_timetable: (user, input) => aiTools.getTimetable(user, { date: input.date || undefined }),
  calculate_bunk_limit: (user, input) => aiTools.calculateBunkLimit(user, { subjectName: input.subjectName || undefined }),
  calculate_required_lectures: (user, input) =>
    aiTools.calculateRequiredLectures(user, { targetPercentage: input.targetPercentage ?? undefined, subjectName: input.subjectName || undefined }),
  simulate_attendance: (user, input) => aiTools.simulateAttendance(user, { lecturesToMiss: input.lecturesToMiss ?? undefined, subjectName: input.subjectName || undefined }),
};

function buildSystemPrompt(user) {
  const todayLabel = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, locale-stable
  const firstName = user?.studentName?.split(' ')[0] || 'there';
  return [
    `You are Bunk AI, the attendance assistant built into Bunk Manager, talking with ${firstName}.`,
    `Today's date is ${todayLabel}.`,
    'You help students understand their attendance, figure out how many lectures they can safely skip, and plan recovery from a low percentage.',
    'Never estimate, guess, or do attendance math yourself — every number you state must come from calling one of the provided tools first. If a tool call fails or a subject name does not match, say so plainly rather than inventing a number.',
    'Keep answers short, warm, and student-friendly — a sentence or two of explanation plus the key number(s), not a lecture. Use plain language over jargon ("you can safely miss 3 more classes" rather than restating raw JSON field names).',
    'When a question needs more than one fact (e.g. "can I bunk tomorrow" needs both the timetable and the bunk limit), call multiple tools before answering.',
  ].join(' ');
}

const chat = asyncHandler(async (req, res) => {
  const anthropic = getClient();
  if (!anthropic) throw new ApiError(503, 'Bunk AI is not configured on this server yet.');

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) throw new ApiError(400, '"messages" must be a non-empty array.');
  if (messages.some((m) => !m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string')) {
    throw new ApiError(400, 'Each message must be { role: "user" | "assistant", content: string }.');
  }

  const conversation = messages.slice(-MAX_HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
  const system = buildSystemPrompt(req.user);

  let response;
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        output_config: { effort: 'low' }, // this is simple structured Q&A over tool JSON, not open-ended reasoning
        system,
        tools: TOOLS,
        messages: conversation,
      });

      if (response.stop_reason === 'refusal') {
        return res.json({ reply: "I'm not able to help with that one — try asking about your attendance, timetable, or bunk limits instead." });
      }

      const toolUses = response.content.filter((block) => block.type === 'tool_use');
      if (toolUses.length === 0) break;

      conversation.push({ role: 'assistant', content: response.content });

      // eslint-disable-next-line no-await-in-loop
      const toolResults = await Promise.all(
        toolUses.map(async (toolUse) => {
          const impl = TOOL_IMPLS[toolUse.name];
          try {
            const result = impl ? await impl(req.user, toolUse.input || {}) : { error: `Unknown tool: ${toolUse.name}` };
            return { type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) };
          } catch (err) {
            return { type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ error: err.message }), is_error: true };
          }
        })
      );

      conversation.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    // Network/upstream failures (rate limit, auth, outage) — never crash the
    // request or leak SDK internals, just tell the student to try again.
    // eslint-disable-next-line no-console
    console.error('[Bunk AI] Anthropic API error:', err?.status, err?.message);
    if (err?.status === 401) throw new ApiError(503, 'Bunk AI is misconfigured on the server (invalid API key).');
    if (err?.status === 429) throw new ApiError(429, 'Bunk AI is getting a lot of questions right now — try again in a moment.');
    throw new ApiError(503, 'Bunk AI is temporarily unavailable. Please try again.');
  }

  const text = (response?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  res.json({ reply: text || "I couldn't work out a good answer to that — try rephrasing your question." });
});

module.exports = { chat };
