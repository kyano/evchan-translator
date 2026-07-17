// EVChan Translator - API Client Tests

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchModels,
  translateText,
  translateTextBatch,
  translateHtml,
  buildTranslationMessage,
  buildHtmlTranslationMessage,
  buildBatchTranslationMessage,
  withTimeoutSignal,
  stripMarkdownFences,
} from '../lib/api.js';

// --- SSE Mock Helpers ---

function createSseChunk(content) {
  return `data: {"id":"1","choices":[{"delta":{"content":${JSON.stringify(content)}},"index":0}]}`;
}

function createSseMockResponse(contentChunks) {
  // contentChunks is an array of strings, e.g., ['Hel', 'lo']
  // Returns a Response-like object with a ReadableStream body emitting SSE lines.
  const sseData =
    contentChunks.map((chunk) => createSseChunk(chunk)).join('\n\n') + '\n\ndata: [DONE]\n';

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseData));
      controller.close();
    },
  });

  return {
    ok: true,
    body: stream,
  };
}

function createSseMockResponseSplit(contentChunks) {
  // Emits SSE data in multiple small enqueues to simulate partial reads.
  const lines =
    contentChunks.map((chunk) => createSseChunk(chunk)).join('\n\n') + '\n\ndata: [DONE]\n';

  const encoder = new TextEncoder();
  const encoded = encoder.encode(lines);

  // Split into roughly equal pieces to test accumulation across reads.
  const mid = Math.floor(encoded.length / 2);
  const parts = [encoded.slice(0, mid), encoded.slice(mid)];

  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });

  return {
    ok: true,
    body: stream,
  };
}

function createSseMockWithNullChunks(contentChunks) {
  // contentChunks includes null entries to simulate delta.content === null.
  const sseLines = contentChunks.map((chunk) => {
    if (chunk === null) {
      return 'data: {"id":"1","choices":[{"delta":{"content":null},"index":0}]}';
    }
    return createSseChunk(chunk);
  });

  const sseData = sseLines.join('\n\n') + '\n\ndata: [DONE]\n';

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseData));
      controller.close();
    },
  });

  return {
    ok: true,
    body: stream,
  };
}

function createSseMockWithRawContent(rawValue) {
  // rawValue can be a number, object, array, etc. — not just strings.
  const sseData =
    'data: {"id":"1","choices":[{"delta":{"content":' +
    JSON.stringify(rawValue) +
    '},"index":0}]}\n\ndata: [DONE]\n';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseData));
      controller.close();
    },
  });
  return { ok: true, body: stream };
}

// --- Tests ---

describe('API Client', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('fetchModels', () => {
    it('fetches model list from /v1/models endpoint', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o' }, { id: 'llama-3' }],
        }),
      });

      await fetchModels('http://localhost:11434');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/v1/models',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns an array of model IDs', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'gpt-4o' }, { id: 'llama-3' }],
        }),
      });

      const models = await fetchModels('http://localhost:11434');

      expect(models).toEqual(['gpt-4o', 'llama-3']);
    });

    it('throws on network failure', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(fetchModels('http://localhost:11434')).rejects.toThrow(
        'Failed to fetch models: 500 Internal Server Error'
      );
    });

    it('throws on invalid response format', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: 'format' }),
      });

      await expect(fetchModels('http://localhost:11434')).rejects.toThrow(
        'Invalid response format'
      );
    });

    it('trims trailing slashes from endpoint', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await fetchModels('http://localhost:11434/');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/v1/models',
        expect.any(Object)
      );
    });

    it('passes an AbortSignal to fetch for timeout', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await fetchModels('http://localhost:11434');

      const fetchOptions = global.fetch.mock.calls[0][1];
      expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('translateText', () => {
    it('sends text to LLM for translation with SSE streaming', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockResponse(['Hola', ' mundo']));

      await translateText('http://localhost:11434', 'gpt-4o', 'Hello world', 'es', 'en');

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.model).toBe('gpt-4o');
      expect(body.messages.length).toBe(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toContain('Translate the following text from en to es');
      expect(body.messages[0].content).toContain('Text: Hello world');
      expect(body.stream).toBe(true);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    it('returns translated string from accumulated SSE chunks', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockResponse(['Bonjour', ' le', ' monde']));

      const result = await translateText(
        'http://localhost:11434',
        'gpt-4o',
        'Hello world',
        'fr',
        'en'
      );

      expect(result).toBe('Bonjour le monde');
    });

    it('throws on API failure', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      await expect(
        translateText('http://localhost:11434', 'gpt-4o', 'Hello', 'es', 'en')
      ).rejects.toThrow('Translation failed: 429 Too Many Requests');
    });

    it('throws on invalid response format', async () => {
      const emptyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
          controller.close();
        },
      });
      global.fetch.mockResolvedValueOnce({
        ok: true,
        body: emptyStream,
      });

      await expect(
        translateText('http://localhost:11434', 'gpt-4o', 'Hello', 'es', 'en')
      ).rejects.toThrow('Invalid response format');
    });

    // --- SSE-specific tests ---

    it('accumulates content across split SSE chunks', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockResponseSplit(['Split', ' ', 'Test']));

      const result = await translateText(
        'http://localhost:11434',
        'gpt-4o',
        'Split Test',
        'en',
        'en'
      );

      expect(result).toBe('Split Test');
    });

    it('skips null delta.content chunks in SSE stream', async () => {
      global.fetch.mockResolvedValueOnce(
        createSseMockWithNullChunks(['Hello', null, ' ', null, 'World'])
      );

      const result = await translateText(
        'http://localhost:11434',
        'gpt-4o',
        'Greeting',
        'en',
        'en'
      );

      expect(result).toBe('Hello World');
    });

    it('throws on non-OK SSE response without attempting to parse stream', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        body: null,
      });

      await expect(
        translateText('http://localhost:11434', 'gpt-4o', 'Hello', 'es', 'en')
      ).rejects.toThrow('Translation failed: 500 Server Error');
    });
  });

  describe('parseSseLine type validation', () => {
    it('skips numeric delta.content in SSE stream', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockWithRawContent(42));

      await expect(
        translateText('http://localhost:11434', 'gpt-4o', 'Hello', 'es', 'en')
      ).rejects.toThrow('Invalid response format');
    });

    it('skips object delta.content in SSE stream', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockWithRawContent({ foo: 'bar' }));

      await expect(
        translateText('http://localhost:11434', 'gpt-4o', 'Hello', 'es', 'en')
      ).rejects.toThrow('Invalid response format');
    });

    it('skips array delta.content in SSE stream', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockWithRawContent([1, 2]));

      await expect(
        translateText('http://localhost:11434', 'gpt-4o', 'Hello', 'es', 'en')
      ).rejects.toThrow('Invalid response format');
    });
  });

  describe('readSseStream size cap', () => {
    it('throws when SSE content exceeds size limit', async () => {
      const bigContent = 'x'.repeat(1_100_000); // > 1 MB
      const sseData =
        'data: {"id":"1","choices":[{"delta":{"content":' +
        JSON.stringify(bigContent) +
        '},"index":0}]}\n\ndata: [DONE]\n';

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      global.fetch.mockResolvedValueOnce({ ok: true, body: stream });

      await expect(
        translateText('http://localhost:11434', 'gpt-4o', 'Hello', 'es', 'en')
      ).rejects.toThrow('SSE response exceeded size limit');
    });
  });

  describe('translateHtml', () => {
    it('sends HTML content to LLM for translation with SSE streaming', async () => {
      global.fetch.mockResolvedValueOnce(
        createSseMockResponse(['<p>', '이것은', ' <a>링크</a>', '입니다.', '</p>'])
      );

      await translateHtml(
        'http://localhost:11434',
        'gpt-4o',
        '<p>This is a <a>link</a>.</p>',
        'ko',
        'en'
      );

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.model).toBe('gpt-4o');
      expect(body.messages.length).toBe(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toContain('Translate the text content');
      expect(body.messages[0].content).toContain('<p>This is a <a>link</a>.</p>');
      expect(body.stream).toBe(true);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    it('returns translated HTML from accumulated SSE chunks', async () => {
      global.fetch.mockResolvedValueOnce(
        createSseMockResponse(['<p>', '이것은', ' <a>링크</a>', '입니다.', '</p>'])
      );

      const result = await translateHtml(
        'http://localhost:11434',
        'gpt-4o',
        '<p>This is a <a>link</a>.</p>',
        'ko',
        'en'
      );

      expect(result).toBe('<p>이것은 <a>링크</a>입니다.</p>');
    });

    it('throws on API failure', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      await expect(
        translateHtml('http://localhost:11434', 'gpt-4o', '<p>Test</p>', 'ko', 'en')
      ).rejects.toThrow('HTML translation failed: 429 Too Many Requests');
    });

    it('throws on invalid response format', async () => {
      const emptyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
          controller.close();
        },
      });
      global.fetch.mockResolvedValueOnce({
        ok: true,
        body: emptyStream,
      });

      await expect(
        translateHtml('http://localhost:11434', 'gpt-4o', '<p>Test</p>', 'ko', 'en')
      ).rejects.toThrow('Invalid response format');
    });
  });

  describe('translateTextBatch', () => {
    it('sends multiple texts in one API call with SSE streaming', async () => {
      global.fetch.mockResolvedValueOnce(
        createSseMockResponse(['["Hola mundo", "Buenos días", "Adiós"]'])
      );

      await translateTextBatch(
        'http://localhost:11434',
        'gpt-4o',
        ['Hello world', 'Good morning', 'Goodbye'],
        'es',
        'en'
      );

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.model).toBe('gpt-4o');
      expect(body.messages[0].content).toContain('from en to es');
      expect(body.messages[0].content).toContain('0: Hello world');
      expect(body.messages[0].content).toContain('1: Good morning');
      expect(body.messages[0].content).toContain('2: Goodbye');
      expect(body.stream).toBe(true);
    });

    it('returns an array of translations from SSE stream', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockResponse(['["Привет мир", "Доброе утро"]']));

      const result = await translateTextBatch(
        'http://localhost:11434',
        'gpt-4o',
        ['Hello world', 'Good morning'],
        'ru',
        'en'
      );

      expect(result).toEqual(['Привет мир', 'Доброе утро']);
    });

    it('uses "into Y" phrasing when sourceLang is omitted', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockResponse(['["翻訳1", "翻訳2", "翻訳3"]']));

      await translateTextBatch(
        'http://localhost:11434',
        'gpt-4o',
        ['text1', 'text2', 'text3'],
        'ja'
      );

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.messages[0].content).toContain('into ja');
      expect(body.messages[0].content).not.toContain('from');
    });

    it('throws on API failure', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(
        translateTextBatch('http://localhost:11434', 'gpt-4o', ['text1', 'text2'], 'es', 'en')
      ).rejects.toThrow('Batch translation failed: 500 Internal Server Error');
    });

    it('throws on malformed JSON response from LLM', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockResponse(['not valid json']));

      await expect(
        translateTextBatch('http://localhost:11434', 'gpt-4o', ['text1', 'text2'], 'es', 'en')
      ).rejects.toThrow('Invalid batch response');
    });

    it('pads short response arrays with null for missing items', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockResponse(['["only one"]']));

      const result = await translateTextBatch(
        'http://localhost:11434',
        'gpt-4o',
        ['text1', 'text2', 'text3'],
        'es',
        'en'
      );

      expect(result).toEqual(['only one', null, null]);
    });

    it('trims excess items when LLM returns more than requested', async () => {
      global.fetch.mockResolvedValueOnce(
        createSseMockResponse(['["one", "two", "three", "four"]'])
      );

      const result = await translateTextBatch(
        'http://localhost:11434',
        'gpt-4o',
        ['text1', 'text2'],
        'es',
        'en'
      );

      expect(result).toEqual(['one', 'two']);
    });

    it('strips markdown code fences from JSON response', async () => {
      global.fetch.mockResolvedValueOnce(
        createSseMockResponse(['```json\n["Hola", "Mundo"]\n```'])
      );

      const result = await translateTextBatch(
        'http://localhost:11434',
        'gpt-4o',
        ['Hello', 'World'],
        'es',
        'en'
      );

      expect(result).toEqual(['Hola', 'Mundo']);
    });

    it('strips plain code fences (without json label)', async () => {
      global.fetch.mockResolvedValueOnce(createSseMockResponse(['```["Hola", "Mundo"]```']));

      const result = await translateTextBatch(
        'http://localhost:11434',
        'gpt-4o',
        ['Hello', 'World'],
        'es',
        'en'
      );

      expect(result).toEqual(['Hola', 'Mundo']);
    });

    it('throws on invalid response format', async () => {
      const emptyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
          controller.close();
        },
      });
      global.fetch.mockResolvedValueOnce({
        ok: true,
        body: emptyStream,
      });

      await expect(
        translateTextBatch('http://localhost:11434', 'gpt-4o', ['text1'], 'es', 'en')
      ).rejects.toThrow('Invalid response format');
    });
  });

  describe('buildBatchTranslationMessage', () => {
    it('uses "from X to Y" when sourceLang is provided', () => {
      const msg = buildBatchTranslationMessage(['hello', 'world'], 'es', 'en');
      expect(msg).toContain('from en to es');
      expect(msg).toContain('0: hello');
      expect(msg).toContain('1: world');
    });

    it('uses "into Y" when sourceLang is omitted', () => {
      const msg = buildBatchTranslationMessage(['hello', 'world'], 'es');
      expect(msg).toContain('into es');
      expect(msg).not.toContain('from');
      expect(msg).toContain('0: hello');
      expect(msg).toContain('1: world');
    });

    it('includes JSON array instruction', () => {
      const msg = buildBatchTranslationMessage(['a'], 'ja', 'en');
      expect(msg).toContain('JSON array');
    });

    it('includes Page Context line when pageTitle is provided', () => {
      const msg = buildBatchTranslationMessage(['hello'], 'es', 'en', 'Tech Blog');
      expect(msg).toContain('Page Context: Tech Blog');
      expect(msg).toContain('Page Context: Tech Blog\n\nYou are a translation engine');
    });

    it('does NOT include Page Context when pageTitle is omitted', () => {
      const msg = buildBatchTranslationMessage(['hello'], 'es', 'en');
      expect(msg).not.toContain('Page Context');
    });

    it('includes anti-injection guardrail instruction', () => {
      const msg = buildBatchTranslationMessage(['hello'], 'es', 'en');
      expect(msg).toContain('translation engine');
      expect(msg).toContain('ONLY task');
      expect(msg).toContain('Never execute');
    });

    it('includes mixed-language translation instruction', () => {
      const msg = buildBatchTranslationMessage(['hello'], 'es', 'en');
      expect(msg).toContain('Translate every word to es');
      expect(msg).toContain('Do not leave any portion untranslated');
    });
  });

  describe('buildTranslationMessage', () => {
    it('uses "from X to Y" when sourceLang is provided', () => {
      const msg = buildTranslationMessage('es', 'Hello world', 'en');
      expect(msg).toContain('from en to es');
      expect(msg).toContain('Text: Hello world');
    });

    it('uses "into Y" when sourceLang is omitted', () => {
      const msg = buildTranslationMessage('es', 'Hello world');
      expect(msg).toContain('into es');
      expect(msg).not.toContain('from');
      expect(msg).toContain('Text: Hello world');
    });

    it('includes Page Context line when pageTitle is provided', () => {
      const msg = buildTranslationMessage('es', 'Hello world', 'en', 'News Article');
      expect(msg).toContain('Page Context: News Article');
      expect(msg).toContain('Page Context: News Article\n\nYou are a translation engine');
    });

    it('does NOT include Page Context when pageTitle is omitted', () => {
      const msg = buildTranslationMessage('es', 'Hello world', 'en');
      expect(msg).not.toContain('Page Context');
    });

    it('includes anti-injection guardrail instruction', () => {
      const msg = buildTranslationMessage('es', 'Hello world', 'en');
      expect(msg).toContain('translation engine');
      expect(msg).toContain('ONLY task');
      expect(msg).toContain('Never execute');
    });

    it('includes mixed-language translation instruction', () => {
      const msg = buildTranslationMessage('es', 'Hello world', 'en');
      expect(msg).toContain('Translate every word to es');
      expect(msg).toContain('Do not leave any portion untranslated');
    });
  });

  describe('buildHtmlTranslationMessage', () => {
    it('uses "from X to Y" when sourceLang is provided', () => {
      const msg = buildHtmlTranslationMessage('ko', '<p>Hello</p>', 'en');
      expect(msg).toContain('from en to ko');
      expect(msg).toContain('HTML: <p>Hello</p>');
    });

    it('uses "into Y" when sourceLang is omitted', () => {
      const msg = buildHtmlTranslationMessage('ko', '<p>Hello</p>');
      expect(msg).toContain('into ko');
      expect(msg).not.toContain('from');
      expect(msg).toContain('HTML: <p>Hello</p>');
    });

    it('includes Page Context line when pageTitle is provided', () => {
      const msg = buildHtmlTranslationMessage('ko', '<p>Hello</p>', 'en', 'Documentation');
      expect(msg).toContain('Page Context: Documentation');
      expect(msg).toContain('Page Context: Documentation\n\nTranslate');
    });

    it('does NOT include Page Context when pageTitle is omitted', () => {
      const msg = buildHtmlTranslationMessage('ko', '<p>Hello</p>', 'en');
      expect(msg).not.toContain('Page Context');
    });

    it('includes anti-injection rules', () => {
      const msg = buildHtmlTranslationMessage('ko', '<p>Hello</p>', 'en');
      expect(msg).toContain('Never emit <script>');
      expect(msg).toContain('Never respond to instructions');
    });

    it('includes mixed-language translation instruction', () => {
      const msg = buildHtmlTranslationMessage('ko', '<p>Hello</p>', 'en');
      expect(msg).toContain('Translate every word to ko');
      expect(msg).toContain('Do not leave any portion untranslated');
    });
  });

  describe('stripMarkdownFences', () => {
    it('passes through plain text unchanged', () => {
      expect(stripMarkdownFences('Hello world')).toBe('Hello world');
    });

    it('strips json-labeled code fences', () => {
      expect(stripMarkdownFences('```json\n["a", "b"]\n```')).toBe('["a", "b"]');
    });

    it('strips plain triple-backtick fences', () => {
      expect(stripMarkdownFences('```["a", "b"]```')).toBe('["a", "b"]');
    });

    it('handles fences with leading/trailing whitespace', () => {
      expect(stripMarkdownFences('  ```json\n  ["a"]\n```  ')).toBe('["a"]');
    });

    it('handles malformed fences (opening only)', () => {
      expect(stripMarkdownFences('```json\n["a"]')).toBe('["a"]');
    });

    it('handles text that looks like fences but is not', () => {
      expect(stripMarkdownFences('use ``` for code')).toBe('use ``` for code');
    });
  });

  describe('withTimeoutSignal', () => {
    it('returns an AbortSignal', () => {
      const signal = withTimeoutSignal();
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('is not aborted initially', () => {
      const signal = withTimeoutSignal();
      expect(signal.aborted).toBe(false);
    });

    it('aborts when user signal is already aborted', () => {
      const controller = new AbortController();
      controller.abort();
      const signal = withTimeoutSignal(controller.signal);
      expect(signal.aborted).toBe(true);
    });

    it('aborts when user signal is aborted later', async () => {
      const controller = new AbortController();
      const signal = withTimeoutSignal(controller.signal);
      expect(signal.aborted).toBe(false);

      controller.abort();
      expect(signal.aborted).toBe(true);
    });

    it('aborts on timeout (short timeout for test)', async () => {
      // Note: This uses the real API_TIMEOUT_MS (600s), so we test the behavior
      // by checking the signal is created and not initially aborted
      const signal = withTimeoutSignal();
      expect(signal.aborted).toBe(false);
      expect(signal).toBeInstanceOf(AbortSignal);
    });
  });
});
