export type UiTheme = 'citrus' | 'dark' | 'chelsea';
export const UI_THEME_KEY = 'trueblue_wms_theme';

export function readUiTheme(): UiTheme {
  try {
    const saved = localStorage.getItem(UI_THEME_KEY);
    if (saved === 'dark' || saved === 'chelsea') return saved;
    return 'citrus';
  } catch {
    return 'citrus';
  }
}

export function nextUiTheme(current: UiTheme): UiTheme {
  if (current === 'citrus') return 'chelsea';
  if (current === 'chelsea') return 'dark';
  return 'citrus';
}

export function applyUiTheme(theme: UiTheme) {
  document.documentElement.dataset.theme = theme;
  // Retain the shared layout styles, including portal dialogs, in either palette.
  document.body.classList.add('theme-citrus');
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-chelsea', theme === 'chelsea');
  const metaColor = theme === 'dark' ? '#101923' : theme === 'chelsea' ? '#034694' : '#f4f6f9';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', metaColor);
  try { localStorage.setItem(UI_THEME_KEY, theme); } catch { /* Theme still works with storage disabled. */ }
}
