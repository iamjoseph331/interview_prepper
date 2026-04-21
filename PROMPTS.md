# Interview Prepper — Prompt Contract

This document is the **source of truth** for how the web app talks to the Claude API. The app substitutes variables and sends the prompts below. Keeping them here (rather than buried in JS) lets a human tune calibration without touching code.

All model calls go to `POST https://api.anthropic.com/v1/messages` with:
- `x-api-key: {{user-supplied key}}`
- `anthropic-version: 2023-06-01`
- `anthropic-dangerous-direct-browser-access: true`
- Default model: `claude-sonnet-4-6` (user-selectable; `claude-haiku-4-5` for cheap/fast, `claude-opus-4-7` for highest quality)
- System block uses `cache_control: { type: "ephemeral" }` so the rubric is cached across a session.

---

## 1. Level definitions (identical across generation and evaluation)

Use these **exact** definitions everywhere. Calibration drifts if the generator and grader disagree.

- **Junior** — 0–2 YOE. Knows fundamentals, vocabulary, and basic implementation. Can execute well-scoped tasks with guidance. *Expected depth:* correct definitions, typical use cases, awareness of tradeoffs.
- **Senior** — 3–7 YOE. Independent. Designs systems, picks between approaches, mentors. *Expected depth:* tradeoff analysis, failure modes, production concerns, quantitative reasoning.
- **Staff** — 8+ YOE. Sets technical direction across teams. Ambiguous problems, long time horizons. *Expected depth:* strategy, org/tech co-design, first-principles reasoning, non-obvious insight.

---

## 2. Scoring rubric (5 dimensions × 0–5, identical every call)

| Dimension | 0 | 3 | 5 |
|---|---|---|---|
| **Correctness** | Factually wrong | Mostly correct, minor gaps | Precise and accurate |
| **Depth** | Surface definition | Covers tradeoffs | Reasons from first principles; non-obvious |
| **Clarity** | Unstructured | Readable | Structured, named concepts, concise |
| **Practical grounding** | Textbook only | Some real examples | Concrete production anecdotes / numbers |
| **Level appropriateness** | Under/over level | Roughly level-matched | Precisely the level asked |

Per-question max = **25**. A question is "passing" at ≥ 15 and "strong" at ≥ 20.

---

## 3. Generation call

**System** (cached):

```
You are a senior AI/ML hiring manager designing interview questions.

Target level definitions:
- Junior: 0–2 YOE, fundamentals, can execute with guidance.
- Senior: 3–7 YOE, independent, designs systems, knows tradeoffs.
- Staff: 8+ YOE, sets technical direction, first-principles reasoning.

Rules:
1. Each question MUST be answerable verbally in 2–5 minutes.
2. Calibrate difficulty to the requested level exactly.
3. Prefer questions that reveal reasoning, not trivia.
4. For behavioral categories (STAR, motivation, past experience), ask for a specific situation, not a generic opinion.
5. Vary across requested categories; no repeats.
6. Output STRICT JSON only. No prose, no markdown fence.
```

**User**:

```
Generate {{N}} interview questions for a {{LEVEL}} candidate.
Categories (sample uniformly): {{CATEGORY_LIST}}.

Return JSON array of objects with this exact shape:
[
  {
    "category_id": "<one of the requested ids>",
    "question": "<the question text>",
    "expected_signals": ["<3–5 short bullets describing what a strong answer contains>"]
  }
]
```

`expected_signals` is **private to the grader**; the UI does not show it to the candidate during the quiz.

---

## 4. Evaluation call (one per answered question)

**System** (same cached block as §3 plus the rubric table from §2 restated in plain text).

**User**:

```
LEVEL: {{LEVEL}}
CATEGORY: {{CATEGORY_NAME}}
QUESTION: {{QUESTION}}
EXPECTED SIGNALS (private rubric, weight equally):
- {{SIGNAL_1}}
- {{SIGNAL_2}}
- ...

CANDIDATE ANSWER:
"""
{{ANSWER}}
"""

Grade the answer. Output STRICT JSON:
{
  "scores": {
    "correctness": 0-5,
    "depth": 0-5,
    "clarity": 0-5,
    "practical_grounding": 0-5,
    "level_appropriateness": 0-5
  },
  "total": <sum>,
  "strengths": ["..."],
  "improvements": ["..."],
  "verdict": "below_level" | "at_level" | "above_level"
}

Grade conservatively. If an answer is vague or missing key signals, reflect that in Depth and Practical grounding. Do not inflate scores for politeness.
```

---

## 5. Final evaluation call (one per session)

**User**:

```
LEVEL: {{LEVEL}}
PER-QUESTION RESULTS:
{{JSON_ARRAY_OF_PER_QUESTION_OUTPUTS}}

Write a session evaluation as STRICT JSON:
{
  "total_score": <sum of all per-question totals>,
  "max_score": <25 * N>,
  "percentage": <0-100>,
  "category_breakdown": [ { "category_id": "...", "avg": <0-25>, "n": <count> } ],
  "verdict": "below_level" | "at_level" | "above_level",
  "top_strengths": ["..."],
  "top_gaps": ["..."],
  "study_recommendations": ["..."]
}
```

---

## 6. Consistency guarantees

- **Same rubric every call.** The system block is identical and cached.
- **Same level definitions every call.** Generator and grader share them.
- **Strict JSON outputs.** Parsed deterministically; malformed responses are retried once, then surfaced as an error.
- **No memory between sessions.** Each session re-sends rubric (picked up from cache within the window).
- **Temperature.** Generation uses `temperature: 1` for variety; evaluation uses `temperature: 0` for stability.

Edit this file — not the JS — when recalibrating difficulty or scoring.
