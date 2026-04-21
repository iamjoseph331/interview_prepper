/*
 * Interview Prepper front-end.
 *
 * Prompts below are mirrored from PROMPTS.md — if you tune calibration there,
 * update the strings in SYSTEM_PROMPT / generation / evaluation / final below.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT = `You are a senior AI/ML hiring manager designing and grading interview questions.

Target level definitions:
- Junior: 0–2 YOE, fundamentals, can execute with guidance.
- Senior: 3–7 YOE, independent, designs systems, knows tradeoffs.
- Staff: 8+ YOE, sets technical direction, first-principles reasoning.

Scoring rubric (5 dimensions, each 0–5, max 25):
- Correctness: 0 wrong, 3 mostly right, 5 precise.
- Depth: 0 surface, 3 tradeoffs, 5 first principles / non-obvious.
- Clarity: 0 unstructured, 3 readable, 5 structured and concise.
- Practical grounding: 0 textbook only, 3 some examples, 5 concrete production anecdotes / numbers.
- Level appropriateness: 0 under/over level, 3 roughly matched, 5 precisely the asked level.

Rules:
1. When generating, each question must be answerable verbally in 2–5 minutes and calibrated to the requested level.
2. For behavioral categories (STAR, motivation, past experience), ask for a specific situation, not a generic opinion.
3. When grading, grade conservatively. Do not inflate for politeness. Vague answers get low Depth and Practical grounding.
4. Output STRICT JSON only on every call. No prose, no markdown fence.`;

// ---- State ----
const state = {
  categories: [],
  samples: {},
  mode: null,        // 'api' | 'demo'
  level: "Junior",
  selectedIds: new Set(),
  numQuestions: 5,
  apiKey: "",
  model: "claude-sonnet-4-6",
  questions: [],     // [{category_id, question, expected_signals?}]
  idx: 0,
  results: [],       // [{question, answer, evaluation}]
};
window.state = state; // expose for ui.js

// ---- Init ----
async function init() {
  const [cats, samples] = await Promise.all([
    fetch("categories.json").then(r => r.json()),
    fetch("samples.json").then(r => r.json()),
  ]);
  state.categories = cats.categories;
  state.samples = samples;
  renderCategories();
  if (window.__renderCategoryChips) window.__renderCategoryChips();
  bindEvents();
}

function renderCategories() {
  const container = document.getElementById("categories");
  const byGroup = {};
  for (const c of state.categories) {
    (byGroup[c.group] ||= []).push(c);
  }
  container.innerHTML = "";
  for (const group of Object.keys(byGroup)) {
    const h = document.createElement("div");
    h.className = "cat-group";
    h.textContent = group;
    container.appendChild(h);
    for (const c of byGroup[group]) {
      const lbl = document.createElement("label");
      lbl.innerHTML = `<input type="checkbox" data-id="${c.id}" /> ${c.name}`;
      container.appendChild(lbl);
    }
  }
}

function bindEvents() {
  document.getElementById("cat-all").onclick = () => setAllCats(true);
  document.getElementById("cat-none").onclick = () => setAllCats(false);
  document.getElementById("start-api").onclick = startApi;
  document.getElementById("start-demo").onclick = startDemo;
  document.getElementById("q-submit").onclick = submitAnswer;
  document.getElementById("q-skip").onclick = () => submitAnswer(true);
  document.getElementById("restart").onclick = () => showScreen("setup");
}

function setAllCats(on) {
  document.querySelectorAll("#categories input[type=checkbox]").forEach(cb => cb.checked = on);
}

function readSetup() {
  // Level read from 3-way switch (ui.js) or fallback to radio
  const activeLevel = document.querySelector(".level-btn.active");
  state.level = activeLevel ? activeLevel.dataset.level : (document.querySelector('input[name="level"]:checked')?.value || "Junior");
  state.numQuestions = Math.max(1, Math.min(20, parseInt(document.getElementById("num-questions").value, 10) || 5));
  // Categories read from chip buttons (ui.js) or fallback to checkboxes
  const chipSelected = document.querySelectorAll(".cat-chip-btn.selected");
  if (chipSelected.length > 0) {
    state.selectedIds = new Set([...chipSelected].map(b => b.dataset.id));
  } else {
    state.selectedIds = new Set(
      [...document.querySelectorAll("#categories input[type=checkbox]:checked")].map(cb => cb.dataset.id)
    );
  }
  state.apiKey = document.getElementById("api-key").value.trim();
  state.model = document.getElementById("model").value;
}

function showError(msg) {
  document.getElementById("setup-error").textContent = msg || "";
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  window.scrollTo(0, 0);
}

// ---- Start handlers ----

async function startApi() {
  readSetup();
  if (state.selectedIds.size === 0) { showError("Pick at least one category."); return; }
  if (!state.apiKey) { showError("API key is required for graded mode."); return; }
  state.mode = "api";
  sessionStorage.setItem("apiKey", state.apiKey);
  showError("");

  const btn = document.getElementById("start-api");
  btn.disabled = true; btn.textContent = "Generating questions…";
  try {
    state.questions = await generateQuestions();
    state.idx = 0;
    state.results = [];
    renderQuestion();
    showScreen("quiz");
  } catch (e) {
    showError("Generation failed: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Start graded session";
  }
}

function startDemo() {
  readSetup();
  state.mode = "demo";
  const pool = state.samples[state.level] || [];
  let filtered = pool;
  if (state.selectedIds.size > 0) {
    filtered = pool.filter(q => state.selectedIds.has(q.category_id));
  }
  if (filtered.length === 0) {
    showError("No demo questions match those categories at this level. Try 'Select all' or a different level.");
    return;
  }
  showError("");
  state.questions = shuffle(filtered).slice(0, Math.min(state.numQuestions, filtered.length));
  state.idx = 0;
  state.results = [];
  renderQuestion();
  showScreen("quiz");
}

// ---- Quiz rendering ----

function categoryName(id) {
  const c = state.categories.find(x => x.id === id);
  return c ? c.name : id;
}

function renderQuestion() {
  const q = state.questions[state.idx];
  document.getElementById("q-category").textContent = categoryName(q.category_id);
  document.getElementById("q-text").textContent = q.question;
  document.getElementById("q-answer").value = "";
  document.getElementById("q-status").textContent = "";
  const pct = Math.round(100 * state.idx / state.questions.length);
  document.getElementById("progress-bar").style.width = pct + "%";
  document.getElementById("progress-text").textContent =
    `Question ${state.idx + 1} of ${state.questions.length}`;
}

async function submitAnswer(skipped = false) {
  const q = state.questions[state.idx];
  const answer = skipped === true ? "" : document.getElementById("q-answer").value.trim();
  const status = document.getElementById("q-status");
  const submitBtn = document.getElementById("q-submit");
  const skipBtn = document.getElementById("q-skip");

  let evaluation = null;
  if (state.mode === "api" && !skipped && answer) {
    submitBtn.disabled = true; skipBtn.disabled = true;
    status.textContent = "Grading…";
    try {
      evaluation = await evaluateAnswer(q, answer);
    } catch (e) {
      status.textContent = "Grading failed: " + e.message + " — moving on.";
      evaluation = null;
    } finally {
      submitBtn.disabled = false; skipBtn.disabled = false;
    }
  }

  state.results.push({
    category_id: q.category_id,
    question: q.question,
    answer: answer,
    strong_answer_outline: q.strong_answer_outline || null,
    evaluation: evaluation,
    skipped: !!skipped || !answer,
  });

  state.idx++;
  if (state.idx >= state.questions.length) {
    await finishSession();
  } else {
    renderQuestion();
  }
}

// ---- API plumbing ----

async function callClaude({ system, user, temperature, maxTokens }) {
  const body = {
    model: state.model,
    max_tokens: maxTokens ?? 2048,
    temperature: temperature ?? 0,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": state.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.content?.map(b => b.text).filter(Boolean).join("\n") ?? "";
  return text;
}

function extractJson(text) {
  // Strip optional fences and locate first/last JSON structural char.
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const firstBrace = Math.min(
    ...["{", "["].map(ch => cleaned.indexOf(ch)).filter(i => i >= 0)
  );
  const lastBrace = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  const slice = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(slice);
}

async function generateQuestions() {
  const selectedCats = state.categories.filter(c => state.selectedIds.has(c.id));
  const catList = selectedCats.map(c => `${c.id} (${c.name})`).join(", ");
  const user = `Generate ${state.numQuestions} interview questions for a ${state.level} candidate.
Categories (sample uniformly across these): ${catList}.

Return STRICT JSON — an array of objects with this exact shape:
[
  {
    "category_id": "<one of the listed ids>",
    "question": "<the question text>",
    "expected_signals": ["3 to 5 short bullets describing what a strong answer contains"]
  }
]`;

  const text = await callClaude({
    system: SYSTEM_PROMPT,
    user,
    temperature: 1,
    maxTokens: 3000,
  });
  const parsed = extractJson(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Model did not return a question array.");
  }
  return parsed;
}

async function evaluateAnswer(q, answer) {
  const user = `LEVEL: ${state.level}
CATEGORY: ${categoryName(q.category_id)}
QUESTION: ${q.question}
EXPECTED SIGNALS (private rubric):
${(q.expected_signals || []).map(s => `- ${s}`).join("\n")}

CANDIDATE ANSWER:
"""
${answer}
"""

Grade this answer. Output STRICT JSON only:
{
  "scores": {
    "correctness": 0-5,
    "depth": 0-5,
    "clarity": 0-5,
    "practical_grounding": 0-5,
    "level_appropriateness": 0-5
  },
  "total": <sum of scores>,
  "strengths": ["..."],
  "improvements": ["..."],
  "verdict": "below_level" | "at_level" | "above_level"
}`;

  const text = await callClaude({
    system: SYSTEM_PROMPT,
    user,
    temperature: 0,
    maxTokens: 1500,
  });
  return extractJson(text);
}

async function finalEvaluation() {
  const perQuestion = state.results
    .filter(r => r.evaluation)
    .map(r => ({
      category_id: r.category_id,
      question: r.question,
      scores: r.evaluation.scores,
      total: r.evaluation.total,
      verdict: r.evaluation.verdict,
    }));
  if (perQuestion.length === 0) return null;

  const user = `LEVEL: ${state.level}
PER-QUESTION RESULTS:
${JSON.stringify(perQuestion, null, 2)}

Write a session-level evaluation. Output STRICT JSON only:
{
  "total_score": <sum>,
  "max_score": <25 * N>,
  "percentage": <0-100>,
  "category_breakdown": [ { "category_id": "...", "avg": <0-25>, "n": <count> } ],
  "verdict": "below_level" | "at_level" | "above_level",
  "top_strengths": ["..."],
  "top_gaps": ["..."],
  "study_recommendations": ["..."]
}`;

  const text = await callClaude({
    system: SYSTEM_PROMPT,
    user,
    temperature: 0,
    maxTokens: 1500,
  });
  return extractJson(text);
}

// ---- Results ----

async function finishSession() {
  document.getElementById("progress-bar").style.width = "100%";
  showScreen("results");
  const summary = document.getElementById("summary");
  const perQ = document.getElementById("per-question");
  perQ.innerHTML = "";

  if (state.mode === "api") {
    summary.innerHTML = `<p class="small">Computing final evaluation…</p>`;
    let final = null;
    try {
      final = await finalEvaluation();
    } catch (e) {
      summary.innerHTML = `<p class="error">Final eval failed: ${e.message}</p>`;
    }
    if (final) renderSummary(final);
    renderPerQuestionApi(perQ);
  } else {
    summary.innerHTML = `<h2>Demo complete — ${state.questions.length} question(s)</h2>
      <p class="small">Demo mode shows a "strong-answer outline" for each question so you can self-compare.
      Enter an API key in setup to get graded scoring and a session evaluation.</p>`;
    renderPerQuestionDemo(perQ);
  }
}

function renderSummary(f) {
  const summary = document.getElementById("summary");
  const pct = Math.round(f.percentage);
  const verdictClass = (f.verdict || "").replace(/\s+/g, "_");
  summary.innerHTML = `
    <div class="summary-big">${f.total_score}<span class="muted">/${f.max_score}</span> · <span class="pct">${pct}%</span></div>
    <div class="verdict ${verdictClass}">Verdict: ${formatVerdict(f.verdict)} (as ${state.level})</div>
    <h3>Top strengths</h3>
    <ul class="tight">${(f.top_strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
    <h3>Top gaps</h3>
    <ul class="tight">${(f.top_gaps || []).map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
    <h3>Study recommendations</h3>
    <ul class="tight">${(f.study_recommendations || []).map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
  `;
}

function renderPerQuestionApi(container) {
  for (const r of state.results) {
    const div = document.createElement("div");
    div.className = "qresult";
    const e = r.evaluation;
    if (!e) {
      div.innerHTML = `
        <div class="cat-chip">${escapeHtml(categoryName(r.category_id))}</div>
        <h3>${escapeHtml(r.question)}</h3>
        <div class="q-answer">${r.skipped ? "(skipped)" : escapeHtml(r.answer)}</div>
        <p class="small">Not graded.</p>`;
    } else {
      div.innerHTML = `
        <div class="cat-chip">${escapeHtml(categoryName(r.category_id))}</div>
        <h3>${escapeHtml(r.question)}</h3>
        <div class="q-answer">${escapeHtml(r.answer)}</div>
        <div class="scores">
          <span class="score-pill">Correctness ${e.scores.correctness}/5</span>
          <span class="score-pill">Depth ${e.scores.depth}/5</span>
          <span class="score-pill">Clarity ${e.scores.clarity}/5</span>
          <span class="score-pill">Practical ${e.scores.practical_grounding}/5</span>
          <span class="score-pill">Level ${e.scores.level_appropriateness}/5</span>
          <span class="score-pill"><b>Total ${e.total}/25</b></span>
        </div>
        <div class="verdict ${e.verdict}">${formatVerdict(e.verdict)}</div>
        <h4>Strengths</h4>
        <ul class="tight">${(e.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
        <h4>Improvements</h4>
        <ul class="tight">${(e.improvements || []).map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`;
    }
    container.appendChild(div);
  }
}

function renderPerQuestionDemo(container) {
  for (const r of state.results) {
    const div = document.createElement("div");
    div.className = "qresult";
    div.innerHTML = `
      <div class="cat-chip">${escapeHtml(categoryName(r.category_id))}</div>
      <h3>${escapeHtml(r.question)}</h3>
      <h4>Your answer</h4>
      <div class="q-answer">${r.skipped || !r.answer ? "(skipped)" : escapeHtml(r.answer)}</div>
      <h4>Strong-answer outline</h4>
      <ul class="tight">${(r.strong_answer_outline || []).map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`;
    container.appendChild(div);
  }
}

// ---- Helpers ----

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function formatVerdict(v) {
  return ({
    below_level: "Below level",
    at_level: "At level",
    above_level: "Above level",
  })[v] || v || "";
}

init();
