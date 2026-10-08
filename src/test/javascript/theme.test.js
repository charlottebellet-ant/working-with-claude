const fs = require('fs');
const { loadApp, requireApp, THEME_KEY, CSS_PATH, APP_PATH } = require('./setup/loadApp');

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

function theme(document) {
  return document.documentElement.getAttribute('data-theme');
}

function toggle(document) {
  return document.getElementById('theme-toggle');
}

afterEach(() => {
  jest.restoreAllMocks();
  delete window.matchMedia;
});

describe('AC-1: the toggle button', () => {
  test('sits in the header', async () => {
    const { document } = await loadApp();
    expect(document.querySelector('#app-header #theme-toggle')).not.toBeNull();
  });

  test('its label names the theme you will get', async () => {
    const { document } = await loadApp();
    expect(toggle(document).textContent).toMatch(/light/i);
    toggle(document).click();
    expect(toggle(document).textContent).toMatch(/dark/i);
  });

  test('clicking switches theme, and clicking again switches back', async () => {
    const { document } = await loadApp();
    expect(theme(document)).toBe('dark');
    toggle(document).click();
    expect(theme(document)).toBe('light');
    toggle(document).click();
    expect(theme(document)).toBe('dark');
  });
});

describe('AC-2: data-theme and CSS variables', () => {
  test('state.theme follows the attribute on <html>', async () => {
    const { document, app } = await loadApp();
    expect(app.state.theme).toBe('dark');
    toggle(document).click();
    expect(app.state.theme).toBe('light');
    expect(theme(document)).toBe('light');
  });

  test('style.css keeps colour literals only inside the :root theme blocks', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutThemeBlocks = css.replace(/:root[^{]*\{[^}]*\}/g, '');
    expect(withoutThemeBlocks).not.toMatch(COLOUR_LITERAL);
  });

  test('style.css defines both a dark and a light theme', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    expect(css).toMatch(/:root\s*\{/);
    expect(css).toMatch(/:root\[data-theme="light"\]\s*\{/);
  });

  test('chart bars and labels take their colour from variables', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    for (const selector of ['.chart-svg .bar', '.chart-svg .bar.warn', '.chart-svg .bar-label', '.chart-svg .bar-value']) {
      const rule = css.match(new RegExp(selector.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}'));
      expect(rule).not.toBeNull();
      expect(rule[1]).toMatch(/fill:\s*var\(--/);
    }
  });

  test('app.js contains no colour literal', () => {
    expect(fs.readFileSync(APP_PATH, 'utf8')).not.toMatch(COLOUR_LITERAL);
  });
});

describe('AC-3: the choice is persisted and restored', () => {
  test('clicking stores the new theme', async () => {
    const { document } = await loadApp();
    toggle(document).click();
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
    toggle(document).click();
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  test('a stored light theme is restored on load', async () => {
    const { document } = await loadApp({ theme: 'light' });
    expect(theme(document)).toBe('light');
    expect(toggle(document).textContent).toMatch(/dark/i);
  });

  test('a stored dark theme is restored on load', async () => {
    const { document } = await loadApp({ theme: 'dark' });
    expect(theme(document)).toBe('dark');
  });

  test('an unrecognised stored value is ignored, not applied', async () => {
    for (const bad of ['banana', '', 'LIGHT', '"><script>']) {
      const { document } = await loadApp({ theme: bad });
      expect(theme(document)).toBe('dark');
    }
  });

  test('a localStorage that throws does not break the dashboard or the toggle', async () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { document } = await loadApp();
    expect(theme(document)).toBe('dark');
    expect(document.querySelector('#kpi-orders .kpi-value').textContent).toBe('624');
    toggle(document).click();
    expect(theme(document)).toBe('light');
  });
});

describe('AC-4: dark by default, the OS setting is ignored', () => {
  test('with nothing stored the theme is dark', async () => {
    const { document } = await loadApp();
    expect(theme(document)).toBe('dark');
    expect(toggle(document).textContent).toMatch(/light/i);
  });

  test('a light OS preference does not change the default, and is never consulted', async () => {
    const matchMedia = jest.fn((query) => ({
      matches: query.includes('light'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }));
    window.matchMedia = matchMedia;
    const { document } = await loadApp();
    expect(theme(document)).toBe('dark');
    expect(matchMedia).not.toHaveBeenCalled();
  });
});

describe('theme helpers', () => {
  test('resolveTheme accepts only the exact string "light" as light', () => {
    const { resolveTheme } = requireApp();
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme(null)).toBe('dark');
    expect(resolveTheme(undefined)).toBe('dark');
    expect(resolveTheme('Light')).toBe('dark');
  });

  test('nextTheme flips between the two themes', () => {
    const { nextTheme } = requireApp();
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
  });
});
