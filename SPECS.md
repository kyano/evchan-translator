# EVChan Translator — Extension Specification

## Overview

A Chrome Manifest V3 WebExtension that translates web pages inline using a configurable OpenAI-compatible LLM. Triggered by a toolbar button, it replaces visible text on the active tab with translated content, with visual feedback and restore capability.

## Architecture

### Components

| Component             | Responsibility                                                       |
| --------------------- | -------------------------------------------------------------------- |
| **Background script** | Message broker, per-tab state/abort management, proxy API calls      |
| **Content script**    | DOM traversal, text extraction/replacement, visual feedback, restore |
| **Popup**             | Settings UI, status-aware states (ready → translating → translated)  |

### Communication Flow

Content scripts are auto-injected on all URLs via the manifest (not on-demand). The background script acts as a message broker and state manager.

```
User clicks toolbar button
    → Popup opens (user picks model, enters target language)
    → Popup sends message to background script
    → Background script forwards translation request to content script
    → Content script performs translation and DOM updates
    → Content script reports progress/status back to background
    → Background script relays to popup via storage
```

## Translation Flow

1. User clicks toolbar button → popup opens
2. User enters target language (free-text), selects model from fetched list
3. Content script (auto-loaded) extracts all visible text nodes from the DOM, storing originals in `data-original-text` (plain text) or `data-original-html` (structural elements) attributes
4. **Source language** — read from HTML (`<html lang="XX">`, `<meta>` tags); if unavailable, let the LLM infer it implicitly
5. **Page context** — read `document.title` (trimmed); if empty, use page URL; include in prompts as "Page Context" to improve translation quality
6. **Translation** — plain text nodes are batched dynamically by character threshold (~1,000 chars, max 20 items per API call); HTML (mixed-content) elements are translated individually; both streams run concurrently
7. **Batch fallback** — if a batch translation fails, individual items in the batch are retried one by one
8. Translated text replaces original with a temporary highlight color (hardcoded: `#fff59d` light yellow)
9. Popup shows progress during translation, then shows "Restore Original" button when complete
10. Failed elements are highlighted in red (`#ffcdd2`)
11. **Cancel** — user can cancel mid-translation via a "Cancel" button; an `AbortController` per tab aborts in-flight requests
12. **Restore clears state** — clicking "Restore Original" clears all `data-original-text`/`data-original-html` attributes, returning the page to its pre-translation state

## Prompts

### Page Context

All prompts optionally include a `Page Context` line at the beginning to help the LLM understand the page being translated. The value is `document.title` (trimmed), falling back to the page URL when the title is empty. This line is omitted if neither is available.

```
Page Context: {{pageTitle}}

<translation instruction follows>
```

### Translation Prompt (source language known)

Translates a plain text chunk when the source language is known (from HTML `lang` attribute). Returns only the translated text — no explanations, comments, or markdown.

```
Page Context: {{pageTitle}}

Translate the following text from {{sourceLang}} to {{targetLang}}. Return only the translated text. Do not add explanations, comments, or markdown formatting.

Text: {{text}}
```

### Translation Prompt (source language unknown)

Used when the HTML document has no language information. Lets the LLM infer the source language implicitly.

```
Page Context: {{pageTitle}}

Translate the following text into {{targetLang}}. Return only the translated text. Do not add explanations, comments, or markdown formatting.

Text: {{text}}
```

### HTML Translation Prompt (source language known)

Translates text content within HTML while preserving all tags and attributes. Used for elements with structural children (e.g., `<p>See <a>link</a> here</p>`) so the LLM sees full context for correct word ordering.

```
Page Context: {{pageTitle}}

Translate the text content in the following HTML from {{sourceLang}} to {{targetLang}}.

Rules:
- Translate ALL visible text content to {{targetLang}}.
- Do NOT translate text inside <code> tags — leave code as-is.
- Preserve ALL HTML tags, attributes, and structure exactly as they are.
- Do NOT add, remove, or modify any tags or attributes.
- Return ONLY the translated HTML, with no explanations or markdown.

HTML: {{html}}
```

### HTML Translation Prompt (source language unknown)

Same as above but without specifying a source language.

```
Page Context: {{pageTitle}}

Translate the text content in the following HTML into {{targetLang}}.

Rules:
- Translate ALL visible text content to {{targetLang}}.
- Do NOT translate text inside <code> tags — leave code as-is.
- Preserve ALL HTML tags, attributes, and structure exactly as they are.
- Do NOT add, remove, or modify any tags or attributes.
- Return ONLY the translated HTML, with no explanations or markdown.

HTML: {{html}}
```

### Batch Translation Prompt (source language known)

Translates multiple plain text segments in one API call. Used for batching plain text elements (dynamic batch: ~1,000 chars, max 20 items). Returns a JSON array of translations.

```
Page Context: {{pageTitle}}

Translate the following texts from {{sourceLang}} to {{targetLang}}.
Return a JSON array of translations, one per input, in the same order.
Each translation must be ONLY the translated text — do NOT include the input number, index, or any prefix.
Do not add explanations, comments, or markdown formatting.

0: {{text0}}
1: {{text1}}
2: {{text2}}
```

### Batch Translation Prompt (source language unknown)

Same as above but without specifying a source language.

```
Page Context: {{pageTitle}}

Translate the following texts into {{targetLang}}.
Return a JSON array of translations, one per input, in the same order.
Each translation must be ONLY the translated text — do NOT include the input number, index, or any prefix.
Do not add explanations, comments, or markdown formatting.

0: {{text0}}
1: {{text1}}
2: {{text2}}
```

## Settings

Persisted in `storage.local`:

| Setting          | Type   | Description                                                                               | Default                        |
| ---------------- | ------ | ----------------------------------------------------------------------------------------- | ------------------------------ |
| `apiEndpoint`    | string | OpenAI-compatible API base URL (without `/v1` path; trailing slash handled automatically) | `""` (empty, user must set)    |
| `model`          | string | Model name (fetched from `/v1/models`)                                                    | `""` (empty, user must select) |
| `targetLanguage` | string | Target language for translation                                                           | `""` (empty, user must enter)  |

**No API key** — The extension does not support API keys. The backend API is assumed to be unauthenticated.

**Highlight color** — hardcoded to `#fff59d` (not user-configurable).

## Manifest

### Permissions

| Permission  | Purpose                                                          |
| ----------- | ---------------------------------------------------------------- |
| `storage`   | `chrome.storage.local` for persisting settings and per-tab state |
| `activeTab` | Access the active tab for communication                          |
| `tabs`      | Query and interact with tabs                                     |
| `action`    | Toolbar button and popup                                         |

### Host Permissions

| Host Permission | Purpose                         |
| --------------- | ------------------------------- |
| `<all_urls>`    | Extension works on any web page |

## Key Design Decisions

| Decision            | Choice                                                                                    | Rationale                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Translation backend | OpenAI-compatible API                                                                     | Flexible, any compatible provider                                                        |
| Source language     | From HTML `lang` attribute, or inferred by LLM                                            | No API call for detection; LLM infers when unknown                                       |
| Target language     | User-set via popup free-text                                                              | Flexible, no predefined list                                                             |
| Translation scope   | All visible text nodes, active tab only                                                   | Complete translation, tab-scoped                                                         |
| Script injection    | Auto-injected via manifest on all URLs                                                    | Simpler than on-demand; content script always ready                                      |
| Batching            | Plain text batched dynamically (~1,000 chars / max 20 items per call) / innerHTML (mixed) | Reduces API calls; mixed content preserved                                               |
| Batch fallback      | Failed batches retry items individually                                                   | Graceful degradation                                                                     |
| Concurrency         | Concurrent (level 2): plain batches + HTML elements in parallel                           | Plain text batched per API call; HTML elements individual; both streams run concurrently |
| Cancellation        | Per-tab `AbortController` + abort signal propagation                                      | User can cancel mid-translation                                                          |
| State persistence   | Per-tab translation state in `storage.local`                                              | Popup recovers state if closed mid-translation                                           |
| API timeout         | 600 seconds per request                                                                   | Safari compatibility; prevents hung requests                                             |
| Error handling      | Partial success, failed highlighted in red                                                | Don't lose progress                                                                      |

## Error Handling

- **Partial failure**: If translation fails for some elements, successfully translated elements remain, failed elements are highlighted in red (`#ffcdd2`)
- **Batch fallback**: If a batch translation fails, items are retried individually
- **API errors**: Displayed in the popup status area
- **Network errors**: User sees error message, can retry
- **Cancellation**: User can cancel mid-translation; in-flight requests are aborted via `AbortController`
- **State staleness**: Popup discards per-tab state older than 5 minutes

## Non-Goals (v1)

- Keyboard shortcuts
- Selected text translation
- Multiple language pairs simultaneously
- Translation memory / history
- Export translated page
- Firefox/Safari compatibility (MV3 focus)
