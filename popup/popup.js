// EVChan Translator - Popup Logic

import { fetchModels } from '../lib/api.js';

const STATE_READY = 'ready';
const STATE_TRANSLATING = 'translating';
const STATE_TRANSLATED = 'translated';

// Consider translation state stale after 5 minutes
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Validate that the API endpoint is a well-formed HTTP/HTTPS URL.
 * Returns true if valid, false otherwise.
 */
function isValidEndpoint(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// DOM elements
const stateReady = document.getElementById('state-ready');
const stateTranslating = document.getElementById('state-translating');
const stateTranslated = document.getElementById('state-translated');
const apiEndpointInput = document.getElementById('api-endpoint');
const modelSelect = document.getElementById('model');
const targetLanguageInput = document.getElementById('target-language');
const translateBtn = document.getElementById('translate-btn');
const cancelBtn = document.getElementById('cancel-btn');
const restoreBtn = document.getElementById('restore-btn');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const translationSummary = document.getElementById('translation-summary');
const errorMessage = document.getElementById('error-message');

let currentSettings = {
  apiEndpoint: '',
  model: '',
  targetLanguage: '',
};

let _isTranslating = false;

// Cache the active tab ID at popup open time to avoid repeated chrome.tabs.query calls
let cachedTabId = null;

/**
 * Check if a translation state object is stale.
 */
function isStateStale(state) {
  if (!state || !state.timestamp) {
    return true;
  }
  return Date.now() - state.timestamp > STALE_THRESHOLD_MS;
}

/**
 * Get the storage key for per-tab translation state.
 */
function translationStateKey(tabId) {
  return `_translationState-${tabId}`;
}

/**
 * Apply a persisted translation state to the UI.
 */
function applyPersistedState(state) {
  if (!state || isStateStale(state)) {
    return;
  }

  switch (state.state) {
    case STATE_TRANSLATING:
      showState(STATE_TRANSLATING);
      break;
    case STATE_TRANSLATED:
      showState(STATE_TRANSLATED);
      translationSummary.textContent = `Translated ${state.translatedCount} elements${state.failedCount > 0 ? `, ${state.failedCount} failed` : ''}`;
      break;
    case STATE_READY:
      // No action needed - ready is the default state
      break;
  }
}

/**
 * Display an inline error message.
 */
function showError(msg) {
  errorMessage.textContent = msg;
  errorMessage.classList.remove('hidden');
}

/**
 * Hide the inline error message.
 */
function hideError() {
  errorMessage.classList.add('hidden');
}

/**
 * Query the browser for the active tab ID in the current window.
 */
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/**
 * Show a specific state in the popup.
 */
function showState(state) {
  hideError();
  stateReady.classList.add('hidden');
  stateTranslating.classList.add('hidden');
  stateTranslated.classList.add('hidden');

  switch (state) {
    case STATE_READY:
      stateReady.classList.remove('hidden');
      break;
    case STATE_TRANSLATING:
      stateTranslating.classList.remove('hidden');
      break;
    case STATE_TRANSLATED:
      stateTranslated.classList.remove('hidden');
      break;
  }
}

/**
 * Load settings from background script.
 */
async function loadSettings() {
  const settings = await chrome.runtime.sendMessage({ type: 'LOAD_SETTINGS' });
  if (settings) {
    currentSettings = settings;
    apiEndpointInput.value = settings.apiEndpoint || '';
    targetLanguageInput.value = settings.targetLanguage || '';
    updateModelDropdown();
  }
}

/**
 * Save settings to background script.
 */
async function saveSettings() {
  const newSettings = {
    ...currentSettings,
    targetLanguage: targetLanguageInput.value.trim(),
  };

  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: newSettings,
  });

  currentSettings = newSettings;
}

/**
 * Update model dropdown with fetched models.
 */
async function updateModelDropdown() {
  if (!currentSettings.apiEndpoint) {
    modelSelect.innerHTML = '<option value="">Set API endpoint first</option>';
    return;
  }

  modelSelect.innerHTML = '<option value="">Loading...</option>';

  try {
    const models = await fetchModels(currentSettings.apiEndpoint);

    if (models.length === 0) {
      modelSelect.innerHTML = '<option value="">No models available</option>';
      return;
    }

    modelSelect.innerHTML = '';
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model;
      opt.textContent = model;
      if (model === currentSettings.model) {
        opt.selected = true;
      }
      modelSelect.appendChild(opt);
    }
  } catch (_error) {
    modelSelect.innerHTML = '<option value="">Network error</option>';
  }
}

/**
 * Start translation.
 */
async function startTranslation() {
  // Save current settings
  await saveSettings();

  // Validate settings
  if (!currentSettings.apiEndpoint) {
    showError('Please set the API endpoint in the extension settings.');
    return;
  }

  if (!currentSettings.model) {
    showError('Please select a model.');
    return;
  }

  if (!currentSettings.targetLanguage) {
    showError('Please enter a target language.');
    return;
  }

  const tabId = cachedTabId;
  if (!tabId) {
    showError('No active tab found');
    return;
  }

  _isTranslating = true;
  showState(STATE_TRANSLATING);
  translateBtn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      tabId,
      settings: currentSettings,
    });

    if (result.success) {
      showState(STATE_TRANSLATED);
      translationSummary.textContent = `Translated ${result.translatedCount} elements${result.failedCount > 0 ? `, ${result.failedCount} failed` : ''}`;
    } else {
      showState(STATE_READY);
      showError(`Translation failed: ${result.error}`);
    }
  } catch (error) {
    console.error('[popup] sendMessage error:', error);
    showState(STATE_READY);
    showError(`Translation failed: ${error.message}`);
  } finally {
    _isTranslating = false;
    translateBtn.disabled = false;
  }
}

/**
 * Restore original text.
 */
async function restoreOriginals() {
  const tabId = cachedTabId;
  if (!tabId) {
    showError('No active tab found');
    return;
  }

  const result = await chrome.runtime.sendMessage({ type: 'RESTORE', tabId });

  if (result.success) {
    showState(STATE_READY);
  } else {
    showError(`Restore failed: ${result.error}`);
  }
}

/**
 * Cancel translation.
 */
async function cancelTranslation() {
  const tabId = cachedTabId;
  if (!tabId) {
    showError('No active tab found');
    return;
  }

  await chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATION', tabId });
  showState(STATE_READY);
  _isTranslating = false;
  translateBtn.disabled = false;
}

// Event listeners
translateBtn.addEventListener('click', startTranslation);
cancelBtn.addEventListener('click', cancelTranslation);
restoreBtn.addEventListener('click', restoreOriginals);

// Update model list when endpoint changes
apiEndpointInput.addEventListener('change', async () => {
  const trimmed = apiEndpointInput.value.trim();
  currentSettings.apiEndpoint = trimmed;
  await saveSettings();

  if (!isValidEndpoint(trimmed)) {
    modelSelect.innerHTML = '<option value="">Invalid endpoint</option>';
    return;
  }

  updateModelDropdown();
});

modelSelect.addEventListener('change', async () => {
  currentSettings.model = modelSelect.value;
  await saveSettings();
});

targetLanguageInput.addEventListener('change', async () => {
  currentSettings.targetLanguage = targetLanguageInput.value.trim();
  await saveSettings();
});

// Listen for progress updates and state changes via storage
chrome.storage.local.onChanged.addListener(async (changes, areaName) => {
  if (changes._translationProgress && changes._translationProgress.newValue) {
    const { percentage, status } = changes._translationProgress.newValue;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = `${status} ${percentage}%`;
  }

  // Check for per-tab state changes (key pattern: _translationState-{tabId})
  if (areaName === 'local' && cachedTabId) {
    const key = translationStateKey(cachedTabId);
    if (changes[key] && changes[key].newValue) {
      applyPersistedState(changes[key].newValue);
    }
  }
});

/**
 * Initialize the popup by loading settings and checking for persisted state.
 */
async function initialize() {
  // Cache the active tab ID for the lifetime of this popup
  cachedTabId = await getActiveTabId();

  // Check for persisted translation state for the current active tab
  if (cachedTabId) {
    const key = translationStateKey(cachedTabId);
    const persistedState = await chrome.storage.local.get(key);
    if (persistedState[key]) {
      applyPersistedState(persistedState[key]);
    }
  }

  // Load settings (always needed for form fields)
  loadSettings();
}

// Initialize
initialize();
