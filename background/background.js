// EVChan Translator - Background Service Worker
// Manages content script injection and translation request routing

import { translateText, translateTextBatch, translateHtml } from '../lib/api.js';
import { retryAsync } from '../lib/retry.js';

const DEFAULT_SETTINGS = {
  apiEndpoint: '',
  model: '',
  targetLanguage: '',
};

// Track per-tab AbortControllers for in-flight cancellation
const abortControllers = new Map();

/**
 * Clean up per-tab resources when a tab is closed.
 * Prevents memory leaks from stale AbortControllers and unbounded storage keys.
 */
function cleanupTab(tabId) {
  abortControllers.get(tabId)?.abort();
  abortControllers.delete(tabId);
  chrome.storage.local.remove(`_translationState-${tabId}`).catch(() => {});
}

// Listen for tab removal to prevent memory leaks
chrome.tabs.onRemoved.addListener(cleanupTab);

/**
 * Load settings from storage, applying defaults for missing values.
 */
async function loadSettings() {
  const result = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...result };
}

/**
 * Save settings to storage.
 */
async function saveSettings(settings) {
  await chrome.storage.local.set(settings);
}

/**
 * Send a message to the content script in a specific tab.
 * Retries with backoff to handle content script load timing (e.g., after page navigation).
 */
async function sendMessageToContent(tabId, message) {
  try {
    return await retryAsync(() => chrome.tabs.sendMessage(tabId, message), 3, 500);
  } catch {
    return null;
  }
}

/**
 * Get the storage key for per-tab translation state.
 */
function translationStateKey(tabId) {
  return `_translationState-${tabId}`;
}

/**
 * Store translation state for a specific tab.
 */
async function setTranslationState(tabId, state) {
  await chrome.storage.local.set({
    [translationStateKey(tabId)]: state,
  });
}

/**
 * Get translation state for a specific tab.
 */
async function getTranslationState(tabId) {
  const result = await chrome.storage.local.get(translationStateKey(tabId));
  return result[translationStateKey(tabId)] ?? null;
}

/**
 * Handle translation requests from the popup.
 */
async function handleTranslate(tabId, settings) {
  // Send translation request to content script (always loaded via manifest)
  const response = await sendMessageToContent(tabId, {
    type: 'TRANSLATE_REQUEST',
    settings,
  });

  return response || { success: false, error: 'No response from content script' };
}

/**
 * Handle restore requests from the popup.
 */
async function handleRestore(tabId) {
  const response = await sendMessageToContent(tabId, {
    type: 'RESTORE_REQUEST',
  });

  return response || { success: false, error: 'No response from content script' };
}

/**
 * Handle progress updates from the content script.
 */
function handleProgress(progress) {
  // Relay progress to any open popup via storage
  chrome.storage.local.set({ _translationProgress: progress }).catch(() => {});
}

// Listen for messages from popup and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ success: false, error: 'Unauthorized' });
      return;
    }
    try {
      switch (message.type) {
        case 'LOAD_SETTINGS': {
          const settings = await loadSettings();
          sendResponse(settings);
          break;
        }

        case 'SAVE_SETTINGS': {
          await saveSettings(message.settings);
          sendResponse({ success: true });
          break;
        }

        case 'TRANSLATE': {
          const tabId = message.tabId || sender.tab?.id;
          if (!tabId) {
            sendResponse({ success: false, error: 'No active tab' });
            break;
          }
          // Create fresh AbortController for this translation session
          abortControllers.set(tabId, new AbortController());

          // Persist per-tab state so popup can recover if closed during translation
          await setTranslationState(tabId, {
            state: 'translating',
            tabId,
            timestamp: Date.now(),
          });

          const result = await handleTranslate(tabId, message.settings);

          // Update per-tab state with result
          if (result.success) {
            await setTranslationState(tabId, {
              state: 'translated',
              tabId,
              translatedCount: result.translatedCount,
              failedCount: result.failedCount,
              timestamp: Date.now(),
            });
          } else {
            await setTranslationState(tabId, {
              state: 'ready',
              tabId,
              timestamp: Date.now(),
            });
          }

          sendResponse(result);
          break;
        }

        case 'RESTORE': {
          const tabId = message.tabId || sender.tab?.id;
          if (!tabId) {
            sendResponse({ success: false, error: 'No active tab' });
            break;
          }
          // Abort any in-flight translation for this tab
          abortControllers.get(tabId)?.abort();
          abortControllers.delete(tabId);
          const result = await handleRestore(tabId);

          // Always reset to ready state after restore (clears stale 'translated' state)
          await setTranslationState(tabId, {
            state: 'ready',
            tabId,
            timestamp: Date.now(),
          });

          sendResponse(result);
          break;
        }

        case 'PROGRESS': {
          handleProgress(message.progress);
          sendResponse({ acknowledged: true });
          break;
        }

        case 'TRANSLATE_CHUNK': {
          const tabId = sender.tab?.id;
          const controller = tabId ? abortControllers.get(tabId) : undefined;
          if (controller?.signal.aborted) {
            sendResponse({ success: false, error: 'Cancelled' });
            break;
          }
          try {
            const translated = await translateText(
              message.settings.apiEndpoint,
              message.settings.model,
              message.text,
              message.settings.targetLanguage,
              message.sourceLang,
              controller?.signal,
              message.pageTitle
            );
            sendResponse({ success: true, translated });
          } catch (error) {
            sendResponse({
              success: false,
              error: error.name === 'AbortError' ? 'Cancelled' : error.message,
            });
          }
          break;
        }

        case 'TRANSLATE_CHUNK_BATCH': {
          const tabId = sender.tab?.id;
          const controller = tabId ? abortControllers.get(tabId) : undefined;
          if (controller?.signal.aborted) {
            sendResponse({ success: false, error: 'Cancelled' });
            break;
          }
          try {
            const translated = await translateTextBatch(
              message.settings.apiEndpoint,
              message.settings.model,
              message.texts,
              message.settings.targetLanguage,
              message.sourceLang,
              controller?.signal,
              message.pageTitle
            );
            sendResponse({ success: true, translated });
          } catch (error) {
            sendResponse({
              success: false,
              error: error.name === 'AbortError' ? 'Cancelled' : error.message,
            });
          }
          break;
        }

        case 'TRANSLATE_HTML': {
          const tabId = sender.tab?.id;
          const controller = tabId ? abortControllers.get(tabId) : undefined;
          if (controller?.signal.aborted) {
            sendResponse({ success: false, error: 'Cancelled' });
            break;
          }
          try {
            const translated = await translateHtml(
              message.settings.apiEndpoint,
              message.settings.model,
              message.html,
              message.settings.targetLanguage,
              message.sourceLang,
              controller?.signal,
              message.pageTitle
            );
            sendResponse({ success: true, translated });
          } catch (error) {
            sendResponse({
              success: false,
              error: error.name === 'AbortError' ? 'Cancelled' : error.message,
            });
          }
          break;
        }

        case 'CANCEL_TRANSLATION': {
          const tabId = message.tabId || sender.tab?.id;
          if (tabId) {
            // Forward cancel signal to content script so shouldCancel is set
            chrome.tabs.sendMessage(tabId, { type: 'CANCEL_TRANSLATION' }).catch(() => {});
            // Abort any in-flight API calls
            abortControllers.get(tabId)?.abort();
          }
          sendResponse({ success: true });
          break;
        }

        case 'ABORT_TRANSLATION': {
          const tabId = message.tabId || sender.tab?.id;
          if (tabId) {
            abortControllers.get(tabId)?.abort();
            // Keep the aborted controller in the map so subsequent
            // TRANSLATE_CHUNK calls see the aborted state.
            // It will be replaced on the next TRANSLATE or cleaned up on RESTORE.
          }
          sendResponse({ success: true });
          break;
        }

        case 'GET_TRANSLATION_STATE': {
          const tabId = message.tabId || sender.tab?.id;
          const state = tabId ? await getTranslationState(tabId) : null;
          sendResponse({ success: true, state });
          break;
        }

        case 'CONTENT_LOADED': {
          // Content script loaded on a new page; clear stale state for this tab only.
          const tabId = message.tabId || sender.tab?.id;
          if (tabId) {
            await setTranslationState(tabId, {
              state: 'ready',
              tabId,
              timestamp: Date.now(),
            });
          }
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  // Return true to send response asynchronously
  return true;
});
