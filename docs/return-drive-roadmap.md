# Return dan Video Unboxing — Roadmap

## Tahap 1 — Fondasi kasus return

- Menu Return tampil untuk Admin dan Administrator.
- Setiap penerimaan mendapat `caseId`, nomor return, cabang, kondisi klaim, serta status evidence.
- Status awal `AWAITING_VIDEO` dan area pemeriksaan `RETURN-QC`.
- Pencatatan return tidak mengubah stok. Mutasi stok menunggu keputusan QC.

## Tahap 2 — QC dan mutasi stok terkontrol

- Tambahkan antrean QC dengan keputusan terima, karantina, atau tolak.
- Posting stok dilakukan sekali melalui transaksi idempotent.
- Simpan operator, alasan, waktu keputusan, dan audit log.
- Larang QC sebelum evidence video berstatus `READY`.

## Tahap 3 — Konfigurasi Google Drive oleh Administrator

- Gunakan Shared Drive milik organisasi dan service account khusus WMS.
- Credential hanya menjadi secret server; browser tidak pernah menerimanya.
- Administrator mengatur Shared Drive ID, folder induk, batas file, dan retensi.
- Endpoint server menyediakan tes koneksi dan membuat struktur folder kasus.

Implementasi: panel konfigurasi dan endpoint admin tersedia. Secret backend yang wajib dipasang bernama
`GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`; nilainya tidak disimpan di database dan tidak pernah dikirim ke browser.
Folder induk harus dibagikan kepada email service account sebagai Content manager.

## Tahap 4 — Video unboxing resumable

- Server membuat sesi resumable Google Drive untuk kasus yang sah.
- Browser mengunggah langsung ke sesi tersebut dengan progress dan resume.
- Setelah upload selesai, server memverifikasi file lalu menyimpan `driveFileId`, MIME, ukuran, checksum, operator, dan waktu.
- File tidak dibuat publik dan tidak dapat ditimpa.

Implementasi: browser mengirim video dalam chunk 8 MiB ke session URI berumur terbatas. Backend kemudian
membaca ulang metadata Drive dan memverifikasi cabang, kasus, folder induk, MIME, ukuran, dan checksum sebelum
mengubah evidence menjadi `READY`. Sesi gagal dapat melanjutkan dari byte terakhir yang dikonfirmasi Drive.

## Tahap 5 — Operasional dan pengawasan

- Rekam kamera dari perangkat mobile, preview video, retry, dan status upload.
- Dashboard SLA return, pencarian kasus, export, serta kebijakan retensi.
- Penghapusan evidence hanya oleh Administrator dan selalu diaudit.

Implementasi: perangkat mobile dapat merekam dari kamera belakang, meninjau video sebelum upload, dan mencoba
ulang file yang sama bila jaringan terputus. Dashboard menampilkan antrean menunggu video, siap QC, lewat SLA
24 jam, dan selesai. Penghapusan memindahkan file ke Trash, membutuhkan alasan, dilarang setelah QC, dan dicatat.
