# ClickIt agent guide

## Project focus

ClickIt is a Chrome Manifest V3 extension that answers one visible single-choice quiz question per user action. Prioritize the extension's accuracy, reliability, and simple popup/settings experience.

- `extension/background.js` coordinates answering, hotkeys, status, and cancellation.
- `extension/content.js` detects Text questions and selects page controls.
- `extension/vision.js` captures screenshots, maps coordinates, and handles Vision targets.
- `extension/core.js` holds settings, provider requests, and response validation.
- `extension/popup.*` provides the UI; `hosted.js` handles the hosted service; `config.js` holds build configuration.
- `tests/` covers extension behavior and supporting services. `scripts/package.cjs` builds `dist/extension`.
- `server/` and `site/` support hosted access and billing. Keep Stripe and deployment work scoped to tasks that need them.

## Extension behavior

- Start inference only from an explicit Answer press or hotkey. Make at most one answer selection per action; never auto-submit or follow subsequent questions.
- Preserve Text and Vision modes, saved prompts, hotkey behavior, and clear popup/toolbar feedback.
- Cancel stale decisions when the question, target, or tab changes. Reject ambiguous questions and invalid provider responses. Prevent duplicate requests and clicks.
- Keep page access user-triggered and permissions minimal. Keep credentials in trusted extension contexts, out of page scripts and logs. Never bundle server secrets.

## Coding practice

- Assume one developer maintains this project. Prefer the smallest clear solution that solves the current problem.
- Keep plain JavaScript, HTML, and CSS and follow nearby conventions. Add dependencies or frameworks only when they remove substantial complexity.
- Use direct control flow, clear names, and small cohesive functions. Extract shared code when it removes real duplication; avoid speculative abstractions and configuration.
- Keep changes focused. Remove code made obsolete by the change. Comment on non-obvious reasons, not obvious steps.
- Be proactive. Ask when intent is unclear and the answer would materially change the work.

## Validation

- Use Node.js 22.19+ and `npm ci` to install dependencies.
- Run relevant existing tests with `node --test tests/<file>.test.cjs`; run `npm test` for changes across extension modules. Add regression coverage for changed behavior.
- For Windows hotkey changes, run `npm run test:hotkey:windows`. For Worker changes, run `npm run check:worker`.
- Edit source files, then use `npm run package:extension` when a build is needed. Never edit generated `dist/` files directly.
- Use mocked provider responses for routine checks. Report what passed and any checks you could not run.
