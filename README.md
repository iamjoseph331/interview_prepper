# Interview Prepper

Visit https://<user>.github.io/interview_prepper/ for the demo

AI / ML / Data Science mock-interview practice, graded by Claude.

Pick a level (Junior / Senior / Staff) and one or more categories, and the app generates calibrated questions and grades your answers against a fixed rubric. Works fully in the browser — no backend.

## Run locally

```
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Source: Deploy from a branch → main / (root)**.
3. Open `https://<your-user>.github.io/<repo>/`.

That's it — everything is static. A `.nojekyll` file is included so Pages serves files verbatim.

## Modes

- **Demo mode** — no API key needed. Uses pre-baked questions from `samples.json` and shows a "strong-answer outline" after each attempt for self-comparison. No grading.
- **Graded mode** — you paste your own Anthropic API key (`sk-ant-…`). The app generates fresh questions and scores each answer on 5 dimensions (Correctness, Depth, Clarity, Practical grounding, Level appropriateness) with a final session evaluation.

### About the API key

- Your key is held only in browser `sessionStorage` for the tab and is cleared when you close it.
- It is sent only to `api.anthropic.com` — never to this repo, never to GitHub, never to any third-party server.
- The app uses the `anthropic-dangerous-direct-browser-access: true` header. The "dangerous" name refers to the risk of *developers* embedding *their own* key in shipped JS. This app does not do that — each visitor types in their own key at runtime.

## Calibration

All generation and grading prompts live in [`PROMPTS.md`](./PROMPTS.md). Edit that file (level definitions, rubric dimensions, question rules) to retune difficulty or grading strictness without touching code.

Models supported: Sonnet 4.6 (default), Haiku 4.5 (cheap/fast), Opus 4.7 (highest quality).

## File map

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js`, `ui.js` | Static SPA |
| `categories.json` | 25 testable categories, grouped |
| `samples.json` | Demo-mode questions + strong-answer outlines |
| `PROMPTS.md` | Prompt contract: level defs, rubric, templates |
| `CLAUDE.md` | Source outline of interview categories |
