# Runbook Presentasi TRUEBLUE WMS

## Posisi produk

TRUEBLUE WMS adalah sistem operasional gudang yang menjaga alur stok, inbound, outbound, transfer,
stock opname, rekonsiliasi, return, operator, dan audit dalam satu sumber data. Presentasi harus memakai
browser dan akun Administrator; VS Code, terminal, Supabase Dashboard, serta credential tidak ditampilkan.

## Persiapan H-1

- Gunakan cabang demo dan akun Administrator khusus presentasi.
- Pastikan dashboard menunjukkan sinkronisasi berhasil.
- Siapkan 1 SKU, 1 order, 1 return baru, dan video MP4 pendek tanpa data pribadi.
- Buka Return > Daftar & Export Massal > Google Drive Evidence.
- Pastikan empat indikator koneksi berwarna hijau dan tertulis `Siap untuk demo dan operasional`.
- Jalankan alur lengkap sekali sebelum presentasi dan bersihkan data demo yang tidak diperlukan.
- Siapkan hotspot cadangan. Jangan mendemokan perubahan konfigurasi atau credential.

## Alur demo 12 menit

1. **Dashboard (1 menit)** — tunjukkan stok fisik, dialokasikan, tersedia, dan pekerjaan tertunda.
2. **Stok dan katalog (2 menit)** — cari SKU, tunjukkan ED, lokasi, status, dan satuan kemasan.
3. **Inbound/outbound (3 menit)** — jelaskan kontrol kuantitas dan jejak operator.
4. **Return dengan video (4 menit)** — buat kasus, rekam/pilih video, preview, upload, lalu QC ke Transit.
5. **Audit dan kontrol (1 menit)** — tunjukkan keputusan QC, operator, timestamp, dan proteksi stok ganda.
6. **Penutup (1 menit)** — jelaskan multi-cabang, role operator, backup, dan roadmap integrasi ERP.

## Narasi return

“Barang return tidak langsung menambah stok. Sistem menahannya di RETURN-QC, mewajibkan video unboxing,
memverifikasi file secara server-side, lalu Administrator memilih Transit, Karantina, atau Tolak. Posting stok
bersifat idempoten sehingga klik ulang tidak menggandakan kuantitas.”

## Batasan yang harus disampaikan jujur

- Integrasi Drive saat ini memakai service account per instalasi/backend.
- Untuk satu platform SaaS dengan banyak klien, tahap komersial berikutnya adalah OAuth per tenant.
- Upload operasional membutuhkan koneksi internet dan konfigurasi Drive yang sudah terverifikasi.

## Checklist go/no-go

Presentasi hanya dilanjutkan bila login, sinkronisasi, empat indikator Drive, upload video, QC, dan audit sudah
lulus tes. Jika Drive belum siap, gunakan rekaman layar alur yang sebelumnya berhasil—jangan menampilkan
credential atau berpura-pura bahwa upload live berhasil.
