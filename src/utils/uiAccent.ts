export type UiAccent = 'default' | 'blue' | 'green' | 'yellow' | 'pink' | 'orange' | 'purple' | 'black' | 'custom';

export const UI_ACCENT_KEY = 'trueblue_wms_accent';
export const UI_CUSTOM_ACCENT_KEY = 'trueblue_wms_custom_accent';
export const DEFAULT_CUSTOM_ACCENT = '#2f6feb';

const accents: UiAccent[] = ['default', 'blue', 'green', 'yellow', 'pink', 'orange', 'purple', 'black', 'custom'];

export function readUiAccent(): UiAccent {
  try {
    const value = localStorage.getItem(UI_ACCENT_KEY) as UiAccent | null;
    return value && accents.includes(value) ? value : 'blue';
  } catch {
    return 'blue';
  }
}

export function readCustomAccent(): string {
  try {
    const value = localStorage.getItem(UI_CUSTOM_ACCENT_KEY);
    return value && /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_CUSTOM_ACCENT;
  } catch {
    return DEFAULT_CUSTOM_ACCENT;
  }
}

export function applyUiAccent(accent: UiAccent, customColor = readCustomAccent()) {
  document.documentElement.dataset.accent = accent;
  if (accent === 'custom') document.documentElement.style.setProperty('--custom-accent', customColor);
  else document.documentElement.style.removeProperty('--custom-accent');
  try {
    localStorage.setItem(UI_ACCENT_KEY, accent);
    if (accent === 'custom') localStorage.setItem(UI_CUSTOM_ACCENT_KEY, customColor);
  } catch { /* Accent still works with storage disabled. */ }
}
