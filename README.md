# BLUES WMS

Satu aplikasi WMS yang menggabungkan alur stok, FEFO, inbound, outbound, picking dan packing Mabang, batch, transfer gudang, retur, stock opname, label, analitik, dan asisten operasional dari empat arsip yang diberikan.

Data operasional disimpan bersama di satu proyek Supabase. Perangkat yang masuk ke proyek dan alamat aplikasi yang sama menerima perubahan melalui Supabase Realtime.

## Menyiapkan Supabase

1. Buat proyek Supabase di akun Anda.
2. Jalankan seluruh isi `supabase/migrations/20261105000000_unified_wms.sql` lewat SQL Editor. Migrasi membuat tabel profil dan dokumen WMS, kebijakan akses RLS, serta publikasi Realtime.
3. Di pengaturan Authentication, matikan pendaftaran publik. Atur Site URL dan Redirect URLs agar sesuai dengan alamat aplikasi.
4. Buat akun pertama lewat Authentication > Users. Aktifkan akun tersebut sebagai admin pertama melalui SQL Editor:

   ```sql
   update public.profiles
   set role = 'Administrator', is_active = true
   where email = 'admin@perusahaan.co.id';
   ```

   Ganti alamat email contoh dengan email akun yang baru dibuat. Setelah masuk, admin dapat mengundang operator dari menu Kelola Operator.
5. Pasang Supabase CLI dan login. Hubungkan proyek WMS ke proyek Supabase Anda, lalu terapkan migrasi ke database hosted:

   ```sh
   supabase login
   supabase link --project-ref PROJECT_REF
   supabase db push --remote
   ```

   Periksa konfirmasi CLI sebelum migrasi dijalankan. CLI Supabase terbaru menargetkan database lokal secara default; `--remote` diperlukan untuk database hosted.
6. Deploy fungsi undangan dan pengelolaan akun:

   ```sh
   supabase functions deploy admin-users --project-ref PROJECT_REF
   ```

7. Untuk produksi, atur `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, dan `SUPABASE_ANON_KEY` langsung pada environment hosting dari Project Settings > API. Jangan masukkan service-role key ke variabel `VITE_*` atau ke browser. Jangan gunakan URL atau key project hosted di `.env` lokal atau `npm run dev`.

## Development dengan database terpisah

Development lokal hanya menerima Supabase lokal pada `http://127.0.0.1:54321`. URL frontend dan backend serta anon key-nya harus cocok; server akan menolak startup jika konfigurasi hilang, berbeda, atau menunjuk ke project hosted. Jangan arahkan file `.env` lokal ke project produksi.

1. Pasang Docker Desktop dan Supabase CLI.
2. Dari folder proyek, jalankan `npm.cmd run supabase:local:migrations` lalu `npm.cmd run supabase:local:check`. Perintah ini hanya merakit dan memeriksa SQL; tidak menyalakan database atau menerapkan migrasi.
3. Setelah memeriksa hasilnya, developer dapat menyalakan Supabase lokal sendiri dan menerapkan migrasi berurutan pada database lokal. Gunakan `supabase status` untuk memastikan API lokal.
4. Untuk bootstrap, jalankan `npm.cmd run supabase:local:bootstrap-admin` dengan kredensial lokal setelah akun berhasil sign-in. Seed dua operator dan data sintetis dengan `npm.cmd run supabase:local:seed`.
5. Jalankan `npm.cmd run supabase:local:setup`. Perintah ini memeriksa Git dan preflight lokal sebelum mengisi URL dan anon key di `.env`, tanpa mencetak key atau menyalin service-role key. Pengaturan `.env` lain dipertahankan; pengaturan yang ambigu ditolak.
6. Jika setup berhasil, jalankan `npm.cmd run dev`, lalu buka `http://127.0.0.1:3000` (atau port yang ditetapkan pada `PORT`). Server development hanya mendengarkan pada loopback. Skrip ini selalu memakai pagar development meskipun environment shell salah mengatur `NODE_ENV=production`; pada kondisi itu startup akan dihentikan dengan pesan yang jelas. Variabel shell memiliki prioritas atas `.env`; hapus variabel Supabase yang bertentangan dari shell sebelum memulai.

### Mencoba BIG BASKET pada sortir baseline lokal

Mode ini khusus development lokal, memakai hitungan scan di browser tanpa validasi server, dan **bukan untuk operasional**. Ia tidak menyatakan kesamaan kode dengan deployment. Packing tetap mengikuti pembatasan development yang ada.

Dengan Supabase lokal yang sudah dikonfigurasi dan data uji order yang sudah selesai dipick dalam satu keranjang induk, dari PowerShell di folder proyek jalankan:

```powershell
$env:VITE_DEV_BASELINE_SORTING = 'true'
Remove-Item Env:VITE_SERVER_SCAN_ENABLED -ErrorAction SilentlyContinue
npm.cmd run dev
```

Pastikan `VITE_SERVER_SCAN_ENABLED` juga tidak bernilai `true` di `.env`; kedua mode tidak boleh aktif bersamaan. Masuk sebagai Packer, buka Mabang / Sortir, muat keranjang induk, dan aktifkan **BIG BASKET**. Scan SKU pada order: tujuan dipilih otomatis dan ditampilkan besar. Scan SKU yang salah atau berlebih harus menampilkan kesalahan tanpa instruksi memasukkan barang. Setelah semua barang terscan, **Selesaikan sortir** memakai penyimpanan baseline ke database lokal yang dikonfigurasi. Untuk kembali ke mode biasa, hentikan server dan hapus variabel `VITE_DEV_BASELINE_SORTING` dari shell sebelum menjalankannya lagi.

`supabase/config.toml` menggunakan project ID lokal `unified-wms-dev`; gunakan [panduan migrasi lokal](./supabase/LOCAL-DEVELOPMENT.md). Skrip bootstrap dan seed hanya menerima API Supabase lokal di loopback `127.0.0.1:54321`, memakai service-role key yang diberikan oleh status CLI lokal, dan tidak menyimpan key ke file. Jangan gunakan `supabase link` atau data produksi untuk development.

## Menjalankan aplikasi

```sh
npm install
npm run dev
```

Server pengembangan berjalan di port 3000 dan dapat dijangkau perangkat lain di jaringan yang sama. Untuk akses dari luar jaringan lokal, deploy server ke hosting yang menjalankan Node.js dengan HTTPS, lalu tambahkan alamat publik ke Redirect URLs Supabase. Semua perangkat harus membuka alamat aplikasi yang sama dan masuk dengan akun masing-masing.

Asisten WMS memakai Gemini secara opsional. Isi `GEMINI_API_KEY` di `.env` server jika fitur tersebut diperlukan. Kunci ini hanya digunakan oleh server.

Pada development lokal, Asisten selalu memakai jalur `/api/chat` di server lokal dan mengabaikan `VITE_ASSISTANT_API_URL`. Jika pemisahan frontend dan server telah disetujui, gunakan `VITE_ASSISTANT_API_URL` untuk origin server Asisten, `WMS_ALLOWED_ORIGINS` untuk daftar origin frontend yang diizinkan (dipisahkan koma), dan `WMS_FRONTEND_URL` untuk origin HTTPS tujuan tautan lama. `WMS_API_ONLY=true` menonaktifkan penyajian frontend oleh server API. Origin Asisten dan CORS harus HTTPS, kecuali HTTP pada loopback lokal. Mengubah konfigurasi hosting atau melakukan deployment memerlukan persetujuan terpisah.

## Data dan akses

- Database baru tidak diisi otomatis dengan stok contoh. Admin dapat mengimpor data operasional melalui aplikasi.
- Semua akun aktif dalam satu proyek Supabase memakai ruang data WMS bersama.
- RLS membatasi akses database menurut status aktif dan peran akun. Password dikelola Supabase Auth.
- Perubahan tersimpan dikirim ke perangkat yang sedang online. Jika koneksi internet terputus, simpan ulang perubahan setelah tersambung kembali; aplikasi tidak mengantrekan perubahan offline.
- Draf pemeriksaan fisik yang belum dikirim masih disimpan pada perangkat tempat draf dibuat.

Berkas ini menyiapkan aplikasi dan migrasi database. Proyek Supabase hosted belum dibuat atau dihubungkan; URL dan anon key proyek perlu dimasukkan ke `.env` sebelum aplikasi dapat dipakai.
