# EVChan Translator

A Chrome extension that translates web pages inline using an OpenAI-compatible LLM. Click the toolbar button, pick a language, and the entire page — or just your selected text — is translated in place.

## Features

- **Page Translation** — translate all visible text on the active tab
- **Selection Translation** — translate only the scope of your text selection
- **Batch Processing** — plain text is batched for efficiency; HTML elements are translated individually with full context
- **Visual Feedback** — translated text is highlighted in yellow; failures are marked in red
- **Restore Original** — one-click restore to the page's original content
- **Cancel Anytime** — stop an in-progress translation mid-way
- **Configurable Models** — choose from available models fetched from your API endpoint

## Installation

1. Clone this repository and build the extension:

   ```bash
   npm install
   npm run build
   ```

2. Open Chrome and navigate to `chrome://extensions`.

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **Load unpacked** and select the `dist/` directory in the project folder.

5. The EVChan Translator icon will appear in your toolbar.

## Usage

### Configuration

On first use, click the extension icon and configure:

1. **API Endpoint** — enter the base URL of your OpenAI-compatible API (without `/v1`). No API key is required.
2. **Model** — select a model from the fetched list.
3. **Target Language** — enter the language you want to translate into (free text, e.g. "Japanese", "English").

Settings are saved locally and persist across sessions.

### Translate a Page

1. Navigate to the page you want to translate.
2. Click the extension icon.
3. Click **Translate Page**.
4. Translated text appears with a yellow highlight. Click **Restore Original** when done.

### Translate a Selection

1. Select the text you want to translate on the page.
2. Click the extension icon.
3. Click **Translate Selection** (appears when text is selected).
4. Only the selected scope is translated. Click **Restore Original** to revert.

## Development

### Prerequisites

- Node.js
- npm

### Commands

| Command                | Description                    |
| ---------------------- | ------------------------------ |
| `npm install`          | Install dependencies           |
| `npm test`             | Run tests once                 |
| `npm run test:watch`   | Run tests in watch mode        |
| `npm run lint`         | Lint the codebase              |
| `npm run lint:fix`     | Auto-fix lint issues           |
| `npm run format`       | Format code with Prettier      |
| `npm run format:check` | Check formatting with Prettier |
| `npm run build`        | Build extension to `dist/`     |

### Architecture

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│  Popup   │────▶│  Background  │────▶│   Content    │
│  (UI)    │◀────│  (broker)    │◀────│   (DOM)      │
└──────────┘     └──────────────┘     └──────────────┘
```

| Component      | Responsibility                                         |
| -------------- | ------------------------------------------------------ |
| **Popup**      | Settings UI, status display, translate/restore actions |
| **Background** | Message broker, per-tab state management, API calls    |
| **Content**    | DOM traversal, text extraction, translation, restore   |

### Testing

Tests are written with Vitest + jsdom and live in `tests/`. Run `npm test` to execute all tests, or `npm run test:watch` for watch mode.

### Tech Stack

- Chrome Manifest V3
- Vanilla JavaScript (ES modules)
- Vitest + jsdom (testing)
- ESLint + Prettier (code quality)
