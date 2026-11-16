export type UiTheme = 'light' | 'dark';
export const UI_THEME_KEY = 'trueblue_wms_theme';

export function readUiTheme(): UiTheme {
  try {
    const saved = localStorage.getItem(UI_THEME_KEY);
    return saved === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function nextUiTheme(current: UiTheme): UiTheme {
  return current === 'dark' ? 'light' : 'dark';
}

export function applyUiTheme(theme: UiTheme) {
  document.documentElement.dataset.theme = theme;
  // Legacy component selectors still use this hook; the visual palette itself is
  // defined by the light/dark ChatGPT-style layer in index.css.
  document.body.classList.add('theme-citrus');
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.remove('theme-chelsea');
  const metaColor = theme === 'dark' ? '#212121' : '#ffffff';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', metaColor);
  try { localStorage.setItem(UI_THEME_KEY, theme); } catch { /* Theme still works with storage disabled. */ }
}
