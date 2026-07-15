// EVChan Translator - Background Script Tests
// Tests the real background/background.js module (not inline duplicates)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function createChromeStub() {
  return {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      },
    },
    tabs: {
      sendMessage: vi.fn(() => Promise.resolve({ success: true, translatedCount: 5 })),
      onRemoved: { addListener: vi.fn() },
    },
  };
}

describe('Background Script', () => {
  let chromeStub;
  let originalFetch;
  let messageHandler;
  let onRemovedHandler;

  beforeEach(async () => {
    vi.resetModules();

    originalFetch = global.fetch;
    global.fetch = vi.fn();

    chromeStub = createChromeStub();
    global.chrome = chromeStub;

    // Capture the message listener callback so we can invoke it
    messageHandler = null;
    chromeStub.runtime.onMessage.addListener.mockImplementation((fn) => {
      messageHandler = fn;
    });

    // Capture the tab removal listener callback
    onRemovedHandler = null;
    chromeStub.tabs.onRemoved.addListener.mockImplementation((fn) => {
      onRemovedHandler = fn;
    });

    // Import the real module — triggers onMessage.addListener registration
    await import('../background/background.js');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.chrome = undefined;
    messageHandler = null;
    onRemovedHandler = null;
  });

  /**
   * Helper to send a message to the background listener and get the response.
   */
  async function sendMessage(message, sender = {}) {
    const fullSender = { id: 'test-extension-id', ...sender };
    return new Promise((resolve) => {
      messageHandler(message, fullSender, resolve);
    });
  }

  describe('settings management', () => {
    it('LOAD_SETTINGS returns defaults when no settings stored', async () => {
      chromeStub.storage.local.get.mockResolvedValueOnce({});

      const response = await sendMessage({ type: 'LOAD_SETTINGS' });

      expect(response).toEqual({
        apiEndpoint: 'https://iu-llama-cpp.linecorp.com/',
        model: 'Google/Gemma-4-31B-it:Q8_0',
        targetLanguage: '한국어',
      });
    });

    it('LOAD_SETTINGS merges stored values with defaults', async () => {
      chromeStub.storage.local.get.mockResolvedValueOnce({
        apiEndpoint: 'http://localhost:11434/v1',
        model: 'llama-3',
      });

      const response = await sendMessage({ type: 'LOAD_SETTINGS' });

      expect(response.apiEndpoint).toBe('http://localhost:11434/v1');
      expect(response.model).toBe('llama-3');
      expect(response.targetLanguage).toBe('한국어');
    });

    it('SAVE_SETTINGS persists to storage and returns success', async () => {
      const response = await sendMessage({
        type: 'SAVE_SETTINGS',
        settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'Japanese' },
      });

      expect(response).toEqual({ success: true });
      expect(chromeStub.storage.local.set).toHaveBeenCalledWith({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'Japanese',
      });
    });

    it('SAVE_SETTINGS saves partial settings object', async () => {
      const response = await sendMessage({
        type: 'SAVE_SETTINGS',
        settings: { targetLanguage: 'Korean' },
      });

      expect(response).toEqual({ success: true });
      expect(chromeStub.storage.local.set).toHaveBeenCalledWith({
        targetLanguage: 'Korean',
      });
    });
  });

  describe('TRANSLATE message', () => {
    it('forwards request to content script on success (via sender.tab.id)', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });

      const response = await sendMessage(
        {
          type: 'TRANSLATE',
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        { tab: { id: 42 } }
      );

      expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: 'TRANSLATE_REQUEST',
        settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        scope: 'page',
      });
      expect(response).toEqual({ success: true, translatedCount: 10 });
    });

    it('returns error when no active tab', async () => {
      const response = await sendMessage({
        type: 'TRANSLATE',
        settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
      });

      expect(response).toEqual({ success: false, error: 'No active tab' });
    });

    it('returns error when content script returns null', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce(null);

      const response = await sendMessage(
        { type: 'TRANSLATE', tabId: 42, settings: { apiEndpoint: 'http://test.com/v1' } },
        {}
      );

      expect(response).toEqual({ success: false, error: 'No response from content script' });
    });

    it('retries message send when content script is still loading', async () => {
      chromeStub.tabs.sendMessage
        .mockRejectedValueOnce(new Error('Could not establish connection'))
        .mockRejectedValueOnce(new Error('Could not establish connection'))
        .mockRejectedValueOnce(new Error('Could not establish connection'))
        .mockResolvedValueOnce({ success: true, translatedCount: 10 });

      const response = await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      expect(chromeStub.tabs.sendMessage).toHaveBeenCalledTimes(4);
      expect(response).toEqual({ success: true, translatedCount: 10 });
    });

    it('returns error when retry also fails', async () => {
      chromeStub.tabs.sendMessage.mockRejectedValue(new Error('Could not establish connection'));

      const response = await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      expect(chromeStub.tabs.sendMessage).toHaveBeenCalledTimes(4);
      expect(response).toEqual({ success: false, error: 'No response from content script' });
    });

    it('passes scope field to content script message', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });

      const response = await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          scope: 'selection',
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: 'TRANSLATE_REQUEST',
        settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        scope: 'selection',
      });
      expect(response).toEqual({ success: true, translatedCount: 10 });
    });

    it('defaults scope to page when not provided', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });

      const response = await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: 'TRANSLATE_REQUEST',
        settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        scope: 'page',
      });
      expect(response).toEqual({ success: true, translatedCount: 10 });
    });
  });

  describe('RESTORE message', () => {
    it('sends RESTORE_REQUEST to content script (via sender.tab.id)', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, restoredCount: 3 });

      const response = await sendMessage({ type: 'RESTORE' }, { tab: { id: 42 } });

      expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'RESTORE_REQUEST' });
      expect(response).toEqual({ success: true, restoredCount: 3 });
    });

    it('returns error when no active tab', async () => {
      const response = await sendMessage({ type: 'RESTORE' });

      expect(response).toEqual({ success: false, error: 'No active tab' });
    });

    it('returns error when content script returns null', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce(null);

      const response = await sendMessage({ type: 'RESTORE', tabId: 42 }, {});

      expect(response).toEqual({ success: false, error: 'No response from content script' });
    });

    it('stores ready state after successful RESTORE (per-tab)', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({
        success: true,
        restoredCount: 5,
      });

      const response = await sendMessage({ type: 'RESTORE', tabId: 42 }, {});

      expect(response).toEqual({ success: true, restoredCount: 5 });

      // Check that storage was called with ready state for tab 42 (per-tab key)
      const storageCalls = chromeStub.storage.local.set.mock.calls;
      const stateCall = storageCalls.find(
        (call) =>
          call[0] &&
          call[0]['_translationState-42'] &&
          call[0]['_translationState-42'].state === 'ready'
      );
      expect(stateCall).toBeDefined();
    });

    it('stores ready state after failed RESTORE (per-tab)', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce(null);

      const response = await sendMessage({ type: 'RESTORE', tabId: 42 }, {});

      expect(response).toEqual({ success: false, error: 'No response from content script' });

      // Check that storage was called with ready state for tab 42 (per-tab key)
      const storageCalls = chromeStub.storage.local.set.mock.calls;
      const stateCall = storageCalls.find(
        (call) =>
          call[0] &&
          call[0]['_translationState-42'] &&
          call[0]['_translationState-42'].state === 'ready'
      );
      expect(stateCall).toBeDefined();
    });
  });

  describe('PROGRESS message', () => {
    it('stores progress and returns acknowledged', async () => {
      const response = await sendMessage({
        type: 'PROGRESS',
        progress: { current: 5, total: 10, percentage: 50, status: 'Translating...' },
      });

      expect(response).toEqual({ acknowledged: true });
      expect(chromeStub.storage.local.set).toHaveBeenCalledWith({
        _translationProgress: { current: 5, total: 10, percentage: 50, status: 'Translating...' },
      });
    });
  });

  describe('TRANSLATE_CHUNK message', () => {
    it('forwards to LLM API and returns translated text', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hola mundo' } }],
        }),
      });

      const response = await sendMessage({
        type: 'TRANSLATE_CHUNK',
        text: 'Hello world',
        settings: { apiEndpoint: 'http://test.com', model: 'gpt-4', targetLanguage: 'es' },
        sourceLang: 'en',
      });

      expect(response).toEqual({ success: true, translated: 'Hola mundo' });

      const fetchCall = global.fetch.mock.calls[0];
      expect(fetchCall[0]).toBe('http://test.com/v1/chat/completions');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('gpt-4');
      // Real lib/api.js uses a single user message (not system+user)
      expect(body.messages.length).toBe(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toContain('Translate the following text from en to es');
      expect(body.messages[0].content).toContain('Text: Hello world');
    });

    it('returns error when API fails', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const response = await sendMessage({
        type: 'TRANSLATE_CHUNK',
        text: 'Hello',
        settings: { apiEndpoint: 'http://test.com', model: 'gpt-4', targetLanguage: 'es' },
        sourceLang: 'en',
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Translation failed');
    });

    it('returns error when API response has invalid format', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [] }),
      });

      const response = await sendMessage({
        type: 'TRANSLATE_CHUNK',
        text: 'Hello',
        settings: { apiEndpoint: 'http://test.com', model: 'gpt-4', targetLanguage: 'es' },
        sourceLang: 'en',
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Invalid response format');
    });

    it('trims trailing slashes from endpoint', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hola' } }],
        }),
      });

      await sendMessage({
        type: 'TRANSLATE_CHUNK',
        text: 'Hello',
        settings: { apiEndpoint: 'http://test.com/', model: 'gpt-4', targetLanguage: 'es' },
        sourceLang: 'en',
      });

      const fetchCall = global.fetch.mock.calls[0];
      expect(fetchCall[0]).toBe('http://test.com/v1/chat/completions');
    });
  });

  describe('CHECK_SELECTION message', () => {
    it('forwards CHECK_SELECTION to content script and returns response', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ hasSelection: true });

      const response = await sendMessage({ type: 'CHECK_SELECTION' }, { tab: { id: 42 } });

      expect(chromeStub.tabs.sendMessage).toHaveBeenCalledWith(42, {
        type: 'CHECK_SELECTION',
      });
      expect(response).toEqual({ hasSelection: true });
    });

    it('returns error when no active tab', async () => {
      const response = await sendMessage({ type: 'CHECK_SELECTION' });

      expect(response).toEqual({ success: false, error: 'No active tab' });
    });

    it('returns error when content script returns null', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce(null);

      const response = await sendMessage({ type: 'CHECK_SELECTION', tabId: 42 }, {});

      expect(response).toEqual({ success: false, error: 'No response from content script' });
    });
  });

  describe('unknown message type', () => {
    it('returns error for unknown message types', async () => {
      const response = await sendMessage({ type: 'UNKNOWN_TYPE' });

      expect(response).toEqual({ success: false, error: 'Unknown message type' });
    });
  });

  describe('CANCEL_TRANSLATION', () => {
    it('forwards cancel to content script and aborts in-flight API calls', async () => {
      const tabId = 42;

      // Start translation — should create AbortController
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });
      await sendMessage(
        {
          type: 'TRANSLATE',
          tabId,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      // Cancel — should forward to content script AND abort the controller
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true });
      const cancelResponse = await sendMessage({ type: 'CANCEL_TRANSLATION', tabId }, {});

      expect(cancelResponse).toEqual({ success: true });

      // Verify tabs.sendMessage was called to forward CANCEL_TRANSLATION to content script
      const cancelCall = chromeStub.tabs.sendMessage.mock.calls.find(
        (call) => call[1] && call[1].type === 'CANCEL_TRANSLATION'
      );
      expect(cancelCall).toBeDefined();
      expect(cancelCall[0]).toBe(tabId);

      // Verify subsequent TRANSLATE_CHUNK returns cancelled (controller was aborted)
      const chunkResponse = await sendMessage(
        {
          type: 'TRANSLATE_CHUNK',
          text: 'Hello',
          settings: { apiEndpoint: 'http://test.com', model: 'gpt-4', targetLanguage: 'es' },
          sourceLang: 'en',
        },
        { tab: { id: tabId } }
      );
      expect(chunkResponse).toEqual({ success: false, error: 'Cancelled' });
    });

    it('handles CANCEL_TRANSLATION with no tab id gracefully', async () => {
      const response = await sendMessage({ type: 'CANCEL_TRANSLATION' }, {});

      expect(response).toEqual({ success: true });
    });
  });

  describe('ABORT_TRANSLATION', () => {
    it('creates AbortController on TRANSLATE and aborts on ABORT_TRANSLATION (via message.tabId)', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });

      // Start translation — should create AbortController
      await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      // Abort translation
      const abortResponse = await sendMessage({ type: 'ABORT_TRANSLATION', tabId: 42 }, {});

      expect(abortResponse).toEqual({ success: true });
    });

    it('TRANSLATE_CHUNK returns cancelled when controller is aborted', async () => {
      const tabId = 99;

      // Create AbortController via TRANSLATE
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });
      await sendMessage(
        {
          type: 'TRANSLATE',
          tabId,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      // Abort
      await sendMessage({ type: 'ABORT_TRANSLATION', tabId }, {});

      // Now TRANSLATE_CHUNK should return cancelled
      const response = await sendMessage(
        {
          type: 'TRANSLATE_CHUNK',
          text: 'Hello',
          settings: { apiEndpoint: 'http://test.com', model: 'gpt-4', targetLanguage: 'es' },
          sourceLang: 'en',
        },
        { tab: { id: tabId } }
      );

      expect(response).toEqual({ success: false, error: 'Cancelled' });
    });

    it('ABORT_TRANSLATION with no tab id is safe', async () => {
      const response = await sendMessage({ type: 'ABORT_TRANSLATION' }, {});

      expect(response).toEqual({ success: true });
    });
  });

  describe('translation state persistence', () => {
    it('stores translating state when TRANSLATE starts (per-tab)', async () => {
      // Make sendMessage hang so we can check state during translation
      const sendMessagePromise = new Promise((_) => {});
      chromeStub.tabs.sendMessage.mockReturnValue(sendMessagePromise);

      // Send TRANSLATE and check that state is set
      const _translateCall = sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      // Wait for state to be stored (happens before the async content script call)
      await new Promise((r) => setTimeout(r, 10));

      // Check that storage was called with translating state for tab 42 (per-tab key)
      const storageCalls = chromeStub.storage.local.set.mock.calls;
      const stateCall = storageCalls.find(
        (call) =>
          call[0] &&
          call[0]['_translationState-42'] &&
          call[0]['_translationState-42'].state === 'translating'
      );
      expect(stateCall).toBeDefined();
      expect(stateCall[0]['_translationState-42'].timestamp).toBeGreaterThan(0);

      // Clean up
      chromeStub.tabs.sendMessage.mockResolvedValue({ success: true, translatedCount: 10 });
    });

    it('stores translated state on TRANSLATE success (per-tab)', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({
        success: true,
        translatedCount: 10,
        failedCount: 2,
      });

      const response = await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      expect(response).toEqual({ success: true, translatedCount: 10, failedCount: 2 });

      // Check that storage was called with translated state for tab 42 (per-tab key)
      const storageCalls = chromeStub.storage.local.set.mock.calls;
      const stateCall = storageCalls.find(
        (call) =>
          call[0] &&
          call[0]['_translationState-42'] &&
          call[0]['_translationState-42'].state === 'translated'
      );
      expect(stateCall).toBeDefined();
      expect(stateCall[0]['_translationState-42'].translatedCount).toBe(10);
      expect(stateCall[0]['_translationState-42'].failedCount).toBe(2);
    });

    it('stores ready state on TRANSLATE failure (per-tab)', async () => {
      chromeStub.tabs.sendMessage.mockResolvedValueOnce(null);

      const response = await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      expect(response).toEqual({ success: false, error: 'No response from content script' });

      // Check that storage was called with ready state for tab 42 (per-tab key)
      const storageCalls = chromeStub.storage.local.set.mock.calls;
      const stateCall = storageCalls.find(
        (call) =>
          call[0] &&
          call[0]['_translationState-42'] &&
          call[0]['_translationState-42'].state === 'ready'
      );
      expect(stateCall).toBeDefined();
    });

    it('GET_TRANSLATION_STATE returns current state for the given tabId', async () => {
      // Set up storage to return a translating state for tab 42
      chromeStub.storage.local.get.mockResolvedValueOnce({
        '_translationState-42': { state: 'translating', tabId: 42, timestamp: Date.now() },
      });

      const response = await sendMessage({ type: 'GET_TRANSLATION_STATE', tabId: 42 });

      expect(response).toEqual({
        success: true,
        state: { state: 'translating', tabId: 42, timestamp: expect.any(Number) },
      });
    });

    it('GET_TRANSLATION_STATE returns null when no state stored for tab', async () => {
      chromeStub.storage.local.get.mockResolvedValueOnce({});

      const response = await sendMessage({ type: 'GET_TRANSLATION_STATE', tabId: 42 });

      expect(response).toEqual({ success: true, state: null });
    });
  });

  describe('CONTENT_LOADED message', () => {
    it('clears translation state when content script loads on new page', async () => {
      const response = await sendMessage(
        { type: 'CONTENT_LOADED', tabId: 99 },
        { tab: { id: 99 } }
      );

      expect(response).toEqual({ success: true });

      // Check that storage was called to set ready state for this tab (per-tab key)
      const storageCalls = chromeStub.storage.local.set.mock.calls;
      const stateCall = storageCalls.find(
        (call) =>
          call[0] &&
          call[0]['_translationState-99'] &&
          call[0]['_translationState-99'].state === 'ready'
      );
      expect(stateCall).toBeDefined();
    });

    it('does NOT clear translating state for another tab when a different tab loads', async () => {
      // Start translation on tab 42
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });
      await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      // Verify translating state was set for tab 42 (using per-tab key)
      const storageCallsAfterTranslate = chromeStub.storage.local.set.mock.calls;
      const translatingCall = storageCallsAfterTranslate.find(
        (call) =>
          call[0] &&
          call[0]['_translationState-42'] &&
          call[0]['_translationState-42'].state === 'translating'
      );
      expect(translatingCall).toBeDefined();

      // Now a different tab (tab 99) loads a new page
      const response = await sendMessage(
        { type: 'CONTENT_LOADED', tabId: 99 },
        { tab: { id: 99 } }
      );
      expect(response).toEqual({ success: true });

      // Check all storage calls
      const allStorageCalls = chromeStub.storage.local.set.mock.calls;

      // Tab 42's state should only be 'translating' or 'translated', never set to 'ready'
      const tab42Calls = allStorageCalls.filter(
        (call) => call[0] && call[0]['_translationState-42']
      );
      const tab42ReadyCalls = tab42Calls.filter(
        (call) => call[0]['_translationState-42'].state === 'ready'
      );
      expect(tab42ReadyCalls.length).toBe(0);

      // Tab 99 should have its own ready state
      const tab99ReadyCalls = allStorageCalls.filter(
        (call) =>
          call[0] &&
          call[0]['_translationState-99'] &&
          call[0]['_translationState-99'].state === 'ready'
      );
      expect(tab99ReadyCalls.length).toBeGreaterThan(0);
    });
  });

  describe('tab removal cleanup', () => {
    it('aborts and removes AbortController when tab is closed', async () => {
      // Start translation to create an AbortController
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });
      await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      // Simulate tab being closed
      onRemovedHandler(42);

      // After cleanup, a new TRANSLATE for the same tabId should create a fresh controller
      // (not find a stale one). Verify by starting a new translation and checking it works.
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 5 });
      const response = await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      expect(response).toEqual({ success: true, translatedCount: 5 });
    });

    it('removes per-tab storage state when tab is closed', async () => {
      // Start translation to create state
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });
      await sendMessage(
        {
          type: 'TRANSLATE',
          tabId: 42,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      // Simulate tab being closed
      onRemovedHandler(42);

      // Verify storage.remove was called with the per-tab state key
      expect(chromeStub.storage.local.remove).toHaveBeenCalledWith('_translationState-42');
    });

    it('does nothing when removed tab has no controller', async () => {
      // Simulate tab being closed without any translation
      onRemovedHandler(99);

      // Should not throw errors
      expect(chromeStub.storage.local.remove).toHaveBeenCalledWith('_translationState-99');
    });
  });

  describe('RESTORE aborts in-flight translation', () => {
    it('aborts controller and cleans up on RESTORE', async () => {
      const tabId = 55;

      // Create AbortController via TRANSLATE
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, translatedCount: 10 });
      await sendMessage(
        {
          type: 'TRANSLATE',
          tabId,
          settings: { apiEndpoint: 'http://test.com/v1', model: 'gpt-4', targetLanguage: 'en' },
        },
        {}
      );

      // Restore — should abort and clean up
      chromeStub.tabs.sendMessage.mockResolvedValueOnce({ success: true, restoredCount: 5 });
      const response = await sendMessage({ type: 'RESTORE', tabId }, {});

      expect(response).toEqual({ success: true, restoredCount: 5 });

      // Subsequent TRANSLATE_CHUNK for this tab should not find a controller
      const chunkResponse = await sendMessage(
        {
          type: 'TRANSLATE_CHUNK',
          text: 'Hello',
          settings: { apiEndpoint: 'http://test.com', model: 'gpt-4', targetLanguage: 'es' },
          sourceLang: 'en',
        },
        { tab: { id: tabId } }
      );

      // Should proceed normally (no controller means no abort check)
      // Since fetch is not mocked here, it will fail but not with 'Cancelled'
      expect(chunkResponse.error).not.toBe('Cancelled');
    });
  });
});
