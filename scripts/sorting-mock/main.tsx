import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MabangWmsOutbound from '../../src/components/MabangWmsOutbound';
import { parseOrders, selectSortingOrders, sortingTaskKey, type MockOrder } from './orders';
import './global.css';
import './mock.css';

const user = {username:'mock-packer', role:'Packer', fullName:'Packer Dummy'};

export function MockPage() {
  const [message, setMessage] = useState('Koneksi mock aktif.');
  const [snapshot, setSnapshot] = useState<MockOrder[] | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const updateSnapshot = (value: unknown) => {
    try {
      const orders = parseOrders(value);
      selectSortingOrders(orders, localStorage.getItem(sortingTaskKey));
      setSnapshot(orders);
      setSnapshotError(null);
      return orders;
    } catch (error) {
      setSnapshot(null);
      setSnapshotError(error instanceof Error ? error.message : 'Snapshot mock tidak valid.');
      throw error;
    }
  };
  const readSnapshot = async () => {
    const response = await fetch('/__sorting_mock/orders', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'
    });
    if (!response.ok) throw new Error('Status order mock tidak tersedia. Sambungkan mock lalu coba lagi.');
    const result = await response.json();
    return updateSnapshot(result.orders);
  };
  const refreshSnapshot = async () => {
    try {
      await readSnapshot();
    } catch (error) {
      setSnapshot(null);
      setSnapshotError(error instanceof Error ? error.message : 'Status order mock gagal dimuat.');
    }
  };
  useEffect(() => {
    const onOrders = (event: Event) => {
      try { updateSnapshot((event as CustomEvent<unknown>).detail); }
      catch { /* updateSnapshot reports the invalid server snapshot in the UI. */ }
    };
    window.addEventListener('sorting-mock-orders', onOrders);
    void refreshSnapshot();
    return () => window.removeEventListener('sorting-mock-orders', onOrders);
  }, []);
  const control = async (action: string) => {
    if (action === 'reset' && !window.confirm('Hapus sesi sorting mock pada browser dan server mock ini?')) return;
    try {
      const response = await fetch('/__sorting_mock/control', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action})
      });
      if (!response.ok) throw new Error('Kontrol mock gagal.');
      if (action === 'reset') {
        const keys = Object.keys(localStorage).filter(key => key.startsWith('wms-sorting-v1:') || key.startsWith('wms-sorting-task-v1:'));
        keys.forEach(key => localStorage.removeItem(key));
        window.location.reload();
        return;
      }
      if (action === 'reconnect') await refreshSnapshot();
      setMessage(action === 'reconnect' ? 'Mock tersambung. Klik Pulihkan sesi pada komponen.' :
        'Scan berikut akan kehilangan koneksi. Setelah itu sambungkan kembali dan klik Pulihkan sesi.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Kontrol mock gagal.'); }
  };
  return <>
    <header className="mock-banner">
      <h1>MOCK / BUKAN DATABASE NYATA — SORTING MABANG</h1>
      <p>Batch: <strong>MOCK-BATCH</strong>. A1: DEV-BC-001 × 2; A2: DEV-BC-002 × 1; A3: DEV-BC-001 × 1. Barcode salah: SALAH.</p>
      <p>Muat batch lalu scan barcode pada form asli; mock server memilih basket. Scan lagi setelah penuh untuk overscan.</p>
      <p>Simulasi retry: pilih gangguan, scan, refresh jika diinginkan, sambungkan kembali, lalu klik Pulihkan sesi.</p>
      <p>Order yang sortirnya selesai tidak akan dimuat lagi; status order outbound nyata tidak diubah.</p>
      <div className="mock-buttons">
        <button onClick={() => void control('lose-before')}>Putus sebelum tersimpan</button>
        <button onClick={() => void control('lose-after')}>Respons hilang sesudah tersimpan</button>
        <button onClick={() => void control('reconnect')}>Sambungkan mock</button>
        <button onClick={() => void control('reset')}>Reset sesi mock</button>
      </div>
      <p role="status">{message}</p>
      {snapshotError && <p role="alert">{snapshotError}</p>}
    </header>
    {snapshot && !snapshotError &&
      <MabangWmsOutbound stock={[]} orderHistory={selectSortingOrders(snapshot, localStorage.getItem(sortingTaskKey))}
        currentUser={user} onSortingSessionReleased={() => setSnapshot(current => current ? [...current] : current)}
        loadSortingReferences={async () => (await readSnapshot()).filter(order => order.sortingState === 'pending').map(order => order.referenceNumber)}
        resolveSortingTarget={async (code, candidates) => {
          const response = await fetch('/__sorting_mock/target', {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code, candidates})
          });
          if (!response.ok) throw new Error('Barcode tidak cocok, jumlah penuh, atau mock terputus.');
          const result: unknown = await response.json();
          if (!result || typeof result !== 'object' || !('reference' in result) || typeof result.reference !== 'string') {
            throw new Error('Target sorting mock tidak valid.');
          }
          return result.reference;
        }}
        clearSortingIndicatorOnSelection />}
  </>;
}

export const mockRoot = createRoot(document.getElementById('root')!);
mockRoot.render(<MockPage />);
