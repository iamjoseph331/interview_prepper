/*
 * ui.js — New UI layer: level switch, category chips, stepper.
 * Patches the DOM-reading helpers so app.js works unchanged.
 */

// ── Level switch ─────────────────────────────────────
const LEVEL_HINTS = {
  Junior: "0–2 YOE · fundamentals",
  Senior: "3–7 YOE · designs systems",
  Staff:  "8+ YOE · sets direction",
};

(function initLevelSwitch() {
  const track = document.querySelector(".level-slider-track");
  const thumb  = document.getElementById("level-thumb");
  const hint   = document.getElementById("level-hint");
  const btns   = Array.from(document.querySelectorAll(".level-btn"));

  function positionThumb(activeBtn) {
    thumb.style.width     = activeBtn.offsetWidth + "px";
    thumb.style.transform = `translateX(${activeBtn.offsetLeft - 3}px)`;
  }

  function activate(btn) {
    btns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    positionThumb(btn);
    hint.textContent = LEVEL_HINTS[btn.dataset.level] || "";
    // expose on state so app.js readSetup() can pick it up
    if (window.state) window.state.level = btn.dataset.level;
  }

  btns.forEach(btn => btn.addEventListener("click", () => activate(btn)));

  // Position on first render (after fonts load)
  requestAnimationFrame(() => {
    const active = btns.find(b => b.classList.contains("active")) || btns[0];
    positionThumb(active);
  });

  // Patch readSetup to read level from the switch instead of radio buttons
  window.__getLevelFromSwitch = () => {
    const active = document.querySelector(".level-btn.active");
    return active ? active.dataset.level : "Junior";
  };
})();

// ── Category chips ───────────────────────────────────
(function patchRenderCategories() {
  // Override the renderCategories fn after app.js sets up state
  window.addEventListener("load", () => {
    // Re-render categories as chips
    renderCategoryChips();
  });

  function renderCategoryChips() {
    const container = document.getElementById("categories");
    if (!container || !window.state || !window.state.categories) return;
    const byGroup = {};
    for (const c of window.state.categories) {
      (byGroup[c.group] ||= []).push(c);
    }
    container.innerHTML = "";
    for (const group of Object.keys(byGroup)) {
      const label = document.createElement("div");
      label.className = "cat-group-label";
      label.textContent = group;
      container.appendChild(label);

      const row = document.createElement("div");
      row.className = "cat-chips-row";
      for (const c of byGroup[group]) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cat-chip-btn selected"; // default all selected
        btn.dataset.id = c.id;
        btn.textContent = c.name;
        btn.addEventListener("click", () => btn.classList.toggle("selected"));
        row.appendChild(btn);
      }
      container.appendChild(row);
    }
  }

  window.__renderCategoryChips = renderCategoryChips;
})();

// ── Stepper ──────────────────────────────────────────
(function initStepper() {
  const hidden  = document.getElementById("num-questions");
  const display = document.getElementById("num-display");
  if (!hidden || !display) return;

  function currentVal() {
    const fromHidden = parseInt(hidden.value, 10);
    if (!Number.isNaN(fromHidden)) return fromHidden;
    const fromDisplay = parseInt(display.textContent, 10);
    return Number.isNaN(fromDisplay) ? 5 : fromDisplay;
  }

  function update(v) {
    const clamped = Math.max(1, Math.min(20, v));
    display.textContent = clamped;
    hidden.value = clamped;
  }

  // initialize both sides from whichever was set
  update(currentVal());

  document.getElementById("num-dec").addEventListener("click", () => update(currentVal() - 1));
  document.getElementById("num-inc").addEventListener("click", () => update(currentVal() + 1));
})();

// ── Mode card toggle ─────────────────────────────────
(function initModeCards() {
  const toggleBtn = document.getElementById("mode-api-toggle");
  const body      = document.getElementById("mode-api-body");
  if (!toggleBtn || !body) return;
  toggleBtn.addEventListener("click", () => {
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "flex";
    toggleBtn.textContent = open ? "Configure" : "Collapse";
  });
})();

// ── Patch app.js readSetup ───────────────────────────
// Wait for app.js to define readSetup, then wrap it.
window.addEventListener("load", () => {
  const _orig = window.readSetup;
  if (typeof _orig === "function") {
    window.readSetup = function() {
      _orig();
      // Override level with switch value
      window.state.level = window.__getLevelFromSwitch();
      // Override selectedIds with chip selection
      window.state.selectedIds = new Set(
        [...document.querySelectorAll(".cat-chip-btn.selected")].map(b => b.dataset.id)
      );
    };
  }

  // Also patch cat-all / cat-none buttons
  const catAll  = document.getElementById("cat-all");
  const catNone = document.getElementById("cat-none");
  if (catAll)  catAll.onclick  = () => document.querySelectorAll(".cat-chip-btn").forEach(b => b.classList.add("selected"));
  if (catNone) catNone.onclick = () => document.querySelectorAll(".cat-chip-btn").forEach(b => b.classList.remove("selected"));

  // Show level chip in quiz
  const origRenderQ = window.renderQuestion;
  if (typeof origRenderQ === "function") {
    window.renderQuestion = function() {
      origRenderQ();
      const chip = document.getElementById("q-level-chip");
      if (chip && window.state) chip.textContent = window.state.level;
    };
  }

  // Render chips now (data may already be loaded)
  if (window.__renderCategoryChips) window.__renderCategoryChips();
});

// ── Patch results rendering for new markup ───────────
window.addEventListener("load", () => {
  const origRenderSummary = window.renderSummary;
  if (typeof origRenderSummary === "function") {
    window.renderSummary = function(f) {
      const summary = document.getElementById("summary");
      const pct = Math.round(f.percentage);
      const verdictClass = (f.verdict || "").replace(/\s+/g, "_");
      const verdictLabel = { below_level:"Below level", at_level:"At level", above_level:"Above level" }[f.verdict] || f.verdict || "";
      summary.innerHTML = `
        <div class="summary-score">${f.total_score}<span class="muted">/${f.max_score}</span> · <span class="pct">${pct}%</span></div>
        <div class="verdict-badge ${verdictClass}">${verdictLabel} · ${window.state?.level || ""}</div>
        <div class="results-section-title">Top strengths</div>
        <ul class="tight-list">${(f.top_strengths||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul>
        <div class="results-section-title">Top gaps</div>
        <ul class="tight-list">${(f.top_gaps||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul>
        <div class="results-section-title">Study recommendations</div>
        <ul class="tight-list">${(f.study_recommendations||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul>
      `;
    };
  }

  const origRenderApi = window.renderPerQuestionApi;
  if (typeof origRenderApi === "function") {
    window.renderPerQuestionApi = function(container) {
      for (const r of window.state.results) {
        const div = document.createElement("div");
        div.className = "qresult";
        const e = r.evaluation;
        const catName = window.categoryName ? window.categoryName(r.category_id) : r.category_id;
        if (!e) {
          div.innerHTML = `
            <div class="qresult-meta">
              <span class="q-cat-chip">${escapeHtml(catName)}</span>
            </div>
            <div class="qresult-question">${escapeHtml(r.question)}</div>
            <div class="qresult-answer-label">Your answer</div>
            <div class="qresult-answer">${r.skipped ? "(skipped)" : escapeHtml(r.answer)}</div>
            <p class="fine-print">Not graded.</p>`;
        } else {
          div.innerHTML = `
            <div class="qresult-meta">
              <span class="q-cat-chip">${escapeHtml(catName)}</span>
            </div>
            <div class="qresult-question">${escapeHtml(r.question)}</div>
            <div class="qresult-answer-label">Your answer</div>
            <div class="qresult-answer">${escapeHtml(r.answer)}</div>
            <div class="scores-row">
              <span class="score-pill">Correctness ${e.scores.correctness}/5</span>
              <span class="score-pill">Depth ${e.scores.depth}/5</span>
              <span class="score-pill">Clarity ${e.scores.clarity}/5</span>
              <span class="score-pill">Practical ${e.scores.practical_grounding}/5</span>
              <span class="score-pill">Level fit ${e.scores.level_appropriateness}/5</span>
              <span class="score-pill total">Total ${e.total}/25</span>
            </div>
            <div class="verdict-inline ${e.verdict}">${{below_level:"Below level",at_level:"At level",above_level:"Above level"}[e.verdict]||e.verdict}</div>
            <div class="qresult-fb-title">Strengths</div>
            <ul class="tight-list">${(e.strengths||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul>
            <div class="qresult-fb-title">Improvements</div>
            <ul class="tight-list">${(e.improvements||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul>`;
        }
        container.appendChild(div);
      }
    };
  }

  const origRenderDemo = window.renderPerQuestionDemo;
  if (typeof origRenderDemo === "function") {
    window.renderPerQuestionDemo = function(container) {
      for (const r of window.state.results) {
        const div = document.createElement("div");
        div.className = "qresult";
        const catName = window.categoryName ? window.categoryName(r.category_id) : r.category_id;
        div.innerHTML = `
          <div class="qresult-meta">
            <span class="q-cat-chip">${escapeHtml(catName)}</span>
          </div>
          <div class="qresult-question">${escapeHtml(r.question)}</div>
          <div class="qresult-answer-label">Your answer</div>
          <div class="qresult-answer">${r.skipped||!r.answer ? "(skipped)" : escapeHtml(r.answer)}</div>
          <div class="qresult-outline-label">Strong-answer outline</div>
          <ul class="tight-list">${(r.strong_answer_outline||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("")}</ul>`;
        container.appendChild(div);
      }
    };
  }
});
