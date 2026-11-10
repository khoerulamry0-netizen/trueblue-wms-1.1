export function assistantApiUrl(path: '/api/chat' | '/api/chat/status', configuredOrigin?: string): string {
  const raw = configuredOrigin?.trim();
  if (!raw) return path;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Alamat layanan Asisten AI tidak valid. Hubungi Administrator.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Alamat layanan Asisten AI tidak valid. Hubungi Administrator.');
  }
  return url.origin + path;
}

export function assistantConnectionError(error: unknown, fallback: string): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError)) {
    return 'Layanan Asisten AI belum merespons atau sedang dinyalakan. Coba lagi sebentar. Menu stok dan operasional WMS tetap dapat digunakan.';
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
