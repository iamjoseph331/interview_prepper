/*
 * Interview Prepper front-end.
 *
 * Prompts below are mirrored from PROMPTS.md — if you tune calibration there,
 * update the strings in SYSTEM_PROMPT / generation / evaluation / final below.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ---- Keyala (optional): use your own Claude key without pasting it here ----
// The page only holds a grant token; the key stays in the visitor's Keyala account and each call
// is approved on their phone. Local testing: ?ky=http://localhost:8080&app=app_interview_prepper
const KY_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const KY_QS = new URLSearchParams(location.search);
const KEYALA_URL = ((KY_LOCAL && KY_QS.get("ky")) || { staging: "https://staging.keyala.io" }[KY_QS.get("server")] || "https://app.keyala.io").replace(/\/$/, "");
const KEYALA_APP = (KY_LOCAL && KY_QS.get("app")) || "app_interview_prepper";
// Must match Keyala's model allowlist.
const KEYALA_MODELS = [
  ["claude-sonnet-5-5", "Sonnet 5.5 — balanced (default)"],
  ["claude-haiku-5-5", "Haiku 5.5 — fast & cheap"],
  ["claude-opus-5-5", "Opus 5.5 — highest quality"],
];
const GRANT_KEY = "interviewPrepperKeyalaGrant:" + KEYALA_URL;
const grantStore = {
  get: () => { try { return localStorage.getItem(GRANT_KEY) || ""; } catch { return ""; } },
  set: (t) => { try { t ? localStorage.setItem(GRANT_KEY, t) : localStorage.removeItem(GRANT_KEY); } catch {} },
};

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

// ---- Notes (session-only: kept in sessionStorage so they clear when the tab closes) ----
const NOTES_KEY = "interviewPrepperNotes";

function loadAllNotes() {
  try {
    const raw = sessionStorage.getItem(NOTES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveAllNotes(notes) {
  sessionStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}
function getNote(categoryId) {
  return loadAllNotes()[categoryId] || "";
}
function setNote(categoryId, text) {
  const notes = loadAllNotes();
  if (text && text.trim()) notes[categoryId] = text;
  else delete notes[categoryId];
  saveAllNotes(notes);
}

// ---- State ----
const state = {
  categories: [],
  samples: {},
  mode: null,        // 'api' | 'demo' | 'jd'
  level: "Junior",
  selectedIds: new Set(),
  numQuestions: 5,
  apiKey: "",
  model: "claude-sonnet-4-6",
  questions: [],     // [{category_id, question, expected_signals?}]
  idx: 0,
  results: [],       // [{question, answer, evaluation}]
  jd: "",            // raw job description markdown
  jdTitle: "",       // extracted/fallback job title
  grant: grantStore.get(), // Keyala grant token, if connected
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
  document.getElementById("start-jd-btn").onclick = startJd;
  document.getElementById("keyala-connect").onclick = connectKeyala;
  document.getElementById("keyala-disconnect").onclick = () => setGrant("");
  renderKeyala();
  document.getElementById("q-submit").onclick = submitAnswer;
  document.getElementById("q-skip").onclick = () => submitAnswer(true);
  document.getElementById("restart").onclick = () => { refreshNotesCountHint(); showScreen("setup"); };

  // Notes: autosave as the user types (debounced)
  const notesArea = document.getElementById("q-notes");
  if (notesArea) {
    let t = null;
    notesArea.addEventListener("input", () => {
      const cid = notesArea.dataset.categoryId;
      if (!cid) return;
      const status = document.getElementById("notes-status");
      if (status) status.textContent = "Saving…";
      clearTimeout(t);
      t = setTimeout(() => {
        setNote(cid, notesArea.value);
        if (status) status.textContent = "Saved";
      }, 400);
    });
  }

  // Export buttons (all wired to the same downloader)
  ["notes-download-setup", "notes-download-quiz", "notes-download-results"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.onclick = downloadAllNotes;
  });

  refreshNotesCountHint();
}

function refreshNotesCountHint() {
  const notes = loadAllNotes();
  const entries = Object.entries(notes).filter(([, v]) => (v || "").trim());
  const n = entries.length;

  const hint = document.getElementById("notes-count-hint");
  if (hint) {
    hint.textContent = n === 0
      ? "No category notes saved yet — add some during a quiz."
      : `${n} categor${n === 1 ? "y has" : "ies have"} saved notes. Click to expand.`;
  }

  const body = document.getElementById("notes-panel-body");
  if (!body) return;
  const empty = document.getElementById("notes-panel-empty");
  // Strip dynamically inserted items but keep the empty placeholder.
  [...body.querySelectorAll(".notes-panel-item")].forEach(el => el.remove());

  if (n === 0) {
    if (empty) empty.style.display = "";
    return;
  }
  if (empty) empty.style.display = "none";

  const cats = state.categories || [];
  const catById = Object.fromEntries(cats.map(c => [c.id, c]));
  function resolveCat(cid) {
    if (cid === "jd_session") return { id: cid, name: state.jdTitle || "Job Description", group: "Job Description" };
    return catById[cid] || { id: cid, name: cid, group: "Uncategorized" };
  }
  // Sort: by group then by name
  entries.sort(([a], [b]) => {
    const ca = resolveCat(a);
    const cb = resolveCat(b);
    return (ca.group || "").localeCompare(cb.group || "") || (ca.name || "").localeCompare(cb.name || "");
  });

  for (const [cid, text] of entries) {
    const cat = resolveCat(cid);
    const item = document.createElement("details");
    item.className = "notes-panel-item";

    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="notes-item-group">${escapeHtml(cat.group)}</span>
      <span class="notes-item-name">${escapeHtml(cat.name)}</span>
      <span class="notes-item-preview">${escapeHtml(text.slice(0, 70))}${text.length > 70 ? "…" : ""}</span>`;
    item.appendChild(summary);

    const ta = document.createElement("textarea");
    ta.className = "notes-item-textarea";
    ta.rows = 6;
    ta.value = text;
    ta.dataset.categoryId = cid;

    const status = document.createElement("div");
    status.className = "notes-item-status fine-print";
    status.textContent = "Saved";

    let tHandle = null;
    ta.addEventListener("input", () => {
      status.textContent = "Saving…";
      clearTimeout(tHandle);
      tHandle = setTimeout(() => {
        setNote(cid, ta.value);
        status.textContent = ta.value.trim() ? "Saved" : "Empty — will not be exported";
        // Refresh the preview in the summary
        summary.querySelector(".notes-item-preview").textContent =
          ta.value.slice(0, 70) + (ta.value.length > 70 ? "…" : "");
      }, 400);
    });

    item.appendChild(ta);
    item.appendChild(status);
    body.appendChild(item);
  }
}

function loadNoteForCurrentQuestion() {
  const q = state.questions[state.idx];
  if (!q) return;
  const notesArea = document.getElementById("q-notes");
  const catName = document.getElementById("notes-cat-name");
  const status = document.getElementById("notes-status");
  if (!notesArea) return;
  notesArea.dataset.categoryId = q.category_id;
  notesArea.value = getNote(q.category_id);
  if (catName) catName.textContent = categoryName(q.category_id);
  if (status) status.textContent = notesArea.value ? "Saved" : "";
}

function setAllCats(on) {
  // ui.js renders categories as <button class="cat-chip-btn">; keep checkbox-fallback for safety.
  document.querySelectorAll(".cat-chip-btn").forEach(b => b.classList.toggle("selected", on));
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
  if (!state.apiKey && !state.grant) { showError("Paste an API key or connect Keyala first."); return; }
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

async function startJd() {
  const jdText = document.getElementById("jd-text").value.trim();
  const apiKey = document.getElementById("jd-api-key").value.trim();
  const model  = document.getElementById("jd-model").value;
  if (!jdText) { showError("Paste or upload a job description first."); return; }
  if (!apiKey && !state.grant) { showError("Paste an API key or connect Keyala first."); return; }

  readSetup(); // reads level + numQuestions from shared controls
  state.apiKey = apiKey;
  state.model  = model;
  state.jd     = jdText;
  // Extract first markdown heading as the job title, fallback to "Job Description"
  const headingMatch = jdText.match(/^#{1,3}\s+(.+)/m);
  state.jdTitle = headingMatch ? headingMatch[1].trim() : "Job Description";
  state.mode = "jd";
  showError("");

  const btn = document.getElementById("start-jd-btn");
  btn.disabled = true; btn.textContent = "Generating questions…";
  try {
    state.questions = await generateJdQuestions();
    state.idx = 0;
    state.results = [];
    renderQuestion();
    showScreen("quiz");
  } catch (e) {
    showError("Generation failed: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Start JD session →";
  }
}

async function generateJdQuestions() {
  const user = `You are generating interview questions for this specific job posting.

=== JOB DESCRIPTION ===
${state.jd}
=== END JOB DESCRIPTION ===

Generate ${state.numQuestions} interview questions calibrated for a ${state.level}-level candidate applying to this role.
Mix question types relevant to the JD: technical depth, role-specific scenarios, and behavioral questions tied to the responsibilities listed.
For every question, set category_id to "jd_session".

Return STRICT JSON — an array of objects with this exact shape:
[
  {
    "category_id": "jd_session",
    "question": "<the question text>",
    "expected_signals": ["3 to 5 short bullets describing what a strong answer contains"]
  }
]`;

  const text = await callClaude({ system: SYSTEM_PROMPT, user, temperature: 1, maxTokens: 3000 });
  const parsed = extractJson(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Model did not return a question array.");
  }
  return parsed;
}

// ---- Quiz rendering ----

function categoryName(id) {
  if (id === "jd_session") return state.jdTitle || "Job Description";
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
  loadNoteForCurrentQuestion();
}

async function submitAnswer(skipped = false) {
  // Normalize: click handlers pass the event as the first arg, which must NOT be treated as "skipped".
  skipped = (skipped === true);

  const q = state.questions[state.idx];
  // Flush any pending note edits immediately so nothing is lost on fast-advance.
  const notesArea = document.getElementById("q-notes");
  if (notesArea && notesArea.dataset.categoryId) {
    setNote(notesArea.dataset.categoryId, notesArea.value);
  }
  const answer = skipped ? "" : document.getElementById("q-answer").value.trim();
  const status = document.getElementById("q-status");
  const submitBtn = document.getElementById("q-submit");
  const skipBtn = document.getElementById("q-skip");

  let evaluation = null;
  if ((state.mode === "api" || state.mode === "jd") && !skipped && answer) {
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
  if (state.grant) return callKeyala({ ...body, system }); // Keyala forwards plain text only (no cache_control)
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
    if (res.status === 401) {
      throw new Error("Anthropic rejected the key (401). Double-check the key you pasted starts with sk-ant-, has no trailing spaces, and is active in https://console.anthropic.com/settings/keys.");
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  const data = await res.json();
  const text = data.content?.map(b => b.text).filter(Boolean).join("\n") ?? "";
  return text;
}

// Same request body, sent to Keyala with the grant instead of a key. No retries: a slow phone
// approval answers 202 and we poll; the Idempotency-Key keeps a resent call from running twice.
async function callKeyala(body) {
  const auth = { Authorization: "Bearer " + state.grant };
  let res = await fetch(KEYALA_URL + "/v1/anthropic/messages", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-Keyala-Wait": "25" },
    body: JSON.stringify(body),
  });
  let data = await res.json().catch(() => ({}));
  while (res.status === 202) {
    setKeyalaStatus("Waiting for approval on your phone…");
    await new Promise(r => setTimeout(r, 1500));
    const p = await fetch(KEYALA_URL + "/v1/requests/" + encodeURIComponent(data.request_id), { headers: auth });
    const pj = await p.json().catch(() => ({}));
    if (p.status !== 200) { res = p; data = pj; break; }
    if (pj.status === "completed") { res = { status: 200 }; data = pj.response || {}; break; }
    if (pj.status === "denied") { res = { status: 403 }; data = { error: { type: "keyala_denied" } }; break; }
    if (pj.status === "expired") { res = { status: 410 }; break; }
    if (pj.status === "failed" || pj.status === "uncertain") {
      throw new Error(pj.response?.error?.message || `Keyala request ${pj.status}.`);
    }
  }
  setKeyalaStatus("");
  if (res.status === 200) return data.content?.map(b => b.text).filter(Boolean).join("\n") ?? "";
  if (res.status === 401) { setGrant(""); throw new Error("Your Keyala connection ended (revoked in the app?). Connect again."); }
  if (res.status === 403 && data.error?.type === "keyala_denied") throw new Error("You denied this call in Keyala.");
  if (res.status === 410) throw new Error("The call was not approved in time. Try again.");
  throw new Error(data.error?.message || `Keyala returned ${res.status}`);
}

function setKeyalaStatus(msg) {
  const onQuiz = document.getElementById("quiz").classList.contains("active");
  const el = document.getElementById(onQuiz ? "q-status" : "setup-error");
  if (msg || !onQuiz) el.textContent = msg;
}

// Connect / disconnect UI. Pairing is Keyala's web SDK, loaded from the Keyala server on demand.
const DIRECT_MODEL_OPTIONS = {};
function setGrant(token) {
  state.grant = token;
  grantStore.set(token);
  renderKeyala();
}
function renderKeyala() {
  const on = !!state.grant;
  document.getElementById("keyala-off").hidden = on;
  document.getElementById("keyala-on").hidden = !on;
  document.querySelectorAll(".needs-key").forEach(el => { el.hidden = on; });
  for (const id of ["model", "jd-model"]) {
    const sel = document.getElementById(id);
    DIRECT_MODEL_OPTIONS[id] ??= sel.innerHTML;
    if (on) sel.replaceChildren(...KEYALA_MODELS.map(([v, l]) => new Option(l, v)));
    else sel.innerHTML = DIRECT_MODEL_OPTIONS[id];
  }
}
let keyalaSdk = null;
async function connectKeyala() {
  const btn = document.getElementById("keyala-connect");
  btn.disabled = true;
  showError("");
  try {
    keyalaSdk ??= new Promise((ok, no) => {
      const s = document.createElement("script");
      s.src = KEYALA_URL + "/sdk/keyala.js"; s.onload = ok; s.onerror = no;
      document.head.append(s);
    });
    await keyalaSdk;
    const g = await Keyala.connect({ app: KEYALA_APP, vendor: "anthropic", server: KEYALA_URL });
    setGrant(g.grant_token);
  } catch (e) {
    keyalaSdk = e && e.code ? keyalaSdk : null; // script failed to load: allow a retry
    if (!e || e.code !== "cancelled") showError(e && e.code === "denied" ? "Connection denied in Keyala." : (e && e.message) || "Could not reach Keyala at " + KEYALA_URL);
  } finally {
    btn.disabled = false;
  }
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

  if (state.mode === "api" || state.mode === "jd") {
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

// ---- Notes export ----

function downloadAllNotes() {
  const notes = loadAllNotes();
  const cats = state.categories || [];
  const catById = Object.fromEntries(cats.map(c => [c.id, c]));

  // Group by category group, then sort by category name within group.
  const grouped = {};
  for (const [cid, text] of Object.entries(notes)) {
    if (!text || !text.trim()) continue;
    const cat = cid === "jd_session"
      ? { id: cid, name: state.jdTitle || "Job Description", group: "Job Description" }
      : (catById[cid] || { id: cid, name: cid, group: "Uncategorized" });
    (grouped[cat.group] ||= []).push({ cat, text });
  }
  for (const g of Object.keys(grouped)) {
    grouped[g].sort((a, b) => a.cat.name.localeCompare(b.cat.name));
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Interview Prepper — Notes`,
    ``,
    `_Exported ${today}_`,
    ``,
  ];
  const groupOrder = Object.keys(grouped).sort();
  if (groupOrder.length === 0) {
    lines.push(`_No notes saved yet._`, ``);
  }
  for (const g of groupOrder) {
    lines.push(`## ${g}`, ``);
    for (const { cat, text } of grouped[g]) {
      lines.push(`### ${cat.name}`, ``, text.trim(), ``);
    }
  }
  const md = lines.join("\n");

  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `interview-prepper-notes-${today}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
