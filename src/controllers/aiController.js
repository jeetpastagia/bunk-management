'use strict';

const { asyncHandler, ApiError } = require('../middleware/errorHandler');
const aiTools = require('../services/aiTools');

// Bunk AI — backed by Google's Gemini API (free tier, no billing
// required), called directly over its REST endpoint with Node's built-in
// fetch rather than a provider SDK. The tool layer in
// src/services/aiTools.js is provider-agnostic — it's the same
// deterministic attendance-math functions regardless of which LLM calls
// them (see that file's header for the "every number comes from a tool,
// never a guess" and "scoped to req.user only" guarantees); only this
// file's request/response shape and tool-schema format are
// Gemini-specific.

const MODEL = 'gemini-2.0-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_HISTORY_MESSAGES = 20; // bounds cost/latency regardless of how long the client-side chat history grows
const MAX_TOOL_ROUNDS = 6; // safety cap on the tool-call loop below

function getApiKey() {
  // .trim() guards against a stray trailing newline/space picked up when
  // pasting into a dashboard's env var field — looks correct to the eye,
  // silently breaks the request otherwise.
  const key = (process.env.GEMINI_API_KEY || '').trim();
  return key || null;
}

// Gemini's function-declaration schema is an OpenAPI subset: uppercase
// type names (STRING/NUMBER/OBJECT/...), and a parameter is optional
// simply by being left out of `required` — no null-type union trick
// needed here the way Anthropic's strict-mode schemas wanted.
const TOOLS = [
  {
    name: 'get_attendance_overview',
    description:
      "Overall and this-month attendance totals, the required attendance percentage, safe bunks remaining, and (if the semester has an end date set) whether reaching the requirement by then is still mathematically possible. Call this for any general 'how am I doing' / 'my attendance summary' question.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'get_subject_breakdown',
    description:
      "Per-subject attendance (attended/conducted/percentage/safe bunks/lectures still needed to hit the requirement), for every subject or one named subject. Call this for 'which subject has the lowest attendance', 'how is my DBMS attendance', or any subject-specific question.",
    parameters: {
      type: 'OBJECT',
      properties: { subjectName: { type: 'STRING', description: 'A subject name or code to filter to just that subject, e.g. "DBMS". Omit for all subjects.' } },
    },
  },
  {
    name: 'get_timetable',
    description:
      "The lectures scheduled on a given date, with each one's subject and status (attended/bunked/pending/not yet conducted). Call this for 'what classes do I have tomorrow', 'can I bunk tomorrow', or any date-specific timetable question.",
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: 'ISO date (YYYY-MM-DD). Resolve relative terms like "tomorrow" to an actual calendar date yourself before calling. Omit for today.' },
      },
    },
  },
  {
    name: 'calculate_bunk_limit',
    description:
      "How many more lectures can be missed while still staying at or above the required attendance percentage — overall, or for one named subject. Call this for 'how many lectures can I bunk' questions, and combine with get_timetable for 'can I bunk tomorrow'.",
    parameters: {
      type: 'OBJECT',
      properties: { subjectName: { type: 'STRING', description: 'Limit the calculation to this subject. Omit for overall.' } },
    },
  },
  {
    name: 'calculate_required_lectures',
    description:
      "How many more lectures (all attended) are needed to reach a target attendance percentage — overall or for one named subject. Call this for 'how many lectures do I need for 80%' questions.",
    parameters: {
      type: 'OBJECT',
      properties: {
        targetPercentage: { type: 'NUMBER', description: "The target attendance percentage, e.g. 80. Omit to use the semester's own required percentage." },
        subjectName: { type: 'STRING', description: 'Limit the calculation to this subject. Omit for overall.' },
      },
    },
  },
  {
    name: 'simulate_attendance',
    description:
      "What attendance percentage results if N more lectures are conducted and either all missed or all attended — overall or for one named subject. Call this for 'what happens if I miss 3 lectures' questions.",
    parameters: {
      type: 'OBJECT',
      properties: {
        lecturesToMiss: { type: 'NUMBER', description: 'How many upcoming lectures to simulate, e.g. 3. Omit to default to 1.' },
        subjectName: { type: 'STRING', description: 'Limit the simulation to this subject. Omit for overall.' },
      },
    },
  },
];

const TOOL_IMPLS = {
  get_attendance_overview: (user) => aiTools.getAttendanceOverview(user),
  get_subject_breakdown: (user, args) => aiTools.getSubjectBreakdown(user, { subjectName: args.subjectName || undefined }),
  get_timetable: (user, args) => aiTools.getTimetable(user, { date: args.date || undefined }),
  calculate_bunk_limit: (user, args) => aiTools.calculateBunkLimit(user, { subjectName: args.subjectName || undefined }),
  calculate_required_lectures: (user, args) =>
    aiTools.calculateRequiredLectures(user, { targetPercentage: args.targetPercentage ?? undefined, subjectName: args.subjectName || undefined }),
  simulate_attendance: (user, args) => aiTools.simulateAttendance(user, { lecturesToMiss: args.lecturesToMiss ?? undefined, subjectName: args.subjectName || undefined }),
};

function buildSystemPrompt(user) {
  const todayLabel = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, locale-stable
  const firstName = user?.studentName?.split(' ')[0] || 'there';
  return [
    `You are Bunk AI, the attendance assistant built into Bunk Manager, talking with ${firstName}.`,
    `Today's date is ${todayLabel}.`,
    'You help students understand their attendance, figure out how many lectures they can safely skip, and plan recovery from a low percentage.',
    'Never estimate, guess, or do attendance math yourself — every number you state must come from calling one of the provided functions first. If a function call fails or a subject name does not match, say so plainly rather than inventing a number.',
    'Keep answers short, warm, and student-friendly — a sentence or two of explanation plus the key number(s), not a lecture. Use plain language over jargon ("you can safely miss 3 more classes" rather than restating raw field names).',
    'When a question needs more than one fact (e.g. "can I bunk tomorrow" needs both the timetable and the bunk limit), call multiple functions before answering.',
  ].join(' ');
}

/** Gemini's `contents` array uses role "model" for assistant turns and "user" for both human turns and function-response turns — no "assistant"/"system" roles. */
function toGeminiContents(messages) {
  return messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
}

const chat = asyncHandler(async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) throw new ApiError(503, 'Bunk AI is not configured on this server yet.');

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) throw new ApiError(400, '"messages" must be a non-empty array.');
  if (messages.some((m) => !m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string')) {
    throw new ApiError(400, 'Each message must be { role: "user" | "assistant", content: string }.');
  }

  const contents = toGeminiContents(messages.slice(-MAX_HISTORY_MESSAGES));
  const systemInstruction = { parts: [{ text: buildSystemPrompt(req.user) }] };

  let finalText = '';
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const apiResponse = await fetch(`${API_BASE}/models/${MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          tools: [{ functionDeclarations: TOOLS }],
          systemInstruction,
          generationConfig: { maxOutputTokens: 1024 },
        }),
      });

      // eslint-disable-next-line no-await-in-loop
      const data = await apiResponse.json();
      if (!apiResponse.ok) {
        const err = new Error(data?.error?.message || `Gemini API error (${apiResponse.status})`);
        err.status = apiResponse.status;
        throw err;
      }

      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

      if (functionCalls.length === 0) {
        finalText = parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
        break;
      }

      // Echo the model's own function-call turn back into history, then
      // answer every call it made in this turn with matching
      // functionResponse parts in a single follow-up "user" turn.
      contents.push({ role: 'model', parts });

      // eslint-disable-next-line no-await-in-loop
      const responseParts = await Promise.all(
        functionCalls.map(async (fc) => {
          const impl = TOOL_IMPLS[fc.name];
          try {
            const result = impl ? await impl(req.user, fc.args || {}) : { error: `Unknown tool: ${fc.name}` };
            return { functionResponse: { name: fc.name, response: result } };
          } catch (err) {
            return { functionResponse: { name: fc.name, response: { error: err.message } } };
          }
        })
      );

      contents.push({ role: 'user', parts: responseParts });
    }
  } catch (err) {
    // Network/upstream failures (bad key, rate limit, outage) — never
    // crash the request or leak API internals, just tell the student to
    // try again.
    // eslint-disable-next-line no-console
    console.error('[Bunk AI] Gemini API error:', err?.status, err?.message);
    if (err?.status === 400 || err?.status === 401 || err?.status === 403) throw new ApiError(503, 'Bunk AI is misconfigured on the server (invalid API key).');
    if (err?.status === 429) throw new ApiError(429, 'Bunk AI is getting a lot of questions right now — try again in a moment.');
    throw new ApiError(503, 'Bunk AI is temporarily unavailable. Please try again.');
  }

  res.json({ reply: finalText || "I couldn't work out a good answer to that — try rephrasing your question." });
});

module.exports = { chat };
