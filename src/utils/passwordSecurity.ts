const COMMON_LEAKED_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '123456789012',
  'password',
  'password123',
  'password1234',
  'qwerty123',
  'qwertyuiop',
  'admin123',
  'admin1234',
  'administrator',
  'welcome123',
  'indonesia123',
  'trueblue123',
  'gudang123',
  'operator123',
  'iloveyou123',
  'abc123456',
  'letmein123'
]);

async function sha1Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-1', encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * Checks whether a password has been exposed in known data breaches
 * using local common-breach rules + HaveIBeenPwned k-Anonymity range API
 * (only first 5 chars of SHA-1 hash are sent over the network).
 */
export async function validatePasswordNotLeaked(
  password: string,
  accountIdentifier?: string,
  minLength = 8
): Promise<string | null> {
  if (password.length < minLength) {
    return `Password minimal harus ${minLength} karakter.`;
  }
  if (password.length > 128) {
    return 'Password maksimal 128 karakter.';
  }

  const lower = password.toLowerCase();
  if (COMMON_LEAKED_PASSWORDS.has(lower)) {
    return 'Password ini termasuk daftar password bocor yang umum digunakan. Gunakan kombinasi yang lebih unik.';
  }

  if (/^(.)\1+$/.test(password)) {
    return 'Password tidak boleh hanya berisi satu karakter berulang.';
  }

  if (accountIdentifier) {
    const cleanId = accountIdentifier.split('@')[0].trim().toLowerCase();
    if (cleanId.length >= 3 && lower === cleanId) {
      return 'Password tidak boleh sama dengan ID akun / username.';
    }
  }

  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof fetch === 'function') {
      const fullHash = await sha1Hex(password);
      const prefix = fullHash.slice(0, 5);
      const suffix = fullHash.slice(5);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      try {
        const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
          headers: { 'Add-Padding': 'true' },
          signal: controller.signal
        });
        if (res.ok) {
          const text = await res.text();
          const lines = text.split('\n');
          for (const line of lines) {
            const [hashSuffix, countStr] = line.trim().split(':');
            if (hashSuffix === suffix && Number(countStr) > 0) {
              return 'Password ini terdeteksi pernah bocor di database publik (Leaked Password Protection). Silakan gunakan password lain yang belum pernah bocor.';
            }
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } catch {
    // Network or offline fallback: local checks above still protect the account
  }

  return null;
}
