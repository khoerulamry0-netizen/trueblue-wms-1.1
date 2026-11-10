# 🚀 Panduan Setup WMS untuk Perusahaan / Klien Baru

Panduan ini berisi langkah-langkah praktis dan cepat untuk menduplikasi TrueBlue WMS ke perusahaan baru dengan database mandiri yang bersih (0 data).

---

## Ringkasan 3 Langkah Utama

1. **Buat Project Supabase Baru** (Database Cloud).
2. **Jalankan Master SQL** (Inisialisasi Tabel & Aturan Keamanan).
3. **Deploy Web ke Render / Vercel** (Aplikasi Frontend Siap Pakai).

---

## Langkah 1: Buat Project Supabase Baru

1. Buka [https://supabase.com](https://supabase.com) dan login ke akun Anda (atau akun milik klien).
2. Klik tombol **New project**.
3. Isi data:
   - **Name:** Misal `WMS-Gudang-PT-ABC`
   - **Database Password:** Buat password yang kuat dan catat.
   - **Region:** Pilih `Singapore (ap-southeast-1)` (paling cepat untuk Indonesia).
   - **Pricing Plan:** Free Tier (atau Pro sesuai kebutuhan).
4. Klik **Create new project** dan tunggu 1–2 menit sampai database siap.
5. Buka menu **Project Settings** (ikon gerigi di kiri bawah) -> klik **API**:
   - Salin **Project URL**
   - Salin **anon public key**
   - Simpan kedua kunci ini untuk Langkah 3.

---

## Langkah 2: Setup Database dengan 1 Kali Klik

1. Di Dashboard Supabase klien baru, buka menu **SQL Editor** di panel sebelah kiri.
2. Klik tombol **New query**.
3. Buka file `supabase/00_SETUP_BARU_LENGKAP.sql` yang ada di folder WMS ini:
   - Salin (**Select All -> Copy**) seluruh isi file tersebut.
   - Tempel (**Paste**) ke dalam SQL Editor di Supabase.
4. Klik tombol **Run** (tombol hijau).
5. Tunggu sampai muncul notifikasi **Success**.
   *(Semua tabel: profiles, documents, log, audit, aturan validasi, dan cabang default 'KOL' sudah selesai dibuat otomatis).*

---

## Langkah 3: Buat Akun Administrator Pertama

1. Di Dashboard Supabase, buka menu **Authentication** (ikon orang/kunci di panel kiri) -> pilih **Users**.
2. Klik tombol **Add user** -> pilih **Create user**.
3. Masukkan:
   - **Email:** Misal `admin@gudang.com`
   - **Password:** Password login admin (minimal 8 karakter).
   - Pastikan opsi **Auto Confirm User** dicentang.
4. Klik **Create user**.
5. Sekarang beri hak akses Administrator:
   - Masuk ke menu **Table Editor** -> pilih tabel `profiles`.
   - Temukan baris user yang baru saja dibuat.
   - Ubah kolom `role` dari `Viewer` menjadi `Administrator`.
   - Pastikan kolom `is_active` bernilai `true` (centang).

---

## Langkah 4: Hubungkan & Deploy Web (Render / Vercel)

### Pilihan A: Menggunakan Render (Rekomendasi)
1. Upload folder WMS ini ke repositori GitHub baru (misal: `github.com/username/wms-pt-abc`).
2. Buka [https://dashboard.render.com](https://dashboard.render.com) -> klik **New +** -> pilih **Static Site**.
3. Hubungkan ke repositori GitHub tadi.
4. Masukkan konfigurasi build:
   - **Build Command:** `npm run build`
   - **Publish Directory:** `dist`
5. Di bagian **Environment Variables**, tambahkan 2 variabel:
   - `VITE_SUPABASE_URL` = (Project URL dari Langkah 1)
   - `VITE_SUPABASE_ANON_KEY` = (Anon Public Key dari Langkah 1)
6. Klik **Create Static Site**.
7. Dalam 2–3 menit, website WMS klien sudah live dan memiliki URL sendiri (misal: `https://wms-pt-abc.onrender.com`).

---

## Selamat! WMS Sudah Siap Digunakan 🎉
- Buka link website yang sudah di-deploy.
- Login menggunakan email dan password Administrator yang dibuat pada Langkah 3.
- Admin sudah bisa langsung menambahkan katalog produk, membuat akun operator gudang (Picker/Packer), dan mulai mengimpor order!
