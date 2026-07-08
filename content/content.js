// EVChan Translator - Content Script
// Handles DOM traversal, text extraction, translation, and restoration

const HIGHLIGHT_CLASS = 'evchan-translated';
const FAILED_CLASS = 'evchan-failed';
const HIGHLIGHT_COLOR = '#fff59d';
const HIGHLIGHT_DURATION = 3000; // ms
const MESSAGE_RETRY_DELAY = 300; // ms to wait before retrying a message
const BATCH_CHAR_LIMIT = 1_000; // target character count per batch
const MAX_BATCH_ITEMS = 20; // safety cap on items per batch

// Track state
let isTranslating = false;
let shouldCancel = false;

/**
 * Cached selection ancestor element, populated on `selectionchange` events.
 * The browser clears window.getSelection() when the extension popup opens
 * (focus shift), so we cache the ancestor at selection time for later use.
 * @type {Element | null}
 */
let cachedSelectionAncestor = null;

/**
 * Store original HTML content for elements with structural children.
 * Uses Map to avoid storing HTML as data attributes (prevents tampering).
 * Cleared on each translation cycle (clearStaleTranslationState, restoreOriginals).
 * @type {Map<Element, {type: string, value: string}>}
 */
const originalContentMap = new Map();

/**
 * Tracks elements that were translated, for O(k) restore instead of O(n) DOM walk.
 * Only contains elements that were actually modified during translation.
 * @type {Set<Element>}
 */
const translatedElements = new Set();

/**
 * Send a message to the background with one retry on null response or exception.
 * MV3 service workers can be terminated when idle, causing sendMessage
 * to return null or throw. This mirrors the retry pattern in the background script.
 */
async function sendMessageWithRetry(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response !== null) {
      return response;
    }
  } catch {
    // Service worker may be terminated; will retry below.
  }

  // Service worker may be cold-starting; wait and retry once.
  await new Promise((r) => setTimeout(r, MESSAGE_RETRY_DELAY));
  return chrome.runtime.sendMessage(message);
}

/** @returns {{ isTranslating: boolean, shouldCancel: boolean }} */
function getTranslationState() {
  return { isTranslating, shouldCancel };
}

/** @param {boolean} val */
function setShouldCancel(val) {
  shouldCancel = val;
}

/**
 * Get page context for translation prompts.
 * Returns page title trimmed, falling back to URL if title is empty.
 * @returns {{ pageTitle: string }}
 */
function getPageContext() {
  const title = document.title?.trim();
  const pageTitle = title || document.location.href;
  return { pageTitle };
}

/**
 * Detect the page language from HTML metadata.
 * Checks `<html lang="XX">` first, then falls back to meta tags.
 * Returns the primary language subtag (e.g., "en" from "en-US") or undefined.
 * @returns {string | undefined}
 */
function detectPageLanguage() {
  // Check <html lang="XX">
  const htmlLang = document.documentElement.lang;
  if (htmlLang) {
    return htmlLang.split('-')[0].toLowerCase();
  }

  // Check <meta http-equiv="content-language" content="XX">
  const contentLangMeta = document.querySelector('meta[http-equiv="content-language"]');
  if (contentLangMeta && contentLangMeta.content) {
    return contentLangMeta.content.split(',')[0].split('-')[0].toLowerCase().trim();
  }

  // Check <meta name="language" content="XX">
  const languageMeta = document.querySelector('meta[name="language"]');
  if (languageMeta && languageMeta.content) {
    return languageMeta.content.split('-')[0].toLowerCase().trim();
  }

  return undefined;
}

/**
 * Check if an element is visible and should be translated.
 * @param {Element} element - Element to check
 * @param {CSSStyleDeclaration} [style] - Pre-computed computed style (optional; avoids re-query)
 * @returns {boolean}
 */
function isVisible(element, style) {
  const computedStyle = style || window.getComputedStyle(element);
  return (
    computedStyle.display !== 'none' &&
    computedStyle.visibility !== 'hidden' &&
    computedStyle.opacity !== '0' &&
    element.offsetWidth > 0 &&
    element.offsetHeight > 0
  );
}

/**
 * Check if an element should be skipped (e.g., scripts, styles, inputs).
 */
function shouldSkipElement(element) {
  const tag = element.tagName.toLowerCase();
  const skipTags = ['script', 'style', 'textarea', 'input', 'select', 'button', 'noscript', 'code'];
  return skipTags.includes(tag) || !!element.closest(skipTags.join(','));
}

/**
 * Check if an element has direct text node children with non-empty content.
 * This excludes pure container elements that only inherit text from descendants.
 * TEXT_NODE nodeType is 3.
 */
function hasDirectText(element) {
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (child.nodeType === 3 && child.textContent.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Get only the direct text of an element (text node children),
 * excluding text inside child elements like <script>.
 * This avoids polluting translation with script code.
 */
function getDirectText(element) {
  let text = '';
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (child.nodeType === 3) {
      text += child.textContent;
    }
  }
  return text;
}

/**
 * Check if an element has any child elements.
 * If so, replacing the parent's textContent would destroy these children.
 */
function hasStructuralChildren(element) {
  return element.children.length > 0;
}

/**
 * Check if the user has an active (non-collapsed) text selection.
 * Uses the cached selection ancestor (populated on selectionchange)
 * because the browser clears window.getSelection() when the popup opens.
 * @returns {{ hasSelection: boolean }}
 */
function hasSelection() {
  // Read cache directly. The selectionchange handler keeps it up-to-date.
  // Do NOT call updateSelectionCache() here because the browser clears
  // window.getSelection() when the popup opens, which would wipe the cache.
  return { hasSelection: cachedSelectionAncestor !== null };
}

/**
 * Update the cached selection ancestor from the live window selection.
 * Called on selectionchange events. Clears the cache when the selection
 * is invalid (collapsed, empty, or inside a non-translatable element).
 */
function updateSelectionCache() {
  // Clear cache first; repopulate below if selection is valid.
  cachedSelectionAncestor = null;

  const selection = window.getSelection();
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return;
  }

  const container = selection.getRangeAt(0).commonAncestorContainer;
  if (!container) {
    return;
  }

  // Skip if selection is inside a non-translatable element
  const ancestorEl = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
  if (ancestorEl && !shouldSkipElement(ancestorEl)) {
    cachedSelectionAncestor = ancestorEl;
  }
}

/**
 * Get the cached common ancestor Element of the last text selection.
 * Returns null when there is no valid cached selection.
 * @returns {Element | null}
 */
function getSelectionAncestor() {
  return cachedSelectionAncestor;
}

/**
 * Clear the cached selection. Called after translation or on page navigation.
 */
function clearSelectionCache() {
  cachedSelectionAncestor = null;
}

/**
 * Extract all translatable text nodes from the DOM.
 * Only accepts leaf elements that have direct text content,
 * avoiding parent containers whose textContent replacement would destroy child structure.
 * Structural children of accepted elements are skipped — the parent handles them
 * via HTML-based translation to preserve context for correct word ordering.
 * Returns an array of { element, text, originalText } objects.
 * @param {Element} [root=document.body] - Root element to scope extraction (default: document.body)
 */
function extractTextNodes(root = document.body) {
  const nodes = [];
  // Track elements that were accepted and have direct text.
  // Their structural children will be skipped since the parent handles them.
  const processedWithDirectText = new Set();

  /**
   * Check if a node should be accepted for extraction.
   * Returns 'accept', 'skip', or 'reject'.
   */
  function evaluateNode(node) {
    // Skip non-content elements (scripts, styles, inputs, etc.)
    if (shouldSkipElement(node)) {
      return 'reject';
    }

    const style = window.getComputedStyle(node);

    // display: contents elements have no box of their own; skip the element
    // but still walk its descendants
    if (style.display === 'contents') {
      return 'skip';
    }

    // Skip hidden elements
    if (!isVisible(node, style)) {
      return 'reject';
    }

    // Skip elements with no text content
    if (node.textContent.trim().length === 0) {
      return 'reject';
    }

    // Only accept elements with direct text nodes.
    // Pure containers inherit text from descendants but replacing their
    // textContent would destroy nested HTML structure.
    if (!hasDirectText(node)) {
      return 'skip';
    }

    // Skip if an ancestor was already accepted with direct text and has children.
    let parent = node.parentElement;
    while (parent) {
      if (processedWithDirectText.has(parent) && parent.children.length > 0) {
        return 'skip';
      }
      parent = parent.parentElement;
    }

    return 'accept';
  }

  /**
   * Process an accepted node: save original content and add to results.
   */
  function processNode(node) {
    if (hasDirectText(node)) {
      processedWithDirectText.add(node);
    }

    const text = getDirectText(node);
    if (text.trim().length > 0) {
      const hasSavedHtml = originalContentMap.has(node);
      const hasSavedText = node.hasAttribute('data-original-text');
      if (!hasSavedHtml && !hasSavedText) {
        if (hasStructuralChildren(node)) {
          originalContentMap.set(node, { type: 'html', value: node.innerHTML });
        } else {
          node.setAttribute('data-original-text', text);
        }
        translatedElements.add(node);
      }
      nodes.push({ element: node, text });
    }
  }

  // Evaluate the root element first (TreeWalker.nextNode() skips the root).
  const rootResult = evaluateNode(root);
  if (rootResult === 'accept') {
    processNode(root);
  }

  // If root was rejected, don't walk descendants.
  if (rootResult === 'reject') {
    return nodes;
  }

  // Walk descendants (root was 'skip' or 'accept', both allow walking children).
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const result = evaluateNode(node);
      if (result === 'accept') return NodeFilter.FILTER_ACCEPT;
      if (result === 'skip') return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    processNode(node);
    node = walker.nextNode();
  }

  return nodes;
}

/**
 * Pre-group extracted nodes into translation batches.
 * Plain text elements are grouped by character limit (~1,000) and item cap (20).
 * Elements with structural children are separated for individual HTML-based translation.
 * @param {Array<{element: Element, text: string}>} nodes
 * @returns {{
 *   plainBatches: Array<Array<{element: Element, text: string}>>,
 *   structuralElements: Array<{element: Element, text: string}>
 * }}
 */
function groupNodesIntoBatches(nodes) {
  const plainBatches = [];
  const structuralElements = [];

  let currentBatch = [];
  let currentChars = 0;

  for (const node of nodes) {
    if (hasStructuralChildren(node.element)) {
      structuralElements.push(node);
      continue;
    }

    currentBatch.push(node);
    currentChars += node.text.length;

    if (currentChars >= BATCH_CHAR_LIMIT || currentBatch.length >= MAX_BATCH_ITEMS) {
      plainBatches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
  }

  if (currentBatch.length > 0) {
    plainBatches.push(currentBatch);
  }

  return { plainBatches, structuralElements };
}

/**
 * Apply highlight class to an element.
 */
function highlightElement(element) {
  element.classList.add(HIGHLIGHT_CLASS);
  element.style.backgroundColor = HIGHLIGHT_COLOR;
}

/**
 * Remove highlight class from an element.
 */
function unhighlightElement(element) {
  element.classList.remove(HIGHLIGHT_CLASS);
  element.style.backgroundColor = '';
}

/**
 * Mark an element as failed.
 */
function markFailed(element) {
  element.classList.add(FAILED_CLASS);
  element.style.backgroundColor = '#ffcdd2'; // Light red
}

/**
 * Send progress update to background script.
 */
function sendProgress(current, total, status) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  chrome.runtime.sendMessage(
    {
      type: 'PROGRESS',
      progress: { current, total, percentage, status },
    },
    () => {} // Ignore response
  );
}

/**
 * Translate a single text segment.
 */
async function translateSegment(text, settings, sourceLang) {
  const { pageTitle } = getPageContext();
  const response = await sendMessageWithRetry({
    type: 'TRANSLATE_CHUNK',
    text,
    settings,
    sourceLang,
    pageTitle,
  });

  if (!response) {
    throw new Error('Background service unavailable');
  }

  if (!response.success) {
    throw new Error(response.error || 'Translation failed');
  }

  return response.translated;
}

/**
 * Translate multiple text segments in one API call.
 * @param {string[]} texts - Array of texts to translate
 * @param {object} settings - API settings
 * @param {string | undefined} sourceLang - Source language
 * @returns {Promise<string[]>} Array of translated texts
 */
async function translateBatch(texts, settings, sourceLang) {
  const { pageTitle } = getPageContext();
  const response = await sendMessageWithRetry({
    type: 'TRANSLATE_CHUNK_BATCH',
    texts,
    settings,
    sourceLang,
    pageTitle,
  });

  if (!response) {
    throw new Error('Background service unavailable');
  }

  if (!response.success) {
    throw new Error(response.error || 'Batch translation failed');
  }

  return response.translated;
}

/**
 * Sanitize HTML string by removing dangerous elements and attributes.
 * Prevents XSS from untrusted LLM output before DOM injection.
 * @param {string} html - Raw HTML string from LLM
 * @returns {string} Sanitized HTML string
 */
function sanitizeHtml(html) {
  if (!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove dangerous elements
  const dangerousTags = [
    'script',
    'iframe',
    'object',
    'embed',
    'link',
    'meta',
    'base',
    'style',
    'svg',
    'math',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'video',
    'audio',
    'source',
    'track',
    'picture',
  ];
  doc.querySelectorAll(dangerousTags.join(',')).forEach((el) => el.remove());

  // URL attributes that can execute code if set to javascript:/data:/vbscript:
  const urlAttrs = [
    'href',
    'src',
    'action',
    'formaction',
    'poster',
    'data',
    'background',
    'cite',
    'codebase',
    'longdesc',
    'usemap',
  ];

  // Pattern to detect dangerous URL schemes (with optional whitespace)
  const dangerousUrlPattern = /^(\s*javascript|\s*data|\s*vbscript)\s*[:;|]/i;

  // Strip event handler attributes and sanitize URL attributes
  doc.querySelectorAll('*').forEach((el) => {
    const attrs = [...el.attributes];
    attrs.forEach((attr) => {
      const name = attr.name.toLowerCase();

      // Strip all on* event handlers
      if (/^on/i.test(name)) {
        el.removeAttribute(attr.name);
        return;
      }

      // Neutralize dangerous URLs in URL-bearing attributes
      if (urlAttrs.includes(name) && dangerousUrlPattern.test(attr.value)) {
        el.setAttribute(attr.name, 'about:blank');
      }
    });
  });

  return doc.body.innerHTML;
}

/**
 * Translate the element's innerHTML as a whole, preserving HTML structure.
 * Sends full HTML to the LLM so it can produce natural word ordering
 * while keeping all tags and attributes intact.
 */
async function translateMixedContent(element, settings, sourceLang) {
  const html = element.innerHTML;
  const { pageTitle } = getPageContext();
  const response = await sendMessageWithRetry({
    type: 'TRANSLATE_HTML',
    html,
    settings,
    sourceLang,
    pageTitle,
  });

  if (!response) {
    throw new Error('Background service unavailable');
  }

  if (!response.success) {
    throw new Error(response.error || 'HTML translation failed');
  }

  element.innerHTML = sanitizeHtml(response.translated);
}

/**
 * Process translation for a single element.
 * For elements with structural children (like <a>, <code>), translates
 * each text segment individually to preserve DOM structure.
 * @returns {string | undefined} The translated text (for simple elements) or undefined (for mixed content)
 */
async function translateElement(element, originalText, settings, sourceLang) {
  let translated;

  if (hasStructuralChildren(element)) {
    // Element has structural children - translate text segments individually
    await translateMixedContent(element, settings, sourceLang);
  } else {
    // Simple element - translate the full text
    translated = await translateSegment(originalText, settings, sourceLang);
    element.textContent = translated;
  }

  // Highlight the element
  highlightElement(element);

  return translated;
}

/**
 * Process a single translation batch: send batch request, apply results,
 * retry null entries individually.
 * @returns {{ cancelled: boolean }} Whether processing was cancelled.
 */
async function processBatch(batch, texts, settings, sourceLang, results) {
  try {
    const translations = await translateBatch(texts, settings, sourceLang);

    // Apply successful translations
    for (let i = 0; i < batch.length; i++) {
      if (translations[i] !== null) {
        batch[i].element.textContent = translations[i];
        highlightElement(batch[i].element);
        results.translated.push(batch[i].element);
      }
    }

    // Retry null entries individually
    for (let i = 0; i < batch.length; i++) {
      if (shouldCancel) {
        return { cancelled: true };
      }
      if (translations[i] === null) {
        try {
          const translated = await translateSegment(texts[i], settings, sourceLang);
          batch[i].element.textContent = translated;
          highlightElement(batch[i].element);
          results.translated.push(batch[i].element);
        } catch (error) {
          console.error('Individual retry failed:', error);
          markFailed(batch[i].element);
          results.failed.push(batch[i].element);
        }
      }
    }
  } catch (error) {
    console.error('Batch translation failed, retrying individually:', error);
    // Full batch failure — retry each item individually
    for (const item of batch) {
      if (shouldCancel) {
        return { cancelled: true };
      }
      try {
        const translated = await translateSegment(item.text, settings, sourceLang);
        item.element.textContent = translated;
        highlightElement(item.element);
        results.translated.push(item.element);
      } catch (error) {
        console.error('Individual retry failed:', error);
        markFailed(item.element);
        results.failed.push(item.element);
      }
    }
  }

  return { cancelled: false };
}

/**
 * Worker: process plain text batches sequentially.
 * @param {Array<Array<{element, text}>>} plainBatches
 * @param {object} settings
 * @param {string | undefined} sourceLang
 * @param {string} langLabel
 * @param {number} total
 * @param {{translated: Element[], failed: Element[], progress: number}} shared
 */
async function processPlainBatches(plainBatches, settings, sourceLang, langLabel, total, shared) {
  for (const batch of plainBatches) {
    if (shouldCancel) {
      return { cancelled: true };
    }

    const texts = batch.map((item) => item.text);
    const batchResult = await processBatch(batch, texts, settings, sourceLang, shared);
    if (batchResult.cancelled) {
      return { cancelled: true };
    }

    shared.progress += batch.length;
    sendProgress(shared.progress, total, `Translating ${langLabel}... ${shared.progress}/${total}`);
  }

  return { cancelled: false };
}

/**
 * Worker: process structural (HTML) elements sequentially.
 * @param {Array<{element, text}>} structuralElements
 * @param {object} settings
 * @param {string | undefined} sourceLang
 * @param {string} langLabel
 * @param {number} total
 * @param {{translated: Element[], failed: Element[], progress: number}} shared
 */
async function processStructuralElements(
  structuralElements,
  settings,
  sourceLang,
  langLabel,
  total,
  shared
) {
  for (const node of structuralElements) {
    if (shouldCancel) {
      return { cancelled: true };
    }

    try {
      await translateMixedContent(node.element, settings, sourceLang);
      highlightElement(node.element);
      shared.translated.push(node.element);
      shared.progress++;
      sendProgress(
        shared.progress,
        total,
        `Translating ${langLabel}... ${shared.progress}/${total}`
      );
    } catch (error) {
      console.error('Translation failed for element:', error);
      markFailed(node.element);
      shared.failed.push(node.element);
      shared.progress++;
      sendProgress(shared.progress, total, `Error: ${shared.failed.length} failed`);
    }
  }

  return { cancelled: false };
}

/**
 * Clear all stale translation artifacts from the DOM.
 * Ensures a fresh start for the next translation by removing
 * leftover attributes, classes, and styles from previous runs.
 */
function clearStaleTranslationState() {
  // Clear tracked elements and saved content.
  translatedElements.clear();
  originalContentMap.clear();

  // Remove data-original-text attributes (simple elements).
  document.querySelectorAll('[data-original-text]').forEach((el) => {
    el.removeAttribute('data-original-text');
  });

  // Clean up leftover highlight/failed classes and inline styles.
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}, .${FAILED_CLASS}`).forEach((el) => {
    el.classList.remove(HIGHLIGHT_CLASS, FAILED_CLASS);
    el.style.backgroundColor = '';
  });
}

/**
 * Internal: translate nodes within a given root element.
 * Two-phase: collect nodes, then translate concurrently.
 * Runs plain batch translation and HTML translation in parallel (concurrency level 2).
 * @param {Element} root - Root element to scope node extraction
 * @param {object} settings - Translation settings
 * @returns {Promise<{success: boolean, translatedCount?: number, failedCount?: number, error?: string}>}
 */
async function translateNodes(root, settings) {
  if (isTranslating) {
    return { success: false, error: 'Translation already in progress' };
  }

  isTranslating = true;
  shouldCancel = false;

  try {
    // Clear stale state from any previous translation (cancelled or completed).
    // This ensures extractTextNodes reads current DOM, not leftover attributes.
    clearStaleTranslationState();

    // --- Phase 1: Collect ---
    const nodes = extractTextNodes(root);
    const total = nodes.length;

    if (total === 0) {
      return { success: false, error: 'No translatable text found' };
    }

    sendProgress(0, total, 'Collecting elements...');

    const { plainBatches, structuralElements } = groupNodesIntoBatches(nodes);

    // Detect source language from HTML metadata
    const sourceLang = detectPageLanguage();
    const langLabel = sourceLang ? `from ${sourceLang}` : 'auto-detect';

    // --- Phase 2: Translate & Display (concurrent) ---
    // Shared state for both workers (safe in single-threaded JS with async/await)
    const shared = {
      translated: [],
      failed: [],
      progress: 0,
    };

    // Run both workers concurrently
    const [batchResult, htmlResult] = await Promise.all([
      processPlainBatches(plainBatches, settings, sourceLang, langLabel, total, shared),
      processStructuralElements(structuralElements, settings, sourceLang, langLabel, total, shared),
    ]);

    // Check if either worker was cancelled
    if (batchResult.cancelled || htmlResult.cancelled || shouldCancel) {
      return { success: false, error: 'Translation cancelled' };
    }

    // Cleanup highlights (after delay)
    setTimeout(() => {
      shared.translated.forEach((el) => unhighlightElement(el));
      shared.failed.forEach((el) => el.classList.remove(FAILED_CLASS));
    }, HIGHLIGHT_DURATION);

    sendProgress(total, total, 'Translation complete');

    return {
      success: true,
      translatedCount: shared.translated.length,
      failedCount: shared.failed.length,
    };
  } finally {
    isTranslating = false;
  }
}

/**
 * Public: translate entire page (default scope).
 * @param {object} settings - Translation settings
 * @returns {Promise<{success: boolean, translatedCount?: number, failedCount?: number, error?: string}>}
 */
async function translatePage(settings) {
  return translateNodes(document.body, settings);
}

/**
 * Public: translate only the scope of the user's text selection.
 * Gets the cached selection ancestor element and scopes translation to that subtree.
 * Clears the cached selection only on successful translation.
 * @param {object} settings - Translation settings
 * @returns {Promise<{success: boolean, translatedCount?: number, failedCount?: number, error?: string}>}
 */
async function translateSelection(settings) {
  const ancestor = getSelectionAncestor();
  if (!ancestor) {
    return { success: false, error: 'No valid selection' };
  }
  const result = await translateNodes(ancestor, settings);
  if (result.success) {
    clearSelectionCache();
  }
  return result;
}

/**
 * Restore all original text content.
 * Uses translatedElements Set for O(k) restore instead of O(n) DOM walk.
 */
function restoreOriginals() {
  let restored = 0;

  // Restore from translatedElements Set (O(k) instead of O(n) DOM walk)
  for (const element of translatedElements) {
    // Check if element is still in the document
    if (!element.isConnected) {
      originalContentMap.delete(element);
      translatedElements.delete(element);
      continue;
    }

    // Structural elements saved in Map
    const saved = originalContentMap.get(element);
    if (saved && saved.type === 'html') {
      element.innerHTML = saved.value;
      element.classList.remove(HIGHLIGHT_CLASS, FAILED_CLASS);
      element.style.backgroundColor = '';
      originalContentMap.delete(element);
      translatedElements.delete(element);
      restored++;
      continue;
    }

    // Simple elements saved as data attribute
    const originalText = element.getAttribute('data-original-text');
    if (originalText !== null) {
      element.textContent = originalText;
      element.removeAttribute('data-original-text');
      element.classList.remove(HIGHLIGHT_CLASS, FAILED_CLASS);
      element.style.backgroundColor = '';
      translatedElements.delete(element);
      restored++;
    }
  }

  return { success: true, restoredCount: restored };
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  (async () => {
    try {
      switch (message.type) {
        case 'TRANSLATE_REQUEST': {
          const fn = message.scope === 'selection' ? translateSelection : translatePage;
          const result = await fn(message.settings);
          sendResponse(result);
          break;
        }

        case 'CHECK_SELECTION': {
          const result = hasSelection();
          sendResponse({ success: true, hasSelection: result.hasSelection });
          break;
        }

        case 'RESTORE_REQUEST': {
          const result = restoreOriginals();
          sendResponse(result);
          break;
        }

        case 'CANCEL_TRANSLATION': {
          shouldCancel = true;
          // Tell background to abort any in-flight API calls
          chrome.runtime.sendMessage({ type: 'ABORT_TRANSLATION' }).catch(() => {});
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      console.error('[content] error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true; // Async response
});

// Cache the selection ancestor on selectionchange events.
// This runs before the popup opens, so the selection is still live.
document.addEventListener('selectionchange', updateSelectionCache);

// Expose functions on window for testing (stripped in production builds via esbuild define)
// __EVCHAN_DEBUG__ is set to 'false' by esbuild in production, or defined in vitest config for tests.
if (typeof __EVCHAN_DEBUG__ !== 'undefined' && __EVCHAN_DEBUG__) {
  window.__evchan_content__ = {
    getTranslationState,
    setShouldCancel,
    getPageContext,
    detectPageLanguage,
    isVisible,
    shouldSkipElement,
    hasDirectText,
    getDirectText,
    hasStructuralChildren,
    translateMixedContent,
    sanitizeHtml,
    originalContentMap,
    translatedElements,
    translateBatch,
    extractTextNodes,
    groupNodesIntoBatches,
    highlightElement,
    unhighlightElement,
    markFailed,
    sendProgress,
    sendMessageWithRetry,
    translateElement,
    translatePage,
    translateNodes,
    translateSelection,
    hasSelection,
    getSelectionAncestor,
    updateSelectionCache,
    clearSelectionCache,
    cachedSelectionAncestor,
    restoreOriginals,
    clearStaleTranslationState,
  };
}

// Signal background that content script is loaded on this page.
// This clears any stale translation state from previous pages.
chrome.runtime.sendMessage({ type: 'CONTENT_LOADED' }).catch(() => {});
