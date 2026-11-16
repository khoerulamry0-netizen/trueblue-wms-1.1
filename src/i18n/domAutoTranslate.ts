const RAW_PHRASE_MAP: Array<[string, string]> = [
  // Sidebar & Administration
  ['Cabang aktif', 'Active branch'],
  ['Semua cabang · hanya lihat', 'All branches · view only'],
  ['Pilih cabang', 'Select branch'],
  ['Administrasi cabang', 'Branch administration'],
  ['Administrasi', 'Administration'],
  ['Dashboard Pusat', 'Central Dashboard'],
  ['Backup & Pemulihan', 'Backup & Recovery'],
  ['Aktivitas & Pembatalan', 'Activity & Cancellations'],
  ['Buku Mutasi', 'Stock Ledger'],
  ['Transfer Cabang', 'Branch Transfer'],
  ['Pengaturan Pengirim', 'Sender Settings'],
  ['Master Cabang', 'Branch Master'],
  ['Sembunyikan menu navigasi', 'Hide navigation menu'],
  ['Buka menu navigasi', 'Open navigation menu'],
  ['Tutup menu navigasi', 'Close navigation menu'],
  ['Tutup navigasi', 'Close navigation'],
  ['Menu utama', 'Main menu'],
  ['Pilih warna aksen', 'Choose accent color'],
  ['Warna aksen', 'Accent color'],
  ['Merah muda', 'Pink'],
  ['Gunakan mode terang', 'Switch to light mode'],
  ['Gunakan mode gelap', 'Switch to dark mode'],
  ['Tutup notifikasi', 'Close notification'],

  // Returns / QC
  ['Management Retur Barang', 'Product Return Management'],
  ['Terima Retur (Scan / Manual)', 'Receive Return (Scan / Manual)'],
  ['Import Massal Excel', 'Bulk Excel Import'],
  ['Daftar & Export Massal', 'List & Bulk Export'],
  ['Catat barang return dari customer melalui input manual, scan barcode, atau import Excel. Proses QC sebelum stok masuk ke Transit atau Karantina.', 'Record customer returns via manual input, barcode scan, or Excel import. Complete QC before stock enters Transit or Quarantine.'],
  ['Antrean QC Return', 'Return QC Queue'],
  ['Pilih keputusan QC untuk memposting stok ke Transit, Karantina, atau Tolak retur.', 'Select a QC decision to post stock to Transit, Quarantine, or Reject return.'],
  ['Posting stok terlindungi dari duplikasi', 'Stock posting protected against duplication'],
  ['Tidak ada return yang menunggu QC sesuai pencarian.', 'No returns awaiting QC match your search.'],
  ['Terima ke Transit', 'Accept to Transit'],
  ['SIAP QC', 'READY FOR QC'],
  ['Siap QC', 'Ready for QC'],
  ['Lewat SLA 24 jam', 'Over 24h SLA'],
  ['Kasus selesai', 'Completed Cases'],
  ['Total Transaksi', 'Total Transactions'],
  ['Total Customer', 'Total Customers'],
  ['Total Retur Pcs', 'Total Returned Pcs'],
  ['SKU Retur Berbeda', 'Unique Returned SKUs'],
  ['Semua Customer', 'All Customers'],
  ['Hari Ini', 'Today'],
  ['7 Hari Terakhir', 'Last 7 Days'],
  ['30 Hari Terakhir', 'Last 30 Days'],
  ['Semua Waktu', 'All Time'],
  ['Export Massal Excel (Semua Customer)', 'Bulk Export Excel (All Customers)'],
  ['Daftar Transaksi Retur Masuk', 'Incoming Return Transactions List'],
  ['Area Pemeriksaan: RETURN-QC', 'Inspection Area: RETURN-QC'],
  ['Form Pencatatan Retur Barang', 'Product Return Entry Form'],
  ['Kondisi Barang Klaim Customer', 'Customer Claimed Item Condition'],
  ['Alasan Retur / Keterangan', 'Return Reason / Remarks'],
  ['Simpan & Catat Barang Retur', 'Save & Record Return Item'],
  ['Panduan & Alur Retur', 'Return Guide & Workflow'],
  ['Stok Aman Sampai QC Selesai', 'Stock Protected Until QC Completes'],
  ['Pencatatan return tidak menambah stok jual sebelum keputusan QC diselesaikan.', 'Recording a return does not increase sellable stock until the QC decision is completed.'],
  ['Retur Terbaru Dicatat', 'Recently Recorded Returns'],
  ['Kemasan Rusak / Defect', 'Damaged Packaging / Defect'],

  // Stock / Inventory
  ['Manajemen Inventori & Stok Gudang', 'Warehouse Stock & Inventory Management'],
  ['Sinkronkan ke Cloud', 'Sync to Cloud'],
  ['Ambil dari Cloud', 'Pull from Cloud'],
  ['Tambah Stok Manual', 'Add Manual Stock'],
  ['Hapus Semua Stok', 'Clear All Stock'],
  ['Semua Gudang', 'All Warehouses'],
  ['Semua Lokasi', 'All Locations'],
  ['Semua Status', 'All Statuses'],
  ['Semua Kategori', 'All Categories'],
  ['Gudang Pusat (Jakarta)', 'Central Warehouse (Jakarta)'],
  ['Gudang Pusat (Central DC)', 'Central Warehouse (Central DC)'],
  ['Gudang Pusat', 'Central Warehouse'],
  ['Kantor pusat', 'Headquarters'],
  ['Kode SKU', 'SKU Code'],
  ['Nama Produk', 'Product Name'],
  ['Nama Barang', 'Item Name'],
  ['Tanggal Kedaluwarsa', 'Expiration Date'],
  ['Sisa ED', 'Remaining Shelf Life'],
  ['Lokasi Rak', 'Rack Location'],
  ['Total Stok', 'Total Stock'],
  ['Status ED', 'Expiry Status'],
  ['Tidak ada data stok yang sesuai filter.', 'No stock records match the current filter.'],
  ['Isi per karton (pcs)', 'Qty per carton (pcs)'],
  ['Isi per inner (pcs)', 'Qty per inner (pcs)'],
  ['Hasil kemasan otomatis:', 'Automatic pack breakdown:'],
  ['LABELLING RAK GUDANG', 'WAREHOUSE RACK LABELLING'],
  ['-- Pilih Lokasi --', '-- Select Location --'],
  ['-- Tidak Ada / Lewati --', '-- None / Skip --'],

  // Inbound
  ['Penerimaan Barang Masuk (Inbound)', 'Inbound Goods Receiving'],
  ['Input Manual / Scan', 'Manual Input / Scan'],
  ['Import File Excel', 'Import Excel File'],
  ['Riwayat Inbound', 'Inbound History'],
  ['Simpan Barang Masuk', 'Save Inbound Goods'],

  // Order & Outbound
  ['Import & Alokasi Order (FIFO / FEFO)', 'Order Import & Allocation (FIFO / FEFO)'],
  ['Daftar & Riwayat Order', 'Order List & History'],
  ['Antrean Pengambilan (Picker)', 'Picking Queue (Picker)'],
  ['Sortir 20 Keranjang', '20-Basket Sorting'],
  ['Meja Kemas & Timbang', 'Packing & Weighing Station'],
  ['Stasiun Kemas & Cetak Resi', 'Packing & Receipt Printing Station'],
  ['Batal / Kembalikan Stok', 'Cancel / Restore Stock'],
  ['Cetak Resi', 'Print Receipt'],
  ['Cetak Ulang Resi Terakhir', 'Reprint Last Receipt'],
  ['Menunggu Picking', 'Awaiting Picking'],
  ['Sedang Dipicking', 'Picking in Progress'],
  ['Siap Packing', 'Ready for Packing'],
  ['Selesai Packing', 'Packing Completed'],
  ['Semua Status Order', 'All Order Statuses'],
  ['Bisa Dibatalkan (Aktif / Belum Kirim)', 'Cancellable (Active / Not Shipped)'],
  ['Sudah Dibatalkan', 'Already Cancelled'],
  ['Sudah Dikirim', 'Already Shipped'],
  ['belum dikirim', 'not shipped'],
  ['Nomor Order / SKU', 'Order Number / SKU'],
  ['Tujuan / Customer', 'Destination / Customer'],
  ['Aksi Cepat', 'Quick Actions'],
  ['Alasan Pembatalan (Wajib minimal 5 karakter):', 'Cancellation Reason (Min. 5 characters required):'],
  ['Pilih cepat alasan umum:', 'Quick select common reason:'],
  ['Centang order yang ingin dibatalkan di atas.', 'Check the orders you want to cancel above.'],
  ['Memproses Pembatalan...', 'Processing Cancellation...'],
  ['Potong Stok WMS Pusat', 'Deduct Central WMS Stock'],
  ['Status Pengiriman', 'Shipping Status'],
  ['Ekspedisi / Kurir', 'Courier / Carrier'],
  ['Alokasi Order', 'Order Allocation'],
  ['Kembalikan keranjang kosong ke area stasiun setelah selesai.', 'Return empty baskets to the station area when finished.'],

  // Warehouse & Transfer
  ['Manajemen Sub-Gudang & Transfer Cabang', 'Sub-Warehouse & Branch Transfer Management'],
  ['Pindah Lokasi Rak (Internal)', 'Internal Rack Location Transfer'],
  ['Transfer Antar Gudang', 'Inter-Warehouse Transfer'],
  ['Transfer Rak Internal', 'Internal Rack Transfer'],
  ['Transfer Masuk (Luar)', 'Inbound Transfer (External)'],
  ['Transfer Keluar (Luar)', 'Outbound Transfer (External)'],
  ['Daftar Gudang', 'Warehouse List'],
  ['Matriks Stok Gudang', 'Warehouse Stock Matrix'],
  ['Riwayat Transfer', 'Transfer History'],
  ['Tambah Sub-Gudang', 'Add Sub-Warehouse'],
  ['Kirim & Proses Transfer Stok', 'Submit & Process Stock Transfer'],
  ['Kode Cabang', 'Branch Code'],
  ['Nama Cabang', 'Branch Name'],
  ['Dari Lokasi', 'From Location'],
  ['Ke Lokasi', 'To Location'],
  ['Jumlah Pcs', 'Qty (Pcs)'],
  ['Deskripsi / Dokumen', 'Description / Document'],

  // Stock Opname (DCC), Audit & Reconciliation
  ['Daily Cycle Count (Stock Opname Per Lokasi)', 'Daily Cycle Count (Location Stock Opname)'],
  ['Cek Fisik & Audit Stok', 'Physical Check & Stock Audit'],
  ['Cek Fisik / Adjustment', 'Physical Check / Adjustment'],
  ['Rekonsiliasi Stok (ERP vs WMS)', 'Stock Reconciliation (ERP vs WMS)'],
  ['Katalog Master Produk', 'Master Product Catalog'],
  ['Tambah SKU Baru', 'Add New SKU'],
  ['Sinkronisasi dari Stok', 'Sync from Stock'],
  ['Stok Sistem', 'System Stock'],
  ['Total Fisik:', 'Total Physical:'],
  ['Filter & Pencarian Lanjutan', 'Advanced Filter & Search'],
  ['Semua Tipe Transaksi', 'All Transaction Types'],
  ['Inbound (Masuk)', 'Inbound (In)'],
  ['Outbound (Keluar)', 'Outbound (Out)'],
  ['Semua Operator Staf', 'All Operator Staff'],
  ['Waktu (WIB)', 'Time (WIB)'],
  ['Tipe Mutasi', 'Movement Type'],
  ['Barang & SKU', 'Item & SKU'],
  ['Qty Mutasi', 'Movement Qty'],
  ['Rincian Riwayat Mutasi', 'Movement History Details'],
  ['Tidak ditemukan data mutasi yang cocok dengan kriteria filter.', 'No movement records match the filter criteria.'],
  ['Belum ada aktivitas yang sesuai filter.', 'No activities match the current filter.'],

  // Analytics & Strategic
  ['Jumlah unit stok yang tercatat di database', 'Total stock units recorded in the database'],
  ['SKU Unik', 'Unique SKUs'],
  ['Operator Tercatat', 'Recorded Operators'],
  ['Keputusan Strategis (Data-Driven)', 'Strategic Decisions (Data-Driven)'],
  ['Kurangi Pesanan Baru untuk Deadstock', 'Reduce New Orders for Deadstock'],
  ['Amankan Buffer Stock Fast Moving', 'Secure Buffer Stock for Fast-Moving Items'],
  ['Akuntabilitas Operator & Shift Gudang', 'Operator & Warehouse Shift Accountability'],

  // Security & Account
  ['Ganti password akun WMS', 'Change WMS Account Password'],
  ['Password akun berhasil diganti.', 'Account password changed successfully.'],
  ['Password akun saat ini', 'Current account password'],
  ['Password saat ini', 'Current password'],
  ['Password baru', 'New password'],
  ['Ulangi password baru', 'Repeat new password'],
  ['Ganti password & keluarkan sesi lain', 'Change password & sign out other sessions'],
  ['Isi sendiri di sini. Password tidak perlu dikirim ke chat (dilindungi Leaked Password Protection).', 'Enter directly here. Do not share your password in chat (protected by Leaked Password Protection).'],
  ['Belum ada akun operator yang terlihat.', 'No operator accounts visible.'],
  ['Menyimpan transaksi…', 'Saving transaction...'],
  ['Perubahan belum tersimpan', 'Changes not saved'],
  ['Tunggu sampai server mengonfirmasi. Jangan tutup halaman.', 'Wait until the server confirms. Do not close this page.'],
  ['Periksa stok terbaru sebelum mengulang. Jika koneksi terputus, periksa riwayat untuk memastikan transaksi sebelumnya sudah masuk.', 'Check the latest stock before retrying. If the connection dropped, check history to confirm whether the previous transaction was saved.'],
  ['Muat data terbaru', 'Load latest data'],
  ['Versi WMS terbaru sudah tersedia.', 'A new WMS version is already available.'],
  ['Muat ulang versi terbaru', 'Reload latest version'],
  ['Menyimpan sortir…', 'Saving sorting...'],
  ['Sortir belum tersimpan. Hasil scan tetap tersedia; periksa pesan kesalahan sebelum mengulang.', 'Sorting not saved yet. Scan progress is still available; check the error message before retrying.'],
  ['Tampilkan rincian order', 'Show order details'],
  ['Sembunyikan rincian order', 'Hide order details'],
  ['Minimize Semua Order', 'Minimize All Orders'],
  ['Maximize Semua Order', 'Maximize All Orders'],
  ['Print Resi Order', 'Print Order Receipt'],
  ['Alamat Customer', 'Customer Address']
];

const SORTED_PHRASE_MAP = [...RAW_PHRASE_MAP].sort((a, b) => b[0].length - a[0].length);

const WORD_DICTIONARY: Record<string, string> = {
  // Core WMS nouns
  stok: 'stock',
  gudang: 'warehouse',
  cabang: 'branch',
  pusat: 'central',
  kantor: 'office',
  rak: 'rack',
  lokasi: 'location',
  zona: 'zone',
  barang: 'item',
  produk: 'product',
  katalog: 'catalog',
  keranjang: 'basket',
  karton: 'carton',
  dus: 'box',
  eceran: 'loose',
  kemasan: 'packaging',
  satuan: 'unit',
  jumlah: 'quantity',
  kuantitas: 'quantity',
  selisih: 'variance',
  saldo: 'balance',
  fisik: 'physical',
  sistem: 'system',
  mutasi: 'movement',
  rekonsiliasi: 'reconciliation',
  penyesuaian: 'adjustment',
  pemindahan: 'transfer',
  pengosongan: 'clearing',
  pemotongan: 'deduction',
  alokasi: 'allocation',
  antrean: 'queue',
  riwayat: 'history',
  daftar: 'list',
  rincian: 'details',
  ringkasan: 'summary',
  laporan: 'report',
  dokumen: 'document',
  surat: 'letter',
  resi: 'receipt',
  stiker: 'sticker',
  bukti: 'proof',
  catatan: 'notes',
  keterangan: 'description',
  deskripsi: 'description',
  alasan: 'reason',
  kriteria: 'criteria',
  aturan: 'rule',
  panduan: 'guide',
  petunjuk: 'instructions',
  instruksi: 'instructions',
  peringatan: 'warning',
  perhatian: 'attention',
  solusi: 'solution',
  kesalahan: 'error',
  kendala: 'issue',
  keamanan: 'security',
  pemulihan: 'recovery',
  cadangan: 'backup',
  arsip: 'archive',
  pengaturan: 'settings',
  konfigurasi: 'configuration',
  tampilan: 'view',
  halaman: 'page',
  baris: 'rows',
  kolom: 'column',
  tabel: 'table',
  grafik: 'chart',
  kartu: 'card',
  tombol: 'button',
  ikon: 'icon',
  warna: 'color',
  aksen: 'accent',
  kustom: 'custom',
  bawaan: 'default',
  bahasa: 'language',
  pencarian: 'search',
  pilihan: 'selection',
  opsi: 'option',
  tindakan: 'action',
  aksi: 'action',
  keputusan: 'decision',
  konfirmasi: 'confirmation',
  verifikasi: 'verification',
  validasi: 'validation',
  pemeriksaan: 'inspection',
  penghapusan: 'deletion',
  pembatalan: 'cancellation',
  penerimaan: 'receiving',
  pengambilan: 'picking',
  penyortiran: 'sorting',
  sortir: 'sort',
  pengemasan: 'packing',
  pengiriman: 'shipping',
  serah: 'handover',
  terima: 'receive',
  pesanan: 'order',
  transaksi: 'transaction',
  aktivitas: 'activity',
  sesi: 'session',
  jadwal: 'schedule',
  periode: 'period',
  gelombang: 'wave',
  rute: 'route',
  tujuan: 'destination',
  asal: 'origin',
  alamat: 'address',
  kota: 'city',
  telepon: 'phone',
  pelanggan: 'customer',
  pembeli: 'buyer',
  penerima: 'recipient',
  pengirim: 'sender',
  pemasok: 'supplier',
  kurir: 'courier',
  ekspedisi: 'carrier',
  armada: 'fleet',
  kendaraan: 'vehicle',
  plat: 'plate',
  supir: 'driver',
  pengemudi: 'driver',
  petugas: 'officer',
  staf: 'staff',
  pengguna: 'user',
  akun: 'account',
  peran: 'role',
  sandi: 'password',
  akses: 'access',
  perangkat: 'device',
  kamera: 'camera',
  suara: 'sound',
  berat: 'weight',
  ukuran: 'size',
  tingkat: 'level',
  persentase: 'percentage',
  akurasi: 'accuracy',
  kondisi: 'condition',
  jenis: 'type',
  tipe: 'type',
  kategori: 'category',
  merek: 'brand',
  gambar: 'image',
  lembar: 'sheet',
  rangkap: 'copies',
  salinan: 'copy',
  nomor: 'number',
  kode: 'code',
  nama: 'name',
  judul: 'title',
  tanggal: 'date',
  waktu: 'time',
  hari: 'day',
  minggu: 'week',
  bulan: 'month',
  tahun: 'year',
  jam: 'hour',
  menit: 'minute',
  detik: 'second',
  orang: 'people',
  kasus: 'case',
  meja: 'station',
  stasiun: 'station',
  buku: 'ledger',

  // Verbs & Actions
  pilih: 'select',
  cari: 'search',
  simpan: 'save',
  menyimpan: 'saving',
  tersimpan: 'saved',
  batal: 'cancel',
  batalkan: 'cancel',
  dibatalkan: 'cancelled',
  tutup: 'close',
  buka: 'open',
  membuka: 'opening',
  tambah: 'add',
  tambahkan: 'add',
  ubah: 'edit',
  mengubah: 'editing',
  ganti: 'change',
  diganti: 'changed',
  hapus: 'delete',
  dihapus: 'deleted',
  kosongkan: 'clear',
  cetak: 'print',
  mencetak: 'printing',
  unduh: 'download',
  mengunduh: 'downloading',
  unggah: 'upload',
  mengunggah: 'uploading',
  impor: 'import',
  ekspor: 'export',
  salin: 'copy',
  tersalin: 'copied',
  tempel: 'paste',
  pindai: 'scan',
  dipindai: 'scanned',
  tembak: 'scan',
  muat: 'load',
  memuat: 'loading',
  segarkan: 'refresh',
  perbarui: 'update',
  memperbarui: 'updating',
  diperbarui: 'updated',
  sinkronkan: 'sync',
  sinkronisasi: 'synchronization',
  hubungkan: 'connect',
  sambungkan: 'connect',
  terhubung: 'connected',
  kirim: 'send',
  dikirim: 'shipped',
  terkirim: 'shipped',
  ambil: 'pick',
  diambil: 'picked',
  kembalikan: 'restore',
  mengembalikan: 'restoring',
  pindahkan: 'move',
  potong: 'deduct',
  terpotong: 'deducted',
  gabungkan: 'merge',
  gantikan: 'replace',
  timpa: 'overwrite',
  terapkan: 'apply',
  diterapkan: 'applied',
  proses: 'process',
  memproses: 'processing',
  diproses: 'processed',
  mulai: 'start',
  lanjut: 'continue',
  lanjutkan: 'continue',
  melanjutkan: 'continuing',
  selesai: 'completed',
  selesaikan: 'complete',
  diselesaikan: 'completed',
  tolak: 'reject',
  ditolak: 'rejected',
  karantina: 'quarantine',
  lihat: 'view',
  melihat: 'viewing',
  dilihat: 'viewed',
  tampilkan: 'show',
  menampilkan: 'showing',
  sembunyikan: 'hide',
  disembunyikan: 'hidden',
  periksa: 'check',
  memeriksa: 'checking',
  diperiksa: 'checked',
  cek: 'check',
  hitung: 'count',
  dihitung: 'counted',
  cocokkan: 'match',
  samakan: 'match',
  masukkan: 'enter',
  ketik: 'type',
  tuliskan: 'write',
  klik: 'click',
  centang: 'check',
  lewati: 'skip',
  gunakan: 'use',
  izinkan: 'allow',
  pastikan: 'ensure',
  siapkan: 'prepare',
  terbitkan: 'publish',

  // Adjectives, Statuses & Connectors
  semua: 'all',
  seluruh: 'all',
  setiap: 'every',
  beberapa: 'several',
  banyak: 'many',
  satu: 'one',
  dua: 'two',
  tiga: 'three',
  pertama: 'first',
  kedua: 'second',
  terakhir: 'last',
  berikutnya: 'next',
  selanjutnya: 'next',
  sebelumnya: 'previous',
  sebelum: 'before',
  sesudah: 'after',
  setelah: 'after',
  sekarang: 'now',
  ini: 'this',
  itu: 'that',
  ada: 'available',
  tidak: 'not',
  bukan: 'not',
  belum: 'not yet',
  sudah: 'already',
  telah: 'has',
  sedang: 'currently',
  akan: 'will',
  dapat: 'can',
  bisa: 'can',
  harus: 'must',
  wajib: 'required',
  perlu: 'needed',
  opsional: 'optional',
  hanya: 'only',
  saja: 'only',
  tanpa: 'without',
  dengan: 'with',
  untuk: 'for',
  dari: 'from',
  ke: 'to',
  di: 'in',
  pada: 'on',
  oleh: 'by',
  atau: 'or',
  dan: 'and',
  jika: 'if',
  tetapi: 'but',
  namun: 'however',
  karena: 'because',
  agar: 'so that',
  melalui: 'via',
  secara: 'by',
  antar: 'inter',
  dalam: 'in',
  luar: 'external',
  atas: 'top',
  bawah: 'bottom',
  kiri: 'left',
  kanan: 'right',
  baru: 'new',
  lama: 'old',
  terbaru: 'latest',
  utama: 'main',
  khusus: 'special',
  umum: 'general',
  otomatis: 'automatic',
  langsung: 'direct',
  cepat: 'quick',
  massal: 'bulk',
  lengkap: 'complete',
  kosong: 'empty',
  penuh: 'full',
  aktif: 'active',
  nonaktif: 'inactive',
  dinonaktifkan: 'disabled',
  siap: 'ready',
  menunggu: 'waiting',
  tersedia: 'available',
  terdaftar: 'registered',
  tercatat: 'recorded',
  terpilih: 'selected',
  terkunci: 'locked',
  terverifikasi: 'verified',
  terkonfirmasi: 'confirmed',
  dikonfirmasi: 'confirmed',
  diserahkan: 'handed over',
  berhasil: 'successful',
  gagal: 'failed',
  aman: 'safe',
  baik: 'good',
  bagus: 'good',
  rusak: 'damaged',
  kedaluwarsa: 'expired',
  mendekati: 'approaching',
  menipis: 'low',
  kurang: 'less',
  lebih: 'more',
  maksimal: 'maximum',
  minimal: 'minimum',
  sama: 'same',
  beda: 'different',
  berbeda: 'different',
  unik: 'unique',
  cocok: 'matched',
  sesuai: 'matching',
  salah: 'wrong',
  benar: 'correct',
  sah: 'valid',
  permanen: 'permanent',
  sementara: 'temporary',
  harian: 'daily',
  bulanan: 'monthly',
  tahunan: 'yearly',
  masuk: 'in',
  keluar: 'out',
  kembali: 'back',
  ulang: 'again',
  ulangi: 'repeat',
  contoh: 'example',
  misal: 'e.g.',
  silakan: 'please',
  ditemukan: 'found',
  hilang: 'missing'
};

const WORD_REGEX = new RegExp(
  `\\b(${Object.keys(WORD_DICTIONARY).sort((a, b) => b.length - a.length).join('|')})\\b`,
  'gi'
);

function matchCase(source: string, target: string): string {
  if (!source) return target;
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return target.toUpperCase();
  }
  if (source[0] === source[0].toUpperCase() && source.slice(1) === source.slice(1).toLowerCase()) {
    return target.charAt(0).toUpperCase() + target.slice(1);
  }
  return target;
}

const originalTextMap = new WeakMap<Text, string>();
const lastTranslatedMap = new WeakMap<Text, string>();
const originalAttrMap = new WeakMap<Element, Record<string, string>>();
const lastTranslatedAttrMap = new WeakMap<Element, Record<string, string>>();

export function translateStringToEn(input: string): string {
  if (!input || !/[a-zA-Z]/.test(input)) return input;
  let result = input;

  // 1. Multi-word phrase pass
  for (const [idPhrase, enPhrase] of SORTED_PHRASE_MAP) {
    if (result.toLowerCase().includes(idPhrase.toLowerCase())) {
      const escaped = idPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'gi'), match => matchCase(match, enPhrase));
    }
  }

  // 2. Word-by-word pass
  result = result.replace(WORD_REGEX, match => {
    const replacement = WORD_DICTIONARY[match.toLowerCase()];
    if (!replacement) return match;
    return matchCase(match, replacement);
  });

  return result;
}

export function applyDomLanguage(language: 'id' | 'en', root: HTMLElement = document.body): void {
  if (!root) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE' || tag === 'TEXTAREA') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let current = walker.nextNode() as Text | null;
  while (current) {
    const raw = current.nodeValue || '';
    if (raw.trim().length > 1) {
      if (language === 'en') {
        const lastOut = lastTranslatedMap.get(current);
        const base = lastOut === raw ? (originalTextMap.get(current) ?? raw) : raw;
        if (lastOut !== raw) {
          originalTextMap.set(current, raw);
        }
        const translated = translateStringToEn(base);
        if (translated !== raw) {
          lastTranslatedMap.set(current, translated);
          current.nodeValue = translated;
        }
      } else if (originalTextMap.has(current)) {
        const orig = originalTextMap.get(current)!;
        if (lastTranslatedMap.get(current) === raw && current.nodeValue !== orig) {
          current.nodeValue = orig;
        }
        lastTranslatedMap.delete(current);
      }
    }
    current = walker.nextNode() as Text | null;
  }

  const elements = root.querySelectorAll('[placeholder],[title],[aria-label]');
  elements.forEach(el => {
    const savedAttrs = originalAttrMap.get(el) || {};
    const lastAttrs = lastTranslatedAttrMap.get(el) || {};
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      if (language === 'en') {
        const base = lastAttrs[attr] === val ? (savedAttrs[attr] ?? val) : val;
        if (lastAttrs[attr] !== val) {
          savedAttrs[attr] = val;
          originalAttrMap.set(el, savedAttrs);
        }
        const translated = translateStringToEn(base);
        if (translated !== val) {
          lastAttrs[attr] = translated;
          lastTranslatedAttrMap.set(el, lastAttrs);
          el.setAttribute(attr, translated);
        }
      } else if (savedAttrs[attr]) {
        if (lastAttrs[attr] === val && val !== savedAttrs[attr]) {
          el.setAttribute(attr, savedAttrs[attr]);
        }
        delete lastAttrs[attr];
        lastTranslatedAttrMap.set(el, lastAttrs);
      }
    }
  });
}
