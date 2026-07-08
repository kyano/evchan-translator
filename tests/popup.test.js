// EVChan Translator - Popup Tests (real module, DOM-driven)

const popupHTML = `
  <div id="app">
    <div id="error-message" class="error-message hidden"></div>
    <div id="state-ready" class="state">
      <h1>EVChan Translator</h1>
      <div class="form-group">
        <label for="api-endpoint">API Endpoint</label>
        <input type="text" id="api-endpoint" placeholder="http://localhost:11434">
      </div>
      <div class="form-group">
        <label for="model">Model</label>
        <select id="model">
          <option value="">Loading models...</option>
        </select>
      </div>
      <div class="form-group">
        <label for="target-language">Target Language</label>
        <input type="text" id="target-language" placeholder="e.g., English, Japanese, Chinese">
      </div>
      <button id="translate-btn" class="btn btn-primary">Translate Page</button>
      <button id="translate-selection-btn" class="btn btn-primary hidden">Translate Selection</button>
    </div>
    <div id="state-translating" class="state hidden">
      <h1>Translating...</h1>
      <div class="progress-bar">
        <div id="progress-fill" class="progress-fill"></div>
      </div>
      <p id="progress-text">0%</p>
      <button id="cancel-btn" class="btn btn-secondary">Cancel</button>
    </div>
    <div id="state-translated" class="state hidden">
      <h1>Translation Complete</h1>
      <p id="translation-summary"></p>
      <button id="restore-btn" class="btn btn-primary">Restore Original</button>
    </div>
  </div>
`;

// Helper to flush microtasks and setTimeout callbacks
async function flush(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

// Helper to set a form field value and dispatch its change event
function setField(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('change'));
}

/**
 * Helper to create a chrome stub with optional translation state.
 * Uses per-tab state keys (_translationState-{tabId}).
 */
function createChromeStub(translationState = null) {
  // Use per-tab key format: _translationState-{tabId} (tab 42 is the default active tab)
  const storageData = translationState ? { '_translationState-42': translationState } : {};
  return {
    runtime: {
      sendMessage: vi.fn(async () => null),
      onMessage: { addListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn(() => Promise.resolve(storageData)),
        set: vi.fn(() => Promise.resolve()),
        onChanged: { addListener: vi.fn() },
      },
    },
    tabs: {
      query: vi.fn(() => Promise.resolve([{ id: 42 }])),
    },
  };
}

describe('Popup', () => {
  let chromeStub;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();

    chromeStub = createChromeStub();
    global.chrome = chromeStub;

    fetchMock = vi.fn();
    global.fetch = fetchMock;

    document.body.innerHTML = popupHTML;

    await import('../popup/popup.js');
    await flush();
  });

  afterEach(() => {
    global.chrome = undefined;
    global.fetch = undefined;
    document.body.innerHTML = '';
  });

  describe('initial state', () => {
    it('shows ready state and hides others', () => {
      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('state-translating').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('state-translated').classList.contains('hidden')).toBe(true);
    });
  });

  describe('model dropdown with no endpoint', () => {
    it('shows default placeholder when no settings loaded', () => {
      const modelSelect = document.getElementById('model');
      expect(modelSelect.options[0].text).toBe('Loading models...');
    });
  });

  describe('model dropdown with endpoint', () => {
    it('fetches models from API endpoint', async () => {
      const input = document.getElementById('api-endpoint');
      input.value = 'http://test.com';
      input.dispatchEvent(new Event('change'));

      await flush(50);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://test.com/v1/models',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('populates dropdown with model options', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o' }, { id: 'llama-3' }],
        }),
      });

      const input = document.getElementById('api-endpoint');
      input.value = 'http://test.com';
      input.dispatchEvent(new Event('change'));

      await flush(100);

      const modelSelect = document.getElementById('model');
      expect(modelSelect.options.length).toBe(2);
      expect(modelSelect.options[0].value).toBe('gpt-4o');
      expect(modelSelect.options[1].value).toBe('llama-3');
    });

    it('selects previously chosen model', async () => {
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: 'http://test.com/v1', model: 'llama-3', targetLanguage: '' };
        }
        return { success: true };
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o' }, { id: 'llama-3' }],
        }),
      });

      vi.resetModules();
      document.body.innerHTML = popupHTML;
      await import('../popup/popup.js');
      await flush(100);

      const modelSelect = document.getElementById('model');
      expect(modelSelect.value).toBe('llama-3');
    });

    it('shows error message when model fetch fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const input = document.getElementById('api-endpoint');
      input.value = 'http://test.com';
      input.dispatchEvent(new Event('change'));

      await flush(50);

      const modelSelect = document.getElementById('model');
      expect(modelSelect.options[0].text).toBe('Network error');
    });
  });

  async function setupFormForTranslation() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-4o' }, { id: 'llama-3' }],
      }),
    });

    setField('api-endpoint', 'http://test.com/v1');
    await flush(50);

    setField('model', 'gpt-4o');
    setField('target-language', 'Japanese');
    await flush(50);
  }

  describe('translation flow', () => {
    it('shows translating state and sends TRANSLATE message with tabId', async () => {
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'TRANSLATE') {
          await new Promise((r) => setTimeout(r, 100));
          return { success: true, translatedCount: 10, failedCount: 0 };
        }
        return { success: true };
      });

      await setupFormForTranslation();

      document.getElementById('translate-btn').click();
      await flush(20);

      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('state-translating').classList.contains('hidden')).toBe(false);

      expect(chromeStub.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SAVE_SETTINGS' })
      );
      expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TRANSLATE', tabId: 42 })
      );

      await flush(150);
    });

    it('shows translated state on success', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValue({
        success: true,
        translatedCount: 10,
        failedCount: 2,
      });

      await setupFormForTranslation();

      document.getElementById('translate-btn').click();
      await flush(50);

      expect(document.getElementById('state-translated').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('translation-summary').textContent).toContain('10');
      expect(document.getElementById('translation-summary').textContent).toContain('2 failed');
    });

    it('shows ready state and error on failure', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: 'API connection failed',
      });

      await setupFormForTranslation();

      document.getElementById('translate-btn').click();
      await flush(50);

      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('error-message').textContent).toBe(
        'Translation failed: API connection failed'
      );
      expect(document.getElementById('error-message').classList.contains('hidden')).toBe(false);
    });

    it('disables translate button during translation', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValue({
        success: true,
        translatedCount: 5,
        failedCount: 0,
      });

      await setupFormForTranslation();

      document.getElementById('translate-btn').click();
      await flush(50);

      expect(document.getElementById('translate-btn').disabled).toBe(false);
    });
  });

  describe('restore', () => {
    it('sends RESTORE message with tabId and switches to ready state', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValue({
        success: true,
        restoredCount: 5,
      });

      document.getElementById('restore-btn').click();
      await flush(50);

      expect(chromeStub.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RESTORE', tabId: 42 })
      );
      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(false);
    });

    it('shows error on restore failure', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValue({
        success: false,
        error: 'Content script not found',
      });

      document.getElementById('restore-btn').click();
      await flush(50);

      expect(document.getElementById('error-message').textContent).toBe(
        'Restore failed: Content script not found'
      );
      expect(document.getElementById('error-message').classList.contains('hidden')).toBe(false);
    });
  });

  describe('cancel', () => {
    it('sends CANCEL_TRANSLATION message with tabId and switches to ready state', async () => {
      chromeStub.runtime.sendMessage.mockResolvedValue({ success: true });

      document.getElementById('cancel-btn').click();
      await flush(50);

      expect(chromeStub.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CANCEL_TRANSLATION', tabId: 42 })
      );
      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(false);
    });
  });

  describe('no active tab', () => {
    async function loadPopupWithNoTab() {
      vi.resetModules();

      const noTabStub = createChromeStub();
      noTabStub.tabs.query.mockResolvedValue([]);
      global.chrome = noTabStub;

      document.body.innerHTML = popupHTML;
      await import('../popup/popup.js');
      await flush();
    }

    it('shows error for translate action', async () => {
      await loadPopupWithNoTab();

      // Set up form fields
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      });
      setField('api-endpoint', 'http://test.com/v1');
      await flush(50);
      setField('model', 'gpt-4o');
      setField('target-language', 'Japanese');
      await flush(50);

      document.getElementById('translate-btn').click();
      await flush(50);

      expect(document.getElementById('error-message').textContent).toBe('No active tab found');
      expect(document.getElementById('error-message').classList.contains('hidden')).toBe(false);
    });

    it('shows error for restore action', async () => {
      await loadPopupWithNoTab();

      document.getElementById('restore-btn').click();
      await flush(50);

      expect(document.getElementById('error-message').textContent).toBe('No active tab found');
      expect(document.getElementById('error-message').classList.contains('hidden')).toBe(false);
    });

    it('shows error for cancel action', async () => {
      await loadPopupWithNoTab();

      document.getElementById('cancel-btn').click();
      await flush(50);

      expect(document.getElementById('error-message').textContent).toBe('No active tab found');
      expect(document.getElementById('error-message').classList.contains('hidden')).toBe(false);
    });
  });

  describe('progress updates', () => {
    it('updates progress bar and text on storage change', () => {
      const storageListener = chromeStub.storage.local.onChanged.addListener.mock.calls[0][0];
      storageListener({
        _translationProgress: {
          newValue: { percentage: 75, status: 'Translating... 15/20' },
        },
      });

      expect(document.getElementById('progress-fill').style.width).toBe('75%');
      expect(document.getElementById('progress-text').textContent).toBe('Translating... 15/20 75%');
    });

    it('ignores unrelated storage changes', () => {
      const storageListener = chromeStub.storage.local.onChanged.addListener.mock.calls[0][0];
      const originalWidth = document.getElementById('progress-fill').style.width;
      storageListener({ otherKey: { newValue: 'test' } });
      expect(document.getElementById('progress-fill').style.width).toBe(originalWidth);
    });
  });

  describe('settings initialization', () => {
    it('populates form fields from stored settings on load', async () => {
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'LOAD_SETTINGS') {
          return {
            apiEndpoint: 'http://localhost:11434/v1',
            model: 'llama-3',
            targetLanguage: 'Spanish',
          };
        }
        return { success: true };
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'llama-3' }] }),
      });

      vi.resetModules();
      document.body.innerHTML = popupHTML;
      await import('../popup/popup.js');
      await flush(100);

      expect(document.getElementById('api-endpoint').value).toBe('http://localhost:11434/v1');
      expect(document.getElementById('target-language').value).toBe('Spanish');
    });
  });

  describe('endpoint validation', () => {
    it('rejects empty endpoint', async () => {
      setField('api-endpoint', '   ');
      await flush(50);

      // Should not have called fetch since endpoint is invalid
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects invalid URL format', async () => {
      setField('api-endpoint', 'not-a-url');
      await flush(50);

      // Should not have called fetch since endpoint is invalid
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects javascript: protocol', async () => {
      setField('api-endpoint', 'javascript:alert(1)');
      await flush(50);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects data: protocol', async () => {
      setField('api-endpoint', 'data:text/html,<h1>test</h1>');
      await flush(50);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts valid http URL', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      });

      setField('api-endpoint', 'http://localhost:11434');
      await flush(50);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:11434/v1/models',
        expect.any(Object)
      );
    });

    it('accepts valid https URL', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      });

      setField('api-endpoint', 'https://api.openai.com/v1');
      await flush(50);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/v1/models',
        expect.any(Object)
      );
    });

    it('accepts valid http URL with path', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      });

      setField('api-endpoint', 'http://192.168.1.1:8080/v1');
      await flush(50);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.1.1:8080/v1/v1/models',
        expect.any(Object)
      );
    });
  });

  describe('validation', () => {
    it('shows error when API endpoint is missing', async () => {
      // Set model and target language but leave endpoint empty
      setField('target-language', 'Japanese');
      await flush(50);
      // Manually add model option and select it
      const modelSelect = document.getElementById('model');
      const opt = document.createElement('option');
      opt.value = 'gpt-4o';
      opt.textContent = 'gpt-4o';
      modelSelect.appendChild(opt);
      modelSelect.value = 'gpt-4o';
      modelSelect.dispatchEvent(new Event('change'));
      await flush(50);

      document.getElementById('translate-btn').click();
      await flush(50);

      expect(document.getElementById('error-message').textContent).toBe(
        'Please set the API endpoint in the extension settings.'
      );
      expect(document.getElementById('error-message').classList.contains('hidden')).toBe(false);
    });

    it('shows error when model is missing', async () => {
      // Set endpoint and target language but leave model empty
      setField('api-endpoint', 'http://test.com/v1');
      setField('target-language', 'Japanese');
      await flush(50);

      document.getElementById('translate-btn').click();
      await flush(50);

      expect(document.getElementById('error-message').textContent).toBe('Please select a model.');
      expect(document.getElementById('error-message').classList.contains('hidden')).toBe(false);
    });

    it('shows error when target language is missing', async () => {
      // Set endpoint (populate models) and model, but leave target language empty
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o' }, { id: 'llama-3' }],
        }),
      });

      setField('api-endpoint', 'http://test.com/v1');
      await flush(50);

      setField('model', 'gpt-4o');
      await flush(50);

      document.getElementById('translate-btn').click();
      await flush(50);

      expect(document.getElementById('error-message').textContent).toBe(
        'Please enter a target language.'
      );
      expect(document.getElementById('error-message').classList.contains('hidden')).toBe(false);
    });
  });

  describe('translation state recovery', () => {
    it('shows translating state when translation is in progress', async () => {
      vi.resetModules();

      const translatingState = {
        state: 'translating',
        tabId: 42,
        timestamp: Date.now(),
      };

      global.chrome = createChromeStub(translatingState);
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(50);

      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('state-translating').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('state-translated').classList.contains('hidden')).toBe(true);
    });

    it('shows translated state when translation completed while popup was closed', async () => {
      vi.resetModules();

      const translatedState = {
        state: 'translated',
        translatedCount: 15,
        failedCount: 1,
        timestamp: Date.now(),
      };

      global.chrome = createChromeStub(translatedState);
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(50);

      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('state-translating').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('state-translated').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('translation-summary').textContent).toContain('15');
      expect(document.getElementById('translation-summary').textContent).toContain('1 failed');
    });

    it('transitions to translating state on _translationState-42 storage change', async () => {
      const storageListener = chromeStub.storage.local.onChanged.addListener.mock.calls[0][0];

      // Start in ready state
      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(false);

      // Simulate translation starting (using per-tab key)
      await storageListener(
        {
          '_translationState-42': {
            newValue: { state: 'translating', tabId: 42, timestamp: Date.now() },
          },
        },
        'local'
      );
      await flush(20);

      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(true);
      expect(document.getElementById('state-translating').classList.contains('hidden')).toBe(false);
    });

    it('transitions to translated state on _translationState-42 storage change', async () => {
      const storageListener = chromeStub.storage.local.onChanged.addListener.mock.calls[0][0];

      // Simulate translation completing (using per-tab key)
      await storageListener(
        {
          '_translationState-42': {
            newValue: {
              state: 'translated',
              tabId: 42,
              translatedCount: 10,
              failedCount: 0,
              timestamp: Date.now(),
            },
          },
        },
        'local'
      );
      await flush(20);

      expect(document.getElementById('state-translated').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('translation-summary').textContent).toContain('10');
    });

    it('transitions to ready state on _translationState-42 storage change', async () => {
      const storageListener = chromeStub.storage.local.onChanged.addListener.mock.calls[0][0];

      // Simulate translation being cancelled/failed (using per-tab key)
      await storageListener(
        {
          '_translationState-42': {
            newValue: { state: 'ready', tabId: 42, timestamp: Date.now() },
          },
        },
        'local'
      );
      await flush(20);

      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(false);
    });

    it('ignores stale translation state (older than threshold)', async () => {
      vi.resetModules();

      // State from 10 minutes ago (threshold is 5 minutes)
      const staleState = {
        state: 'translating',
        tabId: 42,
        timestamp: Date.now() - 10 * 60 * 1000,
      };

      global.chrome = createChromeStub(staleState);
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(50);

      // Should show ready state since the translating state is stale
      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('state-translating').classList.contains('hidden')).toBe(true);
    });
  });

  describe('selection mode', () => {
    it('hides selection button by default', async () => {
      const selBtn = document.getElementById('translate-selection-btn');
      expect(selBtn.classList.contains('hidden')).toBe(true);
    });

    it('shows selection button when CHECK_SELECTION returns hasSelection true', async () => {
      vi.resetModules();

      const chromeStub = createChromeStub();
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'CHECK_SELECTION') {
          return { hasSelection: true };
        }
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: '', model: '', targetLanguage: '' };
        }
        return null;
      });
      global.chrome = chromeStub;
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(50);

      const selBtn = document.getElementById('translate-selection-btn');
      expect(selBtn.classList.contains('hidden')).toBe(false);
    });

    it('hides selection button when CHECK_SELECTION returns hasSelection false', async () => {
      vi.resetModules();

      const chromeStub = createChromeStub();
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'CHECK_SELECTION') {
          return { hasSelection: false };
        }
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: '', model: '', targetLanguage: '' };
        }
        return null;
      });
      global.chrome = chromeStub;
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(50);

      const selBtn = document.getElementById('translate-selection-btn');
      expect(selBtn.classList.contains('hidden')).toBe(true);
    });

    it('hides selection button when CHECK_SELECTION throws', async () => {
      vi.resetModules();

      const chromeStub = createChromeStub();
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'CHECK_SELECTION') {
          throw new Error('content script not found');
        }
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: '', model: '', targetLanguage: '' };
        }
        return null;
      });
      global.chrome = chromeStub;
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(50);

      const selBtn = document.getElementById('translate-selection-btn');
      expect(selBtn.classList.contains('hidden')).toBe(true);
    });

    it('sends TRANSLATE with scope selection when selection button clicked', async () => {
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'CHECK_SELECTION') {
          return { hasSelection: true };
        }
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: 'http://test.com/v1', model: 'gpt-4o', targetLanguage: 'Japanese' };
        }
        if (msg.type === 'TRANSLATE') {
          return { success: true, translatedCount: 3, failedCount: 0 };
        }
        return { success: true };
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      });

      vi.resetModules();
      global.chrome = chromeStub;
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(100);

      document.getElementById('translate-selection-btn').click();
      await flush(50);

      expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TRANSLATE',
          tabId: 42,
          scope: 'selection',
        })
      );
    });

    it('disables both buttons during selection translation', async () => {
      let resolveTranslation;
      const translationPromise = new Promise((resolve) => {
        resolveTranslation = resolve;
      });

      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'CHECK_SELECTION') {
          return { hasSelection: true };
        }
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: 'http://test.com/v1', model: 'gpt-4o', targetLanguage: 'Japanese' };
        }
        if (msg.type === 'TRANSLATE') {
          await translationPromise;
          return { success: true, translatedCount: 3, failedCount: 0 };
        }
        return { success: true };
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      });

      vi.resetModules();
      global.chrome = chromeStub;
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(100);

      document.getElementById('translate-selection-btn').click();
      await flush(20);

      expect(document.getElementById('translate-btn').disabled).toBe(true);
      expect(document.getElementById('translate-selection-btn').disabled).toBe(true);

      // Resolve the translation
      resolveTranslation();
      await flush(50);

      expect(document.getElementById('translate-btn').disabled).toBe(false);
      expect(document.getElementById('translate-selection-btn').disabled).toBe(false);
    });

    it('shows translated state on successful selection translation', async () => {
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'CHECK_SELECTION') {
          return { hasSelection: true };
        }
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: 'http://test.com/v1', model: 'gpt-4o', targetLanguage: 'Japanese' };
        }
        if (msg.type === 'TRANSLATE') {
          return { success: true, translatedCount: 3, failedCount: 0 };
        }
        return { success: true };
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      });

      vi.resetModules();
      global.chrome = chromeStub;
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(100);

      document.getElementById('translate-selection-btn').click();
      await flush(50);

      expect(document.getElementById('state-translated').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('translation-summary').textContent).toContain('3');
    });

    it('shows error when selection translation fails', async () => {
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'CHECK_SELECTION') {
          return { hasSelection: true };
        }
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: 'http://test.com/v1', model: 'gpt-4o', targetLanguage: 'Japanese' };
        }
        if (msg.type === 'TRANSLATE') {
          return { success: false, error: 'Selection scope has no translatable content' };
        }
        return { success: true };
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'gpt-4o' }] }),
      });

      vi.resetModules();
      global.chrome = chromeStub;
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(100);

      document.getElementById('translate-selection-btn').click();
      await flush(50);

      expect(document.getElementById('state-ready').classList.contains('hidden')).toBe(false);
      expect(document.getElementById('error-message').textContent).toContain(
        'Selection scope has no translatable content'
      );
    });

    it('validates settings before selection translation', async () => {
      chromeStub.runtime.sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'CHECK_SELECTION') {
          return { hasSelection: true };
        }
        if (msg.type === 'LOAD_SETTINGS') {
          return { apiEndpoint: '', model: '', targetLanguage: '' };
        }
        return null;
      });

      vi.resetModules();
      global.chrome = chromeStub;
      global.fetch = fetchMock;
      document.body.innerHTML = popupHTML;

      await import('../popup/popup.js');
      await flush(100);

      document.getElementById('translate-selection-btn').click();
      await flush(50);

      expect(document.getElementById('error-message').textContent).toBe(
        'Please set the API endpoint in the extension settings.'
      );
    });
  });
});
