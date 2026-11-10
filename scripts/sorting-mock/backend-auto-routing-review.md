# Kandidat kontrak auto-routing sorting — review saja

Dokumen ini bukan SQL dan bukan migration. Belum ada implementasi backend yang
siap diterapkan. Routing dua langkah pada mock hanya untuk simulasi lokal dan
tidak memenuhi kebutuhan transaksi atau keamanan backend nyata.

## Usulan perubahan

- Buat sesi batch server yang mengikat cabang, operator terautentikasi,
  keranjang induk, daftar order dan basket tujuan yang telah divalidasi, serta
  snapshot/revisi order. Jangan percaya daftar kandidat yang dikirim per scan.
- Tambahkan RPC atomik `record_batch_sort_scan(batch_id, request_id, barcode)`.
  Dalam satu transaksi, periksa otorisasi cabang/operator, kunci batch dan
  order dengan urutan konsisten, cocokkan barcode dengan katalog server,
  verifikasi snapshot, lalu pilih basket yang masih membutuhkan SKU.
  Tetapkan urutan stabil berdasarkan posisi basket dan ID dokumen tersimpan.
- Simpan request ID, input, batch, operator, order, basket dan hasil dalam
  tabel event dengan constraint keunikan request per batch. Replay input yang
  identik harus mengembalikan hasil sebelumnya; penggunaan ID dengan input
  berbeda harus ditolak. Penentuan target dan pencatatan harus atomik agar
  dua request paralel tidak memilih kapasitas terakhir yang sama.
- Tambahkan RPC status batch yang mengembalikan identitas batch, revisi,
  status setiap order, counts dan event untuk pemulihan setelah respons hilang.
  Selesaikan order hanya melalui `finish_order_scan` yang ada atau kontrak
  atomik batch yang mempertahankan otorisasi dan pengecekan snapshot yang sama.
- Tolak SKU asing/ambigu, jumlah berlebih, basket tidak terikat, cabang atau
  operator salah, order berubah, dan transaksi baru pada order selesai. Batasi
  akses tabel privat dan ekspor RPC hanya kepada role yang diotorisasi.

## Pengujian sebelum penerapan

Uji PostgreSQL terisolasi, concurrency untuk SKU sama di beberapa order,
replay setelah commit dan sebelum commit, timeout, refresh, mutasi snapshot,
JWT/Auth/PostgREST, dan browser. Review juga integrasi packing serta atomicity
penyelesaian parsial. Jangan nyalakan flag atau lakukan migration sebelum
seluruh pemeriksaan dan persetujuan selesai.
