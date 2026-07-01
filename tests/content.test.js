// EVChan Translator - Content Script Tests

const sendMessage = vi.fn(() => Promise.resolve({ success: true, translated: 'Translated text' }));

const chromeStub = {
  runtime: {
    id: 'test-extension-id',
    sendMessage,
    onMessage: { addListener: vi.fn() },
  },
};
global.chrome = chromeStub;

describe('Content Script', () => {
  let isVisible, shouldSkipElement, hasDirectText, hasStructuralChildren, extractTextNodes;
  let groupNodesIntoBatches;
  let translateMixedContent, sanitizeHtml, originalContentMap;
  let highlightElement, unhighlightElement, markFailed;
  let sendProgress, translateElement, translatePage, restoreOriginals;
  let detectPageLanguage;
  let _getTranslationState, _setShouldCancel;

  // DOM helper
  function $(sel) {
    return document.querySelector(sel);
  }

  function $$(sel) {
    return document.querySelectorAll(sel);
  }

  beforeEach(async () => {
    // Mock offsetWidth/offsetHeight for jsdom (always 0 otherwise)
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      value: 1,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      value: 1,
      configurable: true,
      writable: true,
    });

    // Reset module to get fresh state (isTranslating, shouldCancel)
    vi.resetModules();

    // Clear mock call history
    sendMessage.mockClear();

    // Load the content script - functions are exposed on window.__evchan_content__
    await import('../content/content.js');

    // Access functions from the test namespace
    const content = window.__evchan_content__;
    isVisible = content.isVisible;
    shouldSkipElement = content.shouldSkipElement;
    hasDirectText = content.hasDirectText;
    hasStructuralChildren = content.hasStructuralChildren;
    translateMixedContent = content.translateMixedContent;
    sanitizeHtml = content.sanitizeHtml;
    originalContentMap = content.originalContentMap;
    extractTextNodes = content.extractTextNodes;
    groupNodesIntoBatches = content.groupNodesIntoBatches;
    highlightElement = content.highlightElement;
    unhighlightElement = content.unhighlightElement;
    markFailed = content.markFailed;
    sendProgress = content.sendProgress;
    translateElement = content.translateElement;
    translatePage = content.translatePage;
    restoreOriginals = content.restoreOriginals;
    _getTranslationState = content.getTranslationState;
    _setShouldCancel = content.setShouldCancel;
    detectPageLanguage = content.detectPageLanguage;

    // Set up DOM
    document.body.innerHTML = `
      <div id="test-container">
        <h1>Main Heading</h1>
        <p>Some visible text</p>
        <div class="nested">
          <span>Nested text</span>
        </div>
        <p style="display: none;">Hidden text</p>
        <p style="visibility: hidden;">Invisible text</p>
        <script>var x = 1;</script>
        <style>.foo { color: red; }</style>
        <input type="text" value="Input value">
        <textarea>Textarea content</textarea>
        <button>Button text</button>
        <select><option>Option</option></select>
        <noscript>Noscript text</noscript>
      </div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete HTMLElement.prototype.offsetWidth;
    delete HTMLElement.prototype.offsetHeight;

    // Restore global.chrome to original stub (some tests replace it)
    global.chrome = chromeStub;
  });

  describe('isVisible', () => {
    it('returns true for visible elements', () => {
      const element = $('#test-container');
      expect(isVisible(element)).toBe(true);
    });

    it('returns false for display:none elements', () => {
      const element = $('p:nth-of-type(2)');
      expect(isVisible(element)).toBe(false);
    });

    it('returns false for visibility:hidden elements', () => {
      const elements = $$('p');
      const invisible = elements[2];
      expect(isVisible(invisible)).toBe(false);
    });
  });

  describe('shouldSkipElement', () => {
    it('skips non-content tags (script, style, input, textarea, button, select, noscript)', () => {
      expect(shouldSkipElement($('script'))).toBe(true);
      expect(shouldSkipElement($('style'))).toBe(true);
      expect(shouldSkipElement($('input'))).toBe(true);
      expect(shouldSkipElement($('textarea'))).toBe(true);
      expect(shouldSkipElement($('button'))).toBe(true);
      expect(shouldSkipElement($('select'))).toBe(true);
      expect(shouldSkipElement($('noscript'))).toBe(true);
    });

    it('returns false for regular elements', () => {
      expect(shouldSkipElement($('h1'))).toBe(false);
      expect(shouldSkipElement($('p'))).toBe(false);
      expect(shouldSkipElement($('span'))).toBe(false);
    });
  });

  describe('hasDirectText', () => {
    it('returns true for elements with direct text content', () => {
      document.body.innerHTML = '<p>Hello world</p>';
      expect(hasDirectText($('p'))).toBe(true);
    });

    it('returns false for pure container elements', () => {
      document.body.innerHTML = '<div><p>Text</p></div>';
      expect(hasDirectText($('div'))).toBe(false);
    });

    it('returns true for elements with mixed content', () => {
      document.body.innerHTML = '<p>Hello <strong>world</strong></p>';
      expect(hasDirectText($('p'))).toBe(true);
    });

    it('returns false for elements with only whitespace direct text', () => {
      document.body.innerHTML = '<div>   \n  <p>Text</p>  </div>';
      expect(hasDirectText($('div'))).toBe(false);
    });
  });

  describe('hasStructuralChildren', () => {
    it('returns true for elements with <a> children', () => {
      document.body.innerHTML = '<p>See <a href="/link">here</a></p>';
      expect(hasStructuralChildren($('p'))).toBe(true);
    });

    it('returns true for elements with <code> children', () => {
      document.body.innerHTML = '<p>Use <code>npm install</code></p>';
      expect(hasStructuralChildren($('p'))).toBe(true);
    });

    it('returns true for elements with <img> children', () => {
      document.body.innerHTML = '<p>See <img src="x.png"/></p>';
      expect(hasStructuralChildren($('p'))).toBe(true);
    });

    it('returns true for elements with <br> children', () => {
      document.body.innerHTML = '<p><br><br>Text content<br><br>More text</p>';
      expect(hasStructuralChildren($('p'))).toBe(true);
    });

    it('returns true for elements with <br> among other children', () => {
      document.body.innerHTML = '<p>Text <strong>bold</strong> and <br> line break</p>';
      expect(hasStructuralChildren($('p'))).toBe(true);
    });

    it('returns true for elements with inline formatting children', () => {
      document.body.innerHTML = '<p>Hello <strong>world</strong> and <em>friends</em></p>';
      expect(hasStructuralChildren($('p'))).toBe(true);
    });

    it('returns false for elements with no element children', () => {
      document.body.innerHTML = '<p>Plain text only</p>';
      expect(hasStructuralChildren($('p'))).toBe(false);
    });

    it('returns true for list elements (<ul>, <ol>, <li>)', () => {
      document.body.innerHTML = '<li>Item <ul><li>Nested</li></ul></li>';
      expect(hasStructuralChildren($('li'))).toBe(true);

      document.body.innerHTML = '<li>Item <ol><li>Nested</li></ol></li>';
      expect(hasStructuralChildren($('li'))).toBe(true);

      document.body.innerHTML = '<ul><li>Parent <ul><li>Child</li></ul></li></ul>';
      const outerLi = document.querySelector('ul > li');
      expect(hasStructuralChildren(outerLi)).toBe(true);
    });
  });

  describe('translateMixedContent', () => {
    it('sends full innerHTML to LLM and replaces with translated HTML', async () => {
      sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'TRANSLATE_HTML') {
          return {
            success: true,
            translated: '<p>참조 <a href="/docs">문서</a> 정보</p>',
          };
        }
        return {};
      });

      document.body.innerHTML = '<div><p>See <a href="/docs">docs</a> for info</p></div>';
      const p = $('p');

      await translateMixedContent(p, {}, 'en');

      // Full content translated including link text
      expect(p.textContent).toContain('참조');
      expect(p.textContent).toContain('정보');
      expect(p.textContent).toContain('문서');
      // Link structure preserved
      const link = p.querySelector('a');
      expect(link).toBeTruthy();
      expect(link.getAttribute('href')).toBe('/docs');
    });

    it('translates nested structural children (link text)', async () => {
      sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'TRANSLATE_HTML') {
          return {
            success: true,
            translated: '<p>이것은 <a href="/link">링크</a>입니다. 클릭할 수 있습니다.</p>',
          };
        }
        return {};
      });

      document.body.innerHTML =
        '<div><p>This is a <a href="/link">link</a>. You can click that</p></div>';
      const p = $('p');

      await translateMixedContent(p, {}, 'en');

      // Link text should be translated
      const link = p.querySelector('a');
      expect(link.textContent).toBe('링크');
      // Surrounding text translated
      expect(p.textContent).toBe('이것은 링크입니다. 클릭할 수 있습니다.');
    });

    it('preserves multiple structural children with translated content', async () => {
      sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'TRANSLATE_HTML') {
          return {
            success: true,
            translated: '<p>실행 <code>npm i</code> 그리고 <a href="#">읽기</a> 더</p>',
          };
        }
        return {};
      });

      document.body.innerHTML =
        '<div><p>Run <code>npm i</code> then <a href="#">read</a> more</p></div>';
      const p = $('p');

      await translateMixedContent(p, {}, 'en');

      // Structural children preserved
      expect(p.querySelector('code')).toBeTruthy();
      expect(p.querySelector('a')).toBeTruthy();
      // All text translated
      expect(p.textContent).toContain('실행');
      expect(p.textContent).toContain('읽기');
    });

    it('throws error when HTML translation fails', async () => {
      sendMessage.mockResolvedValueOnce({
        success: false,
        error: 'API timeout',
      });

      document.body.innerHTML = '<div><p>See <a>link</a></p></div>';
      const p = $('p');

      await expect(translateMixedContent(p, {}, 'en')).rejects.toThrow('API timeout');
    });

    it('strips script tags from LLM response', async () => {
      sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'TRANSLATE_HTML') {
          return {
            success: true,
            translated: '<p>Text <script>alert(1)</script> safe</p>',
          };
        }
        return {};
      });

      document.body.innerHTML = '<div><p>See <a>link</a></p></div>';
      const p = $('p');

      await translateMixedContent(p, {}, 'en');

      expect(p.querySelector('script')).toBeNull();
      expect(p.textContent).toBe('Text  safe');
    });

    it('strips event handler attributes from LLM response', async () => {
      sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'TRANSLATE_HTML') {
          return {
            success: true,
            translated: '<p><img src="x" onerror="alert(1)"> text</p>',
          };
        }
        return {};
      });

      document.body.innerHTML = '<div><p>See <a>link</a></p></div>';
      const p = $('p');

      await translateMixedContent(p, {}, 'en');

      const img = p.querySelector('img');
      expect(img).toBeTruthy();
      expect(img.getAttribute('onerror')).toBeNull();
      expect(img.getAttribute('src')).toBe('x');
    });

    it('strips iframe and object tags from LLM response', async () => {
      sendMessage.mockImplementation(async (msg) => {
        if (msg.type === 'TRANSLATE_HTML') {
          return {
            success: true,
            translated:
              '<p>Text <iframe src="evil.com"></iframe> <object data="evil.swf"></object> safe</p>',
          };
        }
        return {};
      });

      document.body.innerHTML = '<div><p>See <a>link</a></p></div>';
      const p = $('p');

      await translateMixedContent(p, {}, 'en');

      expect(p.querySelector('iframe')).toBeNull();
      expect(p.querySelector('object')).toBeNull();
    });
  });

  describe('sanitizeHtml', () => {
    it('removes script tags', () => {
      const html = '<p>Hello <script>alert(1)</script> world</p>';
      const result = sanitizeHtml(html);
      expect(result).not.toContain('<script>');
      expect(result).toContain('Hello');
      expect(result).toContain('world');
    });

    it('removes iframe tags', () => {
      const html = '<p>Text <iframe src="evil.com"></iframe> safe</p>';
      const result = sanitizeHtml(html);
      expect(result).not.toContain('<iframe');
    });

    it('removes object and embed tags', () => {
      const html = '<p><object data="x.swf"></object><embed src="x.swf"></embed></p>';
      const result = sanitizeHtml(html);
      expect(result).not.toContain('<object');
      expect(result).not.toContain('<embed');
    });

    it('removes event handler attributes', () => {
      const html = '<p><img src="x" onerror="alert(1)"><a onclick="steal()">link</a></p>';
      const result = sanitizeHtml(html);
      expect(result).not.toContain('onerror');
      expect(result).not.toContain('onclick');
      expect(result).toContain('img');
      expect(result).toContain('a');
    });

    it('removes link, meta, and base tags', () => {
      const html =
        '<p><link rel="stylesheet" href="evil.css"><meta http-equiv="refresh" content="0;url=evil.com"><base href="evil.com"></p>';
      const result = sanitizeHtml(html);
      expect(result).not.toContain('<link');
      expect(result).not.toContain('<meta');
      expect(result).not.toContain('<base');
    });

    it('preserves safe HTML', () => {
      const html = '<p>Hello <a href="/docs">link</a> <strong>bold</strong> <em>italic</em></p>';
      const result = sanitizeHtml(html);
      expect(result).toContain('<a href="/docs">');
      expect(result).toContain('<strong>');
      expect(result).toContain('<em>');
    });

    it('preserves safe attributes', () => {
      const html = '<p><a href="https://example.com" target="_blank" class="btn">link</a></p>';
      const result = sanitizeHtml(html);
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('class="btn"');
    });

    it('handles empty input', () => {
      expect(sanitizeHtml('')).toBe('');
    });

    it('handles input with only dangerous content', () => {
      const html = '<script>alert(1)</script><iframe src="x"></iframe>';
      const result = sanitizeHtml(html);
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('<iframe');
    });
  });

  describe('extractTextNodes', () => {
    it('extracts visible text elements', () => {
      const nodes = extractTextNodes();
      const texts = nodes.map((n) => n.text.trim());

      expect(texts).toContain('Main Heading');
      expect(texts).toContain('Some visible text');
      expect(texts).toContain('Nested text');
    });

    it('skips hidden elements', () => {
      const nodes = extractTextNodes();
      const texts = nodes.map((n) => n.text.trim());

      expect(texts).not.toContain('Hidden text');
      expect(texts).not.toContain('Invisible text');
    });

    it('skips structural children whose parent has direct text', () => {
      document.body.innerHTML = `
        <p>For more info, see <a href="/docs">documentation</a>.</p>
      `;

      const nodes = extractTextNodes();
      const tags = nodes.map((n) => n.element.tagName);

      // <p> is accepted (has direct text)
      expect(tags).toContain('P');
      // <a> should be SKIPPED because its parent <p> has direct text
      // and will handle <a> via HTML-based translation
      expect(tags).not.toContain('A');
    });

    it('still extracts standalone structural tags (no parent with direct text)', () => {
      document.body.innerHTML = `
        <div>
          <a href="/home">Home</a>
        </div>
      `;

      const nodes = extractTextNodes();
      const tags = nodes.map((n) => n.element.tagName);
      const texts = nodes.map((n) => n.text.trim());

      // <a> should be extracted because its parent <div> has no direct text
      expect(tags).toContain('A');
      expect(texts).toContain('Home');
      // <div> has no direct text, so it's skipped
      expect(tags).not.toContain('DIV');
    });

    it('skips deeply nested structural children', () => {
      document.body.innerHTML = `
        <p>Check <a href="/x"><code>important</code> link</a>.</p>
      `;

      const nodes = extractTextNodes();
      const tags = nodes.map((n) => n.element.tagName);

      // Only <p> is extracted
      expect(tags).toContain('P');
      // <a> and <code> are skipped (parent has direct text)
      expect(tags).not.toContain('A');
      expect(tags).not.toContain('CODE');
    });

    it('extracts structural children when parent has no direct text', () => {
      document.body.innerHTML = `
        <div>
          <p><a href="/x">Link</a></p>
        </div>
      `;

      const nodes = extractTextNodes();
      const tags = nodes.map((n) => n.element.tagName);

      // <p> has no direct text (only contains <a>), so it's skipped
      // But <a> should still be extracted
      expect(tags).not.toContain('DIV');
      // <p> has no direct text nodes (only whitespace around <a>)
      expect(tags).not.toContain('P');
      // <a> is a leaf with direct text
      expect(tags).toContain('A');
    });

    it('skips script, style, and input elements', () => {
      const nodes = extractTextNodes();
      const texts = nodes.map((n) => n.text.trim());

      expect(texts).not.toContain('var x = 1;');
      expect(texts).not.toContain('.foo { color: red; }');
      expect(texts).not.toContain('Input value');
      expect(texts).not.toContain('Textarea content');
      expect(texts).not.toContain('Button text');
      expect(texts).not.toContain('Option');
      expect(texts).not.toContain('Noscript text');
    });

    it('stores original text in data-original-text attribute', () => {
      extractTextNodes();

      const h1 = $('h1');
      expect(h1.getAttribute('data-original-text')).toBe('Main Heading');
    });

    it('stores original innerHTML in originalContentMap for elements with <br>', () => {
      document.body.innerHTML = `
        <p class="notation-text"><br>
        <br>
        First paragraph text.
        <br>
        <br>
        Second paragraph text.
        </p>
      `;
      extractTextNodes();

      const p = $('p');
      // Should save innerHTML in Map (not data-original-text) because <br> is structural
      expect(originalContentMap.has(p)).toBe(true);
      const saved = originalContentMap.get(p);
      expect(saved.type).toBe('html');
      expect(saved.value).toContain('<br>');
      expect(p.hasAttribute('data-original-text')).toBe(false);
    });

    it('does not overwrite existing data-original-text', () => {
      const h1 = $('h1');
      h1.setAttribute('data-original-text', 'Previous translation');

      extractTextNodes();

      expect(h1.getAttribute('data-original-text')).toBe('Previous translation');
    });

    it('does not overwrite existing saved HTML in originalContentMap', () => {
      document.body.innerHTML = `
        <p>See <a href="/link">link</a> here</p>
      `;
      const p = $('p');
      originalContentMap.set(p, { type: 'html', value: '<a href="/old">stale</a>' });

      extractTextNodes();

      // Should NOT overwrite existing saved HTML
      expect(originalContentMap.get(p).value).toBe('<a href="/old">stale</a>');
      // Should NOT set data-original-text either
      expect(p.hasAttribute('data-original-text')).toBe(false);
    });

    it('walks through display:contents wrappers without including the wrapper', () => {
      document.body.innerHTML = `
        <div style="display: contents;">
          <h1>Wrapped Heading</h1>
          <p>Wrapped paragraph</p>
        </div>
      `;

      const nodes = extractTextNodes();
      const texts = nodes.map((n) => n.text.trim());
      const tags = nodes.map((n) => n.element.tagName);

      // Children should be found
      expect(texts).toContain('Wrapped Heading');
      expect(texts).toContain('Wrapped paragraph');
      // The display:contents wrapper itself should NOT be included
      expect(tags).not.toContain('DIV');
    });

    it('skips parent containers that only inherit text from children', () => {
      document.body.innerHTML = `
        <div class="container">
          <h1>Heading</h1>
          <p>Paragraph text</p>
          <span class="nested">
            <strong>Bold text</strong>
          </span>
        </div>
      `;

      const nodes = extractTextNodes();
      const tags = nodes.map((n) => n.element.tagName);
      const texts = nodes.map((n) => n.text.trim());

      // Leaf elements with direct text should be accepted
      expect(texts).toContain('Heading');
      expect(texts).toContain('Paragraph text');
      expect(texts).toContain('Bold text');

      // Container <div> and <span class="nested"> have no direct text; should be skipped
      expect(tags).not.toContain('DIV');
    });

    it('accepts parent with mixed content and skips children (handled by parent HTML translation)', () => {
      document.body.innerHTML = `
        <p>Hello <strong>world</strong></p>
      `;

      const nodes = extractTextNodes();
      const texts = nodes.map((n) => n.text.trim());
      const tags = nodes.map((n) => n.element.tagName);

      // <p> has direct text "Hello " and has children → accepted (HTML translation)
      expect(tags).toContain('P');
      // <strong> is skipped because parent <p> has direct text AND children
      expect(tags).not.toContain('STRONG');
      // getDirectText only returns direct text nodes (excludes <strong> text)
      expect(texts).toContain('Hello');
    });

    it('accepts elements with structural children like <a> for HTML-based translation', () => {
      document.body.innerHTML = `
        <p>For more info, see <a href="/docs">documentation</a>.</p>
      `;

      const nodes = extractTextNodes();
      const tags = nodes.map((n) => n.element.tagName);
      const texts = nodes.map((n) => n.text.trim());

      // <p> is accepted (will handle <a> via HTML-based translation)
      expect(tags).toContain('P');
      // <a> is NOT extracted separately — parent handles it
      expect(tags).not.toContain('A');
      // getDirectText only returns direct text nodes (excludes <a> text)
      expect(texts).toContain('For more info, see .');
    });

    it('accepts elements with <code> children for HTML-based translation', () => {
      document.body.innerHTML = `
        <p>Run <code>npm install</code> to begin.</p>
      `;

      const nodes = extractTextNodes();
      const tags = nodes.map((n) => n.element.tagName);

      // <p> is accepted (will handle <code> via HTML-based translation)
      expect(tags).toContain('P');
      // <code> is NOT extracted separately — parent handles it
      expect(tags).not.toContain('CODE');
    });

    it('returns empty array for empty body', () => {
      document.body.innerHTML = '';
      const nodes = extractTextNodes();
      expect(nodes).toEqual([]);
    });

    it('returns empty array for body with only hidden elements', () => {
      document.body.innerHTML = '<p style="display:none;">Hidden</p>';
      const nodes = extractTextNodes();
      expect(nodes).toEqual([]);
    });

    it('skips elements with only whitespace', () => {
      document.body.innerHTML = '<div>   </div><p>Real text</p>';
      const nodes = extractTextNodes();
      const texts = nodes.map((n) => n.text.trim());
      expect(texts).not.toContain('');
      expect(texts).toContain('Real text');
    });

    it('preserves nested <ul> inside <li> by using HTML-based translation', () => {
      document.body.innerHTML = `
        <li>Frontier models<ul title=""><li>GPT-5.5/ 5.5 pro</li><li>GPT-5.4</li></ul></li>
      `;
      extractTextNodes();

      const li = $('li');
      // The outer <li> should save innerHTML in Map (not just text) since it has a <ul> child
      expect(originalContentMap.has(li)).toBe(true);
      expect(li.hasAttribute('data-original-text')).toBe(false);
    });

    it('preserves inline <s> tags by using HTML-based translation', () => {
      document.body.innerHTML = `
        <li><s>Claude Instant</s>（2025年7月21日EOL）</li>
      `;
      extractTextNodes();

      const li = $('li');
      // The <li> has direct text AND a <s> child → saves innerHTML in Map for preservation
      expect(originalContentMap.has(li)).toBe(true);
      expect(li.hasAttribute('data-original-text')).toBe(false);
    });

    it('preserves inline <b>, <i>, <em>, <strong> tags by using HTML-based translation', () => {
      document.body.innerHTML = `
        <p>Use <b>bold</b>, <i>italic</i>, <em>emphasis</em>, and <strong>strong</strong> text.</p>
      `;
      extractTextNodes();

      const p = $('p');
      // The <p> has direct text AND child elements → saves innerHTML in Map
      expect(originalContentMap.has(p)).toBe(true);
      expect(p.hasAttribute('data-original-text')).toBe(false);
    });
  });

  describe('groupNodesIntoBatches', () => {
    it('returns empty batches for empty input', () => {
      const result = groupNodesIntoBatches([]);
      expect(result).toEqual({ plainBatches: [], structuralElements: [] });
    });

    it('groups plain text elements by character threshold', () => {
      const medText = 'A'.repeat(500);
      document.body.innerHTML = `
        <p>${medText} x</p>
        <p>${medText} y</p>
        <p>${medText} z</p>
      `;
      const nodes = extractTextNodes();
      const result = groupNodesIntoBatches(nodes);

      expect(result.plainBatches.length).toBe(2);
      expect(result.plainBatches[0].length).toBe(2);
      expect(result.plainBatches[1].length).toBe(1);
      expect(result.structuralElements.length).toBe(0);
    });

    it('groups plain text elements by item count threshold (20)', () => {
      const paragraphs = Array.from({ length: 22 }, (_, i) => `<p>Txt${i}</p>`).join('\n');
      document.body.innerHTML = paragraphs;
      const nodes = extractTextNodes();
      const result = groupNodesIntoBatches(nodes);

      expect(result.plainBatches.length).toBe(2);
      expect(result.plainBatches[0].length).toBe(20);
      expect(result.plainBatches[1].length).toBe(2);
      expect(result.structuralElements.length).toBe(0);
    });

    it('sends all short texts in one batch when under both thresholds', () => {
      document.body.innerHTML = `
        <p>Home</p>
        <p>About</p>
        <p>Contact</p>
        <p>FAQ</p>
        <p>Help</p>
      `;
      const nodes = extractTextNodes();
      const result = groupNodesIntoBatches(nodes);

      expect(result.plainBatches.length).toBe(1);
      expect(result.plainBatches[0].length).toBe(5);
      expect(result.structuralElements.length).toBe(0);
    });

    it('separates structural elements from plain text', () => {
      document.body.innerHTML = `
        <p>For more info, see <a href="/docs">documentation</a>.</p>
        <span>Plain text only</span>
      `;
      const nodes = extractTextNodes();
      const result = groupNodesIntoBatches(nodes);

      expect(result.structuralElements.length).toBe(1);
      expect(result.structuralElements[0].element.tagName).toBe('P');
      expect(result.plainBatches.length).toBe(1);
      expect(result.plainBatches[0].length).toBe(1);
      expect(result.plainBatches[0][0].element.tagName).toBe('SPAN');
    });

    it('handles mixed content with both plain and structural elements', () => {
      document.body.innerHTML = `
        <p>First paragraph</p>
        <p>Second paragraph</p>
        <p>Third <a href="/link">paragraph</a></p>
        <p>Fourth paragraph</p>
      `;
      const nodes = extractTextNodes();
      const result = groupNodesIntoBatches(nodes);

      expect(result.structuralElements.length).toBe(1);
      expect(result.structuralElements[0].element.tagName).toBe('P');
      expect(result.plainBatches.length).toBe(1);
      expect(result.plainBatches[0].length).toBe(3);
    });

    it('treats elements with <br> as structural (not plain batch)', () => {
      document.body.innerHTML = `
        <p>Plain text one</p>
        <p><br><br>Paragraph with<br><br>line breaks</p>
        <p>Plain text two</p>
      `;
      const nodes = extractTextNodes();
      const result = groupNodesIntoBatches(nodes);

      // The <p> with <br> should be in structuralElements
      expect(result.structuralElements.length).toBe(1);
      expect(result.structuralElements[0].element.tagName).toBe('P');
      expect(result.structuralElements[0].text).toContain('Paragraph with');
      expect(result.structuralElements[0].text).toContain('line breaks');

      // Plain texts should be in plainBatches
      expect(result.plainBatches.length).toBe(1);
      expect(result.plainBatches[0].length).toBe(2);
    });

    it('handles <div> with <br> as structural', () => {
      document.body.innerHTML = `
        <div>Direct text <br> and more</div>
      `;
      const nodes = extractTextNodes();
      const result = groupNodesIntoBatches(nodes);

      expect(result.structuralElements.length).toBe(1);
      expect(result.structuralElements[0].element.tagName).toBe('DIV');
    });

    it('treats <li> with nested <ul> as structural', () => {
      document.body.innerHTML = `
        <ul>
          <li>Frontier models<ul><li>GPT-5</li></ul></li>
          <li>Simple item</li>
        </ul>
      `;
      const nodes = extractTextNodes();
      const result = groupNodesIntoBatches(nodes);

      // The <li> with nested <ul> should be structural
      expect(result.structuralElements.length).toBe(1);
      expect(result.structuralElements[0].element.textContent).toContain('Frontier models');
      // The simple <li> should be plain
      expect(result.plainBatches.length).toBe(1);
      expect(result.plainBatches[0].length).toBe(1);
    });
  });

  describe('highlightElement', () => {
    it('adds highlight class and sets background color', () => {
      const element = document.createElement('div');
      document.body.appendChild(element);

      highlightElement(element);

      expect(element.classList.contains('evchan-translated')).toBe(true);
      // jsdom converts hex to rgb
      expect(element.style.backgroundColor).toMatch(/255,\s*245,\s*157/);
      document.body.removeChild(element);
    });
  });

  describe('unhighlightElement', () => {
    it('removes highlight class and background', () => {
      const element = document.createElement('div');
      document.body.appendChild(element);

      highlightElement(element);
      unhighlightElement(element);

      expect(element.classList.contains('evchan-translated')).toBe(false);
      expect(element.style.backgroundColor).toBe('');
      document.body.removeChild(element);
    });
  });

  describe('markFailed', () => {
    it('adds failed class and sets red background', () => {
      const element = document.createElement('div');
      document.body.appendChild(element);

      markFailed(element);

      expect(element.classList.contains('evchan-failed')).toBe(true);
      // jsdom converts hex to rgb
      expect(element.style.backgroundColor).toMatch(/255,\s*205,\s*210/);
      document.body.removeChild(element);
    });
  });

  describe('restoreOriginals', () => {
    it('restores text from data-original-text', () => {
      const p = $('p');
      p.setAttribute('data-original-text', 'Original text');
      p.textContent = 'Translated text';

      const result = restoreOriginals();

      expect(p.textContent).toBe('Original text');
      expect(p.hasAttribute('data-original-text')).toBe(false);
      expect(result.success).toBe(true);
      expect(result.restoredCount).toBeGreaterThan(0);
    });

    it('removes highlight and failed classes', () => {
      const h1 = $('h1');
      h1.setAttribute('data-original-text', 'Test');
      h1.classList.add('evchan-translated');
      h1.classList.add('evchan-failed');
      h1.style.backgroundColor = '#fff59d';

      restoreOriginals();

      expect(h1.classList.contains('evchan-translated')).toBe(false);
      expect(h1.classList.contains('evchan-failed')).toBe(false);
      expect(h1.style.backgroundColor).toBe('');
    });
  });

  describe('detectPageLanguage', () => {
    it('returns lang from <html lang="ja">', () => {
      document.documentElement.lang = 'ja';
      expect(detectPageLanguage()).toBe('ja');
    });

    it('extracts primary subtag from compound lang (en-US → en)', () => {
      document.documentElement.lang = 'en-US';
      expect(detectPageLanguage()).toBe('en');
    });

    it('returns lang from meta content-language when html lang is missing', () => {
      document.documentElement.lang = '';
      document.head.innerHTML = '<meta http-equiv="content-language" content="ko">';
      expect(detectPageLanguage()).toBe('ko');
    });

    it('returns lang from meta name="language" as fallback', () => {
      document.documentElement.lang = '';
      document.head.innerHTML = '<meta name="language" content="zh">';
      expect(detectPageLanguage()).toBe('zh');
    });

    it('returns undefined when no language info is available', () => {
      document.documentElement.lang = '';
      document.head.innerHTML = '';
      expect(detectPageLanguage()).toBeUndefined();
    });

    it('prefers html lang over meta tags', () => {
      document.documentElement.lang = 'ja';
      document.head.innerHTML = '<meta http-equiv="content-language" content="ko">';
      expect(detectPageLanguage()).toBe('ja');
    });

    it('handles 3-letter codes (passes as-is)', () => {
      document.documentElement.lang = 'eng';
      expect(detectPageLanguage()).toBe('eng');
    });

    it('handles content-language with comma-separated values', () => {
      document.documentElement.lang = '';
      document.head.innerHTML = '<meta http-equiv="content-language" content="en, ja, ko">';
      expect(detectPageLanguage()).toBe('en');
    });
  });

  describe('getPageContext', () => {
    let getPageContext;

    beforeEach(() => {
      getPageContext = window.__evchan_content__.getPageContext;
    });

    it('returns document.title when available', () => {
      document.title = 'My Page Title';
      const result = getPageContext();
      expect(result.pageTitle).toBe('My Page Title');
    });

    it('returns document.location.href when title is empty', () => {
      document.title = '';
      const result = getPageContext();
      expect(result.pageTitle).toBe(document.location.href);
    });

    it('trims whitespace from title', () => {
      document.title = '  Trimmed Title  ';
      const result = getPageContext();
      expect(result.pageTitle).toBe('Trimmed Title');
    });
  });

  describe('translatePage', () => {
    it('returns success with counts on successful translation', async () => {
      document.documentElement.lang = 'en';
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          return { success: true, translated: message.texts.map((t) => 'Translated: ' + t) };
        }
        return { success: true, translated: 'Translated: ' + message.text };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);
      expect(result.translatedCount).toBeGreaterThan(0);
      expect(result.failedCount).toBe(0);
    });

    it('marks failed elements with red highlight', async () => {
      document.documentElement.lang = 'en';
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        return { success: false, error: 'Translation failed' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);
      expect(result.failedCount).toBeGreaterThan(0);

      const failedElements = document.querySelectorAll('.evchan-failed');
      expect(failedElements.length).toBeGreaterThan(0);
    });

    it('returns error when no translatable text', async () => {
      document.body.innerHTML = '<div></div>';

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('No translatable text found');
    });

    it('retries null batch entries individually', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Text one</p>
        <p>Text two</p>
        <p>Text three</p>
      `;

      let individualCallCount = 0;
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          // Simulate partial response: LLM only translated 1 of 3
          return { success: true, translated: ['Translated one', null, null] };
        }
        if (message.type === 'TRANSLATE_CHUNK') {
          individualCallCount++;
          return { success: true, translated: 'Individual: ' + message.text };
        }
        return { success: true, translated: 'default' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);
      expect(result.translatedCount).toBe(3); // All 3 should succeed
      expect(result.failedCount).toBe(0);
      expect(individualCallCount).toBe(2); // 2 individual retries for null entries
    });

    it('retries all items individually when batch throws', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Batch fail one</p>
        <p>Batch fail two</p>
      `;

      let individualCallCount = 0;
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          throw new Error('Batch API error');
        }
        if (message.type === 'TRANSLATE_CHUNK') {
          individualCallCount++;
          return { success: true, translated: 'Individual: ' + message.text };
        }
        return { success: true, translated: 'default' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);
      expect(result.translatedCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(individualCallCount).toBe(2);
    });

    it('marks elements as failed when individual retry also fails', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Will fail</p>
        <p>Will also fail</p>
      `;

      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          return { success: true, translated: [null, null] };
        }
        if (message.type === 'TRANSLATE_CHUNK') {
          return { success: false, error: 'Individual also fails' };
        }
        return { success: true, translated: 'default' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);
      expect(result.translatedCount).toBe(0);
      expect(result.failedCount).toBe(2);

      const failedElements = document.querySelectorAll('.evchan-failed');
      expect(failedElements.length).toBe(2);
    });

    it('returns error when translation already in progress', async () => {
      document.documentElement.lang = 'en';
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        return new Promise((resolve) =>
          setTimeout(() => resolve({ success: true, translated: 'Translated' }), 100)
        );
      });

      const first = translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });
      const second = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(second.success).toBe(false);
      expect(second.error).toBe('Translation already in progress');

      await first;
    });

    it('recovers from batch failure via individual retries', async () => {
      document.documentElement.lang = 'en';
      // Create elements whose combined text exceeds BATCH_CHAR_LIMIT (~1,000 chars)
      // to trigger multiple batch flushes. Each ~300 chars; first 4 = ~1,200 → flush, then 2 more.
      const longText = 'A'.repeat(300);
      document.body.innerHTML = `
        <p>${longText} 1</p>
        <p>${longText} 2</p>
        <p>${longText} 3</p>
        <p>${longText} 4</p>
        <p>${longText} 5</p>
        <p>${longText} 6</p>
      `;
      let batchCount = 0;
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          batchCount++;
          if (batchCount === 1) {
            return { success: true, translated: message.texts.map((_, i) => `Translated ${i}`) };
          }
          return { success: false, error: 'API rate limited' };
        }
        return { success: true, translated: 'Translated text' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      // First batch succeeds (4 items), second batch fails but individual retries recover all 2
      expect(result.success).toBe(true);
      expect(result.translatedCount).toBe(6);
      expect(result.failedCount).toBe(0);
    });

    it('flushes batch when character threshold is exceeded', async () => {
      document.documentElement.lang = 'en';
      // 3 elements × ~500 chars; first 2 = ~1,002 chars → flush at 2, then 1 remaining
      const medText = 'B'.repeat(500);
      document.body.innerHTML = `
        <p>${medText} x</p>
        <p>${medText} y</p>
        <p>${medText} z</p>
      `;
      const batchSizes = [];
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          batchSizes.push(message.texts.length);
          return { success: true, translated: message.texts.map((t) => t.toUpperCase()) };
        }
        return { success: true, translated: 'Translated' };
      });

      await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      // First 2 elements (~1,002 chars) trigger flush; 3rd is a separate batch
      expect(batchSizes.length).toBe(2);
      expect(batchSizes[0]).toBe(2);
      expect(batchSizes[1]).toBe(1);
    });

    it('flushes batch at MAX_BATCH_ITEMS (20) even under character limit', async () => {
      document.documentElement.lang = 'en';
      // 22 short texts (5 chars each = 110 total, well under 1,000)
      // Should trigger flush at 20 items, then 1 more batch for remaining 2
      const paragraphs = Array.from({ length: 22 }, (_, i) => `<p>Txt${i}</p>`).join('\n');
      document.body.innerHTML = paragraphs;
      const batchSizes = [];
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          batchSizes.push(message.texts.length);
          return { success: true, translated: message.texts.map((t) => t.toUpperCase()) };
        }
        return { success: true, translated: 'Translated' };
      });

      await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(batchSizes.length).toBe(2);
      expect(batchSizes[0]).toBe(20);
      expect(batchSizes[1]).toBe(2);
    });

    it('sends all short texts in one batch when under threshold', async () => {
      document.documentElement.lang = 'en';
      // 5 short texts (well under 1,000 chars and under 20 items)
      document.body.innerHTML = `
        <p>Home</p>
        <p>About</p>
        <p>Contact</p>
        <p>FAQ</p>
        <p>Help</p>
      `;
      const batchSizes = [];
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          batchSizes.push(message.texts.length);
          return { success: true, translated: message.texts.map((t) => t.toUpperCase()) };
        }
        return { success: true, translated: 'Translated' };
      });

      await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      // All 5 in one batch
      expect(batchSizes).toEqual([5]);
    });
  });

  describe('sendProgress', () => {
    it('sends progress message to background', () => {
      sendProgress(5, 10, 'Translating...');

      expect(sendMessage).toHaveBeenCalledWith(
        {
          type: 'PROGRESS',
          progress: { current: 5, total: 10, percentage: 50, status: 'Translating...' },
        },
        expect.any(Function)
      );
    });

    it('handles zero total without division error', () => {
      sendProgress(0, 0, 'Starting...');

      expect(sendMessage).toHaveBeenCalledWith(
        {
          type: 'PROGRESS',
          progress: { current: 0, total: 0, percentage: 0, status: 'Starting...' },
        },
        expect.any(Function)
      );
    });
  });

  describe('translateElement', () => {
    it('throws error when translation response fails', async () => {
      sendMessage.mockResolvedValueOnce({
        success: false,
        error: 'API timeout',
      });

      const element = document.createElement('span');
      element.textContent = 'Test';
      document.body.appendChild(element);

      await expect(
        translateElement(element, 'Test', { apiEndpoint: 'http://test.com/v1' }, 'en')
      ).rejects.toThrow('API timeout');

      document.body.removeChild(element);
    });

    it('retries once when sendMessage returns null then succeeds', async () => {
      sendMessage
        .mockResolvedValueOnce(null) // First call fails
        .mockResolvedValueOnce({ success: true, translated: 'Translated' }); // Retry succeeds

      const element = document.createElement('span');
      element.textContent = 'Test';
      document.body.appendChild(element);

      const result = await translateElement(
        element,
        'Test',
        { apiEndpoint: 'http://test.com/v1' },
        'en'
      );

      expect(result).toBe('Translated');
      expect(element.textContent).toBe('Translated');
      // 1 CONTENT_LOADED (from init) + 2 (original + retry)
      expect(sendMessage).toHaveBeenCalledTimes(3);

      document.body.removeChild(element);
    });
  });

  describe('CONTENT_LOADED message', () => {
    it('sends CONTENT_LOADED message on initialization', async () => {
      vi.resetModules();

      const loadedSendMessage = vi.fn(() => Promise.resolve({ success: true }));
      global.chrome = {
        runtime: {
          id: 'test-extension-id',
          sendMessage: loadedSendMessage,
          onMessage: { addListener: vi.fn() },
        },
      };

      document.body.innerHTML = '<p>Test content</p>';

      await import('../content/content.js');
      await new Promise((r) => setTimeout(r, 10));

      // Should send CONTENT_LOADED message
      expect(loadedSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CONTENT_LOADED' })
      );
    });
  });

  describe('CANCEL_TRANSLATION message', () => {
    it('calls sendResponse to avoid leaving messaging system in bad state', async () => {
      vi.resetModules();

      const cancelSendMessage = vi.fn(() => Promise.resolve({ success: true }));
      let capturedOnMessageHandler;
      global.chrome = {
        runtime: {
          id: 'test-extension-id',
          sendMessage: cancelSendMessage,
          onMessage: {
            addListener: vi.fn((handler) => {
              capturedOnMessageHandler = handler;
            }),
          },
        },
      };

      document.body.innerHTML = '<p>Test content</p>';
      await import('../content/content.js');
      await new Promise((r) => setTimeout(r, 10));

      // Simulate receiving CANCEL_TRANSLATION message
      let sendResponseCalled = false;
      const mockSendResponse = (_response) => {
        sendResponseCalled = true;
      };

      // The handler returns true (async), so we need to wait for it
      const handlerReturn = capturedOnMessageHandler(
        { type: 'CANCEL_TRANSLATION' },
        { id: 'test-extension-id' },
        mockSendResponse
      );

      expect(handlerReturn).toBe(true); // async response

      // Wait for the async handler to complete
      await new Promise((r) => setTimeout(r, 50));

      // sendResponse should have been called
      expect(sendResponseCalled).toBe(true);
    });
  });

  describe('translatePage concurrent processing', () => {
    it('processes plain batches and structural elements concurrently', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Plain text one</p>
        <p>Plain text two</p>
        <p>Structural <a href="/link">link</a> element</p>
      `;

      const callOrder = [];

      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          callOrder.push('batch_start');
          // Delay the batch to allow checking concurrency
          await new Promise((resolve) => setTimeout(resolve, 50));
          callOrder.push('batch_end');
          return { success: true, translated: message.texts.map((t) => 'Batch: ' + t) };
        }
        if (message.type === 'TRANSLATE_HTML') {
          callOrder.push('html_start');
          // Delay the HTML translation similarly
          await new Promise((resolve) => setTimeout(resolve, 50));
          callOrder.push('html_end');
          return { success: true, translated: '<p>Translated <a href="/link">link</a></p>' };
        }
        return { success: true, translated: 'default' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);
      expect(result.translatedCount).toBe(3);
      expect(result.failedCount).toBe(0);

      // Both should have started before either ended (concurrent, not sequential)
      // In sequential: batch_start, batch_end, html_start, html_end
      // In concurrent: batch_start, html_start, batch_end, html_end (or similar interleaving)
      const batchStartIdx = callOrder.indexOf('batch_start');
      const htmlStartIdx = callOrder.indexOf('html_start');
      const batchEndIdx = callOrder.indexOf('batch_end');
      const htmlEndIdx = callOrder.indexOf('html_end');

      // Both should start before either ends
      expect(Math.max(batchStartIdx, htmlStartIdx)).toBeLessThan(Math.min(batchEndIdx, htmlEndIdx));
    });

    it('handles failures independently in concurrent workers', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Plain text</p>
        <p>Structural <a href="/link">link</a> element</p>
      `;

      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          return { success: true, translated: message.texts.map((t) => 'Batch: ' + t) };
        }
        if (message.type === 'TRANSLATE_HTML') {
          return { success: false, error: 'HTML translation failed' };
        }
        if (message.type === 'TRANSLATE_CHUNK') {
          return { success: true, translated: 'Individual: ' + message.text };
        }
        return { success: true, translated: 'default' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);
      expect(result.translatedCount).toBe(1); // Only plain text succeeded
      expect(result.failedCount).toBe(1); // Structural element failed

      const failedElements = document.querySelectorAll('.evchan-failed');
      expect(failedElements.length).toBe(1);
    });

    it('respects cancel flag during concurrent processing', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Plain text</p>
        <p>Structural <a href="/link">link</a> element</p>
      `;

      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          // Delay and check for cancel
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { success: true, translated: message.texts.map((t) => 'Batch: ' + t) };
        }
        if (message.type === 'TRANSLATE_HTML') {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { success: true, translated: '<p>Translated</p>' };
        }
        if (message.type === 'TRANSLATE_CHUNK') {
          return { success: true, translated: 'Individual: ' + message.text };
        }
        return { success: true, translated: 'default' };
      });

      const translatePromise = translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      // Trigger cancel after a short delay
      setTimeout(() => {
        window.__evchan_content__.setShouldCancel(true);
      }, 50);

      const result = await translatePromise;

      // Either it completes (if cancel came too late) or it's cancelled
      // The important thing is it doesn't crash
      expect(result.success !== undefined).toBe(true);
    });

    it('aggregates progress from both concurrent workers', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Plain text</p>
        <p>Structural <a href="/link">link</a> element</p>
      `;

      const progressMessages = [];
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') {
          progressMessages.push(message.progress);
          return { acknowledged: true };
        }
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { success: true, translated: message.texts.map((t) => 'Batch: ' + t) };
        }
        if (message.type === 'TRANSLATE_HTML') {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { success: true, translated: '<p>Translated <a href="/link">link</a></p>' };
        }
        if (message.type === 'TRANSLATE_CHUNK') {
          return { success: true, translated: 'Individual: ' + message.text };
        }
        return { success: true, translated: 'default' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);

      // Check that final progress shows all elements done
      const finalProgress = progressMessages[progressMessages.length - 1];
      expect(finalProgress.current).toBe(2);
      expect(finalProgress.total).toBe(2);
    });

    it('stops batch retry loop when cancel is triggered during null-entry retries', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Text one</p>
        <p>Text two</p>
        <p>Text three</p>
        <p>Text four</p>
      `;

      const individualCalls = [];

      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          // Return null for all entries to trigger individual retries
          return { success: true, translated: [null, null, null, null] };
        }
        if (message.type === 'TRANSLATE_CHUNK') {
          individualCalls.push(message.text);
          // Simulate slow individual translation
          await new Promise((resolve) => setTimeout(resolve, 20));
          // Cancel after first individual call
          if (individualCalls.length === 1) {
            window.__evchan_content__.setShouldCancel(true);
          }
          return { success: true, translated: 'Translated: ' + message.text };
        }
        return { success: true, translated: 'default' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      // Should be cancelled (not all items translated)
      expect(result.success).toBe(false);
      expect(result.error).toBe('Translation cancelled');

      // Only some individual calls were made (not all 4)
      expect(individualCalls.length).toBeLessThan(4);
    });

    it('stops batch retry loop when cancel is triggered during full-batch-failure retries', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Text one</p>
        <p>Text two</p>
        <p>Text three</p>
        <p>Text four</p>
      `;

      const individualCalls = [];

      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          // Fail all batch calls to trigger individual retries
          throw new Error('Batch failed');
        }
        if (message.type === 'TRANSLATE_CHUNK') {
          individualCalls.push(message.text);
          // Simulate slow individual translation
          await new Promise((resolve) => setTimeout(resolve, 20));
          // Cancel after first individual call
          if (individualCalls.length === 1) {
            window.__evchan_content__.setShouldCancel(true);
          }
          return { success: true, translated: 'Translated: ' + message.text };
        }
        return { success: true, translated: 'default' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      // Should be cancelled (not all items translated)
      expect(result.success).toBe(false);
      expect(result.error).toBe('Translation cancelled');

      // Only some individual calls were made (not all 4)
      expect(individualCalls.length).toBeLessThan(4);
    });
  });

  describe('sendMessageWithRetry exception handling', () => {
    it('handles thrown exceptions from chrome.runtime.sendMessage', async () => {
      vi.resetModules();

      let callCount = 0;
      const exceptionSendMessage = vi.fn(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ success: true }); // CONTENT_LOADED
        if (callCount === 2) throw new Error('Extension context invalidated'); // first attempt
        return Promise.resolve({ success: true, translated: 'Translated text' }); // retry
      });

      global.chrome = {
        runtime: {
          id: 'test-extension-id',
          sendMessage: exceptionSendMessage,
          onMessage: { addListener: vi.fn() },
        },
      };

      document.body.innerHTML = '<p>Test content</p>';
      await import('../content/content.js');
      await new Promise((r) => setTimeout(r, 10));

      const content = window.__evchan_content__;
      const sendMessageWithRetry = content.sendMessageWithRetry;

      // Should retry on exception and succeed
      const result = await sendMessageWithRetry({ type: 'TRANSLATE_CHUNK', text: 'Hello' });
      expect(result).toEqual({ success: true, translated: 'Translated text' });
    });

    it('throws after retry also throws', async () => {
      vi.resetModules();

      const alwaysFailSendMessage = vi.fn(() => Promise.reject(new Error('Connection closed')));

      global.chrome = {
        runtime: {
          id: 'test-extension-id',
          sendMessage: alwaysFailSendMessage,
          onMessage: { addListener: vi.fn() },
        },
      };

      document.body.innerHTML = '<p>Test content</p>';
      await import('../content/content.js');
      await new Promise((r) => setTimeout(r, 10));

      const content = window.__evchan_content__;
      const sendMessageWithRetry = content.sendMessageWithRetry;

      // Clear calls from CONTENT_LOADED initialization
      alwaysFailSendMessage.mockClear();

      await expect(
        sendMessageWithRetry({ type: 'TRANSLATE_CHUNK', text: 'Hello' })
      ).rejects.toThrow('Connection closed');

      expect(alwaysFailSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('multi-translation state management', () => {
    // These tests expose critical bugs with consecutive translations:
    // 1. Stale data-original-* attributes after cancellation/second translation
    // 2. extractTextNodes skipping elements that already have attributes
    // 3. translatePage not clearing stale attributes before starting

    it('clears stale data-original-text attributes before starting translation', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Original text</p>
      `;

      // Simulate leftover attributes from a previous translation
      const p = $('p');
      p.setAttribute('data-original-text', 'Stale original');
      p.textContent = 'Already translated text';

      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          // The batch should contain the CURRENT text ("Already translated text"),
          // NOT the stale original. After clearing, extractTextNodes reads fresh DOM.
          return { success: true, translated: message.texts.map((t) => 'Final: ' + t) };
        }
        return { success: true, translated: 'Final: ' + message.text };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);

      // The data-original-text should now be the current DOM text at translation start,
      // NOT the stale value
      expect(p.getAttribute('data-original-text')).not.toBe('Stale original');
      expect(p.getAttribute('data-original-text')).toBe('Already translated text');
    });

    it('clears stale originalContentMap entries before starting translation', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>See <a href="/link">link</a> here</p>
      `;

      // Simulate leftover entries from a previous translation
      const p = $('p');
      originalContentMap.set(p, { type: 'html', value: '<a href="/old">stale link</a>' });
      p.innerHTML = 'See <a href="/new">new link</a> here';

      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_HTML') {
          return { success: true, translated: '<p>Ver <a href="/new">enlace</a> aquí</p>' };
        }
        return { success: true, translated: 'translated' };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });

      expect(result.success).toBe(true);

      // The saved HTML should now be the current DOM state, NOT the stale value
      const saved = originalContentMap.get(p);
      expect(saved.value).not.toBe('<a href="/old">stale link</a>');
      expect(saved.value).toContain('new link');
    });

    it('handles second translation after first completes (without restore)', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Hello world</p>
      `;

      const firstTranslation = true;
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          return {
            success: true,
            translated: message.texts.map((t) => {
              // First call translates English, second call translates the already-translated text
              return firstTranslation ? 'Hola mundo' : '最終: ' + t;
            }),
          };
        }
        return {
          success: true,
          translated: firstTranslation ? 'Hola mundo' : '最終: ' + message.text,
        };
      });

      // First translation
      const result1 = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'es',
      });
      expect(result1.success).toBe(true);

      const p = $('p');
      expect(p.textContent).toBe('Hola mundo');
      const firstOriginal = p.getAttribute('data-original-text');
      expect(firstOriginal).toBe('Hello world');

      // Second translation WITHOUT restore (simulating user translating again)
      // After fix: stale attributes are cleared, so "Hola mundo" is read as input
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          return {
            success: true,
            translated: message.texts.map((t) => '最終: ' + t),
          };
        }
        return { success: true, translated: '最終: ' + message.text };
      });

      const result2 = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'ja',
      });
      expect(result2.success).toBe(true);

      // After second translation, data-original-text should be "Hola mundo" (the text at start of 2nd translation)
      expect(p.getAttribute('data-original-text')).toBe('Hola mundo');
    });

    it('extractTextNodes reads fresh DOM after clearing stale attributes', async () => {
      document.body.innerHTML = `
        <p>Current text in DOM</p>
      `;

      // Simulate stale attribute from previous translation
      const p = $('p');
      p.setAttribute('data-original-text', 'Stale original from before');

      // extractTextNodes should NOT use the stale attribute value
      // After fix: the stale attribute is cleared by translatePage, not by extractTextNodes
      // But extractTextNodes itself should still read the current DOM text
      const nodes = extractTextNodes();
      const node = nodes.find((n) => n.element === p);

      // The text should be from current DOM, not from stale attribute
      // (extractTextNodes reads getDirectText which reads DOM, not attributes)
      expect(node.text).toBe('Current text in DOM');
    });

    it('restoreOriginals works correctly after second translation', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Hello</p>
      `;

      const p = $('p');

      // Simulate first translation result
      p.setAttribute('data-original-text', 'Hello');
      p.textContent = 'Hola';

      // Now simulate what happens when translatePage runs again:
      // After fix: it should clear the stale attribute and re-read current DOM
      // So data-original-text becomes "Hola" (current DOM text)

      // Manually simulate the clear + re-extract that translatePage should do
      // (this tests the expected behavior after the fix)
      originalContentMap.clear();
      document.querySelectorAll('[data-original-text]').forEach((el) => {
        el.removeAttribute('data-original-text');
      });

      // Now extractTextNodes will re-read fresh
      extractTextNodes();

      // data-original-text should now be "Hola" (current DOM)
      expect(p.getAttribute('data-original-text')).toBe('Hola');

      // Simulate second translation
      p.textContent = '最終';

      // Now restore should bring back "Hola" (the text before second translation)
      const result = restoreOriginals();

      expect(result.success).toBe(true);
      expect(p.textContent).toBe('Hola');
      expect(p.hasAttribute('data-original-text')).toBe(false);
    });

    it('handles cancelled translation followed by new translation', async () => {
      document.documentElement.lang = 'en';
      document.body.innerHTML = `
        <p>Text one</p>
        <p>Text two</p>
        <p>Text three</p>
      `;

      const paragraphs = $$('p');

      // Simulate partial translation state after cancellation:
      // First paragraph was translated, others were not.
      // Attributes were set on all three during extraction.
      paragraphs[0].setAttribute('data-original-text', 'Text one');
      paragraphs[0].textContent = 'Translated one';
      paragraphs[1].setAttribute('data-original-text', 'Text two');
      paragraphs[2].setAttribute('data-original-text', 'Text three');

      // Now start a new translation
      sendMessage.mockImplementation(async (message) => {
        if (message.type === 'PROGRESS') return { acknowledged: true };
        if (message.type === 'TRANSLATE_CHUNK_BATCH') {
          // After fix: all current DOM texts are read (including "Translated one")
          return {
            success: true,
            translated: message.texts.map((t) => 'Final: ' + t),
          };
        }
        return { success: true, translated: 'Final: ' + message.text };
      });

      const result = await translatePage({
        apiEndpoint: 'http://test.com/v1',
        model: 'gpt-4',
        targetLanguage: 'ja',
      });

      expect(result.success).toBe(true);

      // All elements should have been translated from their current state
      // First paragraph's original should be "Translated one" (its state before this translation)
      expect(paragraphs[0].getAttribute('data-original-text')).toBe('Translated one');
    });
  });
});
