# AGENTS.md — Project Guidelines for AI Agents

## Rules

1. **Always load the `superpowers` skill first** before any other work.
2. **TDD** — Write tests before implementation. Red-green-refactor. Always verify tests actually run.
3. **Use subagents** whenever possible to prevent context explosion. Keep the main agent as orchestrator.
4. **Lint and Format** — Always run `npm run lint` and `npm run format:check` after modifying code. Fix any issues before declaring changes complete.

## Project Structure

```
EVChan-Translator/
├── manifest.json           # Extension manifest (MV3)
├── package.json            # npm config, test scripts
├── build.js                # Build script (bundles and copies to dist/)
├── eslint.config.js        # ESLint configuration (flat config)
├── vitest.config.js        # Vitest config (jsdom, globals)
├── SPECS.md                # Requirements specification
├── AGENTS.md               # This file
├── README.md               # Project README
├── icons/
│   ├── icon.png            # Extension icon (PNG)
│   └── icon.svg            # Extension icon (SVG)
├── background/
│   └── background.js       # Extension background/service worker
├── content/
│   └── content.js          # Content script for DOM manipulation
├── popup/
│   ├── popup.html          # Popup UI markup
│   ├── popup.css           # Popup styles
│   └── popup.js            # Popup logic
├── lib/
│   ├── api.js              # LLM API client
│   └── retry.js            # Retry utility
└── tests/
    ├── api.test.js         # API client tests
    ├── background.test.js  # Background script tests
    ├── content.test.js     # Content script tests
    ├── popup.test.js       # Popup logic tests
    └── retry.test.js       # Retry utility tests
```

## Coding

- **Vanilla JavaScript** — No frameworks, no build step.
- **ES modules** — Use `type="module"` where applicable.

## Testing

- **Vitest + jsdom** — Run `npm test` (once) or `npm run test:watch` (watch mode).
- Tests go in `tests/`.

## Extension Notes

- **MV3 compliant.** No API key required for the LLM endpoint.
- Use `chrome.storage.local` for settings.

## Code Review

When code review is requested, perform both review tracks. Spawn a subagent when available; otherwise, use the current agent context.

1. **General Code Review** — Use the `general` subagent to review changes for correctness, style, test coverage, and overall quality. The reviewer decides: accept / request-change / deny.
2. **Security Code Review** — Use the `security-reviewer` subagent to audit for OWASP vulnerabilities, injection risks, data leakage, and compliance issues.
