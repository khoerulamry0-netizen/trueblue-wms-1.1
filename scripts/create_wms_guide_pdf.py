from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics
from reportlab.lib.colors import HexColor
from pathlib import Path

OUT = Path('output/pdf/panduan-penggunaan-trueblue-wms.pdf')
OUT.parent.mkdir(parents=True, exist_ok=True)

doc = SimpleDocTemplate(str(OUT), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=17*mm, bottomMargin=17*mm)
styles = getSampleStyleSheet()
navy = HexColor('#12324A')
blue = HexColor('#1E6B8F')
teal = HexColor('#0E8A83')
light = HexColor('#EAF4F7')
muted = HexColor('#526572')

styles.add(ParagraphStyle(name='CoverTitle', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=25, leading=30, textColor=navy, alignment=TA_CENTER, spaceAfter=12))
styles.add(ParagraphStyle(name='CoverSub', parent=styles['Normal'], fontName='Helvetica', fontSize=12, leading=18, textColor=muted, alignment=TA_CENTER, spaceAfter=8))
styles.add(ParagraphStyle(name='H1x', parent=styles['Heading1'], fontName='Helvetica-Bold', fontSize=17, leading=21, textColor=navy, spaceBefore=10, spaceAfter=8))
styles.add(ParagraphStyle(name='H2x', parent=styles['Heading2'], fontName='Helvetica-Bold', fontSize=12, leading=16, textColor=blue, spaceBefore=8, spaceAfter=5))
styles.add(ParagraphStyle(name='Bodyx', parent=styles['BodyText'], fontName='Helvetica', fontSize=9.5, leading=14, textColor=HexColor('#1F2D35'), spaceAfter=5))
styles.add(ParagraphStyle(name='Smallx', parent=styles['BodyText'], fontName='Helvetica', fontSize=8, leading=11, textColor=muted, spaceAfter=3))
styles.add(ParagraphStyle(name='Step', parent=styles['BodyText'], fontName='Helvetica', fontSize=9.5, leading=14, leftIndent=8, firstLineIndent=-8, textColor=HexColor('#1F2D35'), spaceAfter=4))
styles.add(ParagraphStyle(name='Callout', parent=styles['BodyText'], fontName='Helvetica-Bold', fontSize=9, leading=13, textColor=navy, backColor=light, borderColor=HexColor('#B9DDE5'), borderWidth=0.5, borderPadding=7, spaceBefore=5, spaceAfter=7))

def P(text, style='Bodyx'):
    return Paragraph(text, styles[style])

def bullet(text):
    return P('&bull; ' + text, 'Bodyx')

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(HexColor('#D5E1E6'))
    canvas.line(18*mm, 12*mm, A4[0]-18*mm, 12*mm)
    canvas.setFont('Helvetica', 7.5)
    canvas.setFillColor(muted)
    canvas.drawString(18*mm, 7*mm, 'TRUEBLUE WMS - Panduan Operasional')
    canvas.drawRightString(A4[0]-18*mm, 7*mm, f'Halaman {doc.page}')
    canvas.restoreState()

story = []
story += [Spacer(1, 35*mm), P('TRUEBLUE WMS', 'CoverTitle'), P('Panduan Penggunaan Operasional', 'CoverSub'), Spacer(1, 8*mm)]
story += [P('Panduan ringkas untuk mengelola stok, inbound, outbound, sortir, packing, transfer gudang, dan audit operasional.', 'CoverSub'), Spacer(1, 22*mm)]
cover = Table([[P('<b>Versi panduan</b><br/>14 November 2026', 'Bodyx'), P('<b>Pengguna</b><br/>Administrator, Admin, Picker, Packer, Viewer', 'Bodyx')]], colWidths=[75*mm, 90*mm])
cover.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),light),('BOX',(0,0),(-1,-1),0.6,HexColor('#B9DDE5')),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),10),('RIGHTPADDING',(0,0),(-1,-1),10),('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9)]))
story += [cover, Spacer(1, 18*mm), P('Dokumen ini mengikuti menu dan alur yang tersedia pada aplikasi TRUEBLUE WMS. Nama menu dapat berbeda sedikit sesuai bahasa, peran akun, dan hak akses.', 'Smallx'), PageBreak()]

story += [P('1. Memulai WMS', 'H1x'), P('Login menggunakan akun yang diberikan perusahaan. Setelah masuk, periksa tiga hal berikut:', 'Bodyx')]
story += [bullet('<b>Status sinkronisasi.</b> Indikator di bagian bawah menu harus menunjukkan tersinkron atau connected.'), bullet('<b>Cabang/gudang aktif.</b> Pastikan cabang dan gudang yang dipilih sesuai pekerjaan.'), bullet('<b>Peran akun.</b> Menu yang tampil bergantung pada role: Administrator/Admin, Picker, Packer, atau Viewer.')]
story += [P('<b>Penting:</b> Jika muncul banner data tertunda/gagal, jangan melakukan input massal sebelum status kembali tersinkron. Gunakan tombol muat ulang data hanya setelah memastikan form yang belum disimpan sudah aman.', 'Callout')]

story += [P('2. Tampilan Aktual yang Diverifikasi', 'H1x'), P('Panduan ini telah dicocokkan dengan tampilan live TRUEBLUE WMS pada akun Administrator AMRI.', 'Bodyx')]
actual = [['Bagian', 'Tampilan yang terlihat'], ['Akun', 'AMRI - Administrator'], ['Cabang aktif', 'CENTER - OFFLINE B2B'], ['Status', 'Sinkronisasi stok berhasil'], ['Ringkasan stok', '165 SKU; 153 memiliki stok; 440 baris lokasi'], ['Pekerjaan tertunda', '0 order menunggu picking; 0 order menunggu packing'], ['Menu utama', 'Dashboard DC, Analitik, Stok, Inbound, Return, Order, Outbound B2B/Offline, Outbound Online, Outbound Cepat, Warehouse & Transfer, Stock Opname (DCC), Rekonsiliasi'], ['Administrasi', 'Dashboard Pusat, Backup & Pemulihan, Aktivitas & Pembatalan, Buku Mutasi, Transfer Cabang, Pengaturan Pengirim, Master Cabang']]
at=Table([[P(str(c),'Smallx') for c in row] for row in actual], colWidths=[38*mm,127*mm], repeatRows=1)
at.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),teal),('TEXTCOLOR',(0,0),(-1,0),colors.white),('GRID',(0,0),(-1,-1),0.3,HexColor('#C9D8DE')),('VALIGN',(0,0),(-1,-1),'TOP'),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, HexColor('#F6FAFB')]),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
story += [at, P('<b>Catatan:</b> Menu yang tampil dapat berbeda pada akun Picker atau Packer karena hak aksesnya lebih terbatas.', 'Callout')]

story += [P('3. Mengenal Menu Utama', 'H1x')]
menu_data = [['Kelompok', 'Menu', 'Kegunaan utama'], ['Ringkasan', 'Dashboard', 'Melihat ringkasan stok, order, pekerjaan tertunda, dan status operasional.'], ['Ringkasan', 'Analytics', 'Melihat analitik stok dan aktivitas; biasanya untuk Admin/Administrator.'], ['Operasional', 'Inventory', 'Melihat, menambah, mengubah, dan memeriksa stok.'], ['Operasional', 'Inbound', 'Mencatat barang masuk dan penerimaan stok.'], ['Operasional', 'Return', 'Mencatat return, bukti, dan proses QC.'], ['Operasional', 'Orders', 'Membuat dan mengelola order outbound.'], ['Operasional', 'Outbound B2B', 'Alur outbound B2B dan pemrosesan order.'], ['Operasional', 'Outbound Online', 'Alur sortir/picking dan packing online.'], ['Operasional', 'Transfer Gudang', 'Memindahkan stok antar gudang/sub-gudang.'], ['Operasional', 'Stock Opname', 'Menghitung dan menyesuaikan stok fisik.'], ['Master Data', 'Catalog', 'Mengelola katalog SKU dan ukuran kemasan.'], ['Master Data', 'Operators', 'Mengelola akun/operator sesuai hak akses.']]
t=Table([[P(str(c), 'Smallx') for c in row] for row in menu_data], colWidths=[28*mm, 34*mm, 103*mm], repeatRows=1)
t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),navy),('TEXTCOLOR',(0,0),(-1,0),colors.white),('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),('GRID',(0,0),(-1,-1),0.3,HexColor('#C9D8DE')),('VALIGN',(0,0),(-1,-1),'TOP'),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, HexColor('#F6FAFB')]),('LEFTPADDING',(0,0),(-1,-1),5),('RIGHTPADDING',(0,0),(-1,-1),5),('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4)]))
story += [t]

story += [P('4. Alur Stok dan Inbound', 'H1x'), P('A. Menambah atau memeriksa stok', 'H2x'), P('Buka menu Stok, pilih gudang/lokasi, cari SKU, lalu periksa jumlah, expiry date, dan lokasi. Saat menambah stok, pastikan SKU, satuan, tanggal kedaluwarsa, lokasi, dan gudang sudah benar sebelum menyimpan.', 'Bodyx'), P('B. Inbound', 'H2x')]
for i, text in enumerate(['Buka menu Inbound.', 'Pilih atau buat dokumen penerimaan.', 'Masukkan SKU dan jumlah yang diterima.', 'Periksa kembali batch, expiry, lokasi, dan gudang.', 'Simpan, lalu pastikan status sinkronisasi berhasil.'], 1): story.append(P(f'{i}. {text}', 'Step'))
story += [P('Jika data terlihat belum berubah di PC lain, tunggu sinkronisasi realtime atau gunakan muat ulang data dari aplikasi. Hindari menekan simpan berulang kali.', 'Callout')]

story += [P('5. Alur Outbound Online: Picking, Sortir, dan Packing', 'H1x'), P('Pada tampilan aktual, Outbound Online memiliki tiga tahap kerja: <b>1. Pengambilan (Picking)</b>, <b>2. Sortir</b>, dan <b>3. Pengemasan (Packing)</b>.', 'Bodyx'), P('Alur kerja standar:', 'Bodyx')]
for i, text in enumerate(['Admin membuat atau menyiapkan order outbound.', 'Picker/Sorter membuka menu Outbound Online dan memilih pekerjaan yang tersedia.', 'Scan SKU sesuai order. Sistem memvalidasi SKU dan jumlah secara server.', 'Setelah sortir selesai, order diteruskan ke tahap packing.', 'Packer membuka order yang menjadi tanggung jawabnya.', 'Scan ulang/validasi barang, isi jumlah aktual, lalu selesaikan packing.', 'Pastikan status order berubah dan data tersimpan sebelum mengambil order berikutnya.'], 1): story.append(P(f'{i}. {text}', 'Step'))
story += [P('<b>Untuk 10 operator bersamaan:</b> gunakan akun berbeda untuk setiap operator, jangan memakai akun yang sama di beberapa PC, dan pastikan semua PC memakai URL deployment terbaru. Sistem telah dipasang dengan penguncian per sesi/order agar scan order berbeda dapat berjalan paralel.', 'Callout')]
story += [P('Jika scan gagal atau layar terasa macet:', 'H2x'), bullet('Jangan langsung menekan tombol scan berkali-kali.'), bullet('Tunggu respons server beberapa detik.'), bullet('Periksa koneksi dan status sinkronisasi.'), bullet('Jika respons hilang, buka kembali status order untuk memastikan scan belum tercatat sebelum mencoba ulang.'), bullet('Laporkan nomor order, akun operator, jam kejadian, dan PC yang terkena masalah.')]

story += [P('6. Membuat dan Mengelola Order', 'H1x')]
for i, text in enumerate(['Buka Orders atau menu outbound yang sesuai.', 'Masukkan nomor referensi, customer, SKU, jumlah, gudang, dan tanggal yang diperlukan.', 'Simpan sebagai draft bila order belum siap diproses.', 'Periksa order pada riwayat sebelum diteruskan ke sortir/picking.', 'Untuk pembatalan atau perubahan massal, pastikan order yang dipilih benar dan cek hasil akhirnya.'], 1): story.append(P(f'{i}. {text}', 'Step'))

story += [P('7. Transfer Gudang dan Stock Opname', 'H1x'), P('<b>Transfer Gudang:</b> pilih gudang asal, gudang tujuan, SKU, dan jumlah. Simpan transfer, lalu cek stok di kedua lokasi setelah sinkronisasi selesai.', 'Bodyx'), P('<b>Stock Opname:</b> lakukan penghitungan fisik per lokasi/batch, masukkan jumlah aktual, tulis nama operator dan catatan, lalu simpan. Perbedaan stok harus dapat dijelaskan dan tidak dilakukan berulang tanpa audit.', 'Bodyx')]

story += [P('8. Return dan QC', 'H1x'), P('Buka Return untuk membuat kasus return, menambahkan bukti bila tersedia, dan memproses keputusan QC. Pilih keputusan yang sesuai, isi catatan, lalu pastikan status kasus berubah. Jangan menganggap return otomatis menambah stok sebelum keputusan QC dan kebijakan perusahaan menetapkannya.', 'Bodyx')]

story += [P('9. Panduan Berdasarkan Role', 'H1x')]
role_data=[['Role','Fokus pekerjaan'],['Administrator/Admin','Konfigurasi, master data, stok, order, inbound, return, audit, dan rekonsiliasi.'],['Picker','Mengerjakan sortir/picking dari Outbound Online sesuai tugas.'],['Packer','Memvalidasi dan menyelesaikan packing pada order yang tersedia.'],['Viewer','Melihat dashboard dan inventory tanpa melakukan perubahan operasional.']]
rt=Table([[P(str(c),'Smallx') for c in row] for row in role_data], colWidths=[40*mm,125*mm], repeatRows=1)
rt.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),teal),('TEXTCOLOR',(0,0),(-1,0),colors.white),('GRID',(0,0),(-1,-1),0.3,HexColor('#C9D8DE')),('VALIGN',(0,0),(-1,-1),'TOP'),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, HexColor('#F6FAFB')]),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
story += [rt]

story += [P('10. Troubleshooting Cepat', 'H1x')]
trouble=[['Gejala','Tindakan'],['Data tidak berubah','Periksa status sinkronisasi, tunggu sebentar, lalu muat ulang data dari aplikasi.'],['Scan ditolak','Pastikan SKU, order, jumlah, dan akun operator sesuai. Jangan mengulang tanpa memeriksa status.'],['Layar lambat','Kurangi tab yang terbuka, periksa koneksi, dan hindari membuka banyak sesi pada satu akun.'],['Order terlihat dikerjakan orang lain','Jangan mengambil alih tanpa koordinasi. Cek status server dan minta supervisor memastikan penugasan.'],['Error setelah deploy','Tutup tab lama dan buka URL aplikasi lagi. Sistem memiliki pemeriksaan versi agar pengguna mendapat versi terbaru.']]
tt=Table([[P(str(c),'Smallx') for c in row] for row in trouble], colWidths=[43*mm,122*mm], repeatRows=1)
tt.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),navy),('TEXTCOLOR',(0,0),(-1,0),colors.white),('GRID',(0,0),(-1,-1),0.3,HexColor('#C9D8DE')),('VALIGN',(0,0),(-1,-1),'TOP'),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white, HexColor('#F6FAFB')]),('LEFTPADDING',(0,0),(-1,-1),6),('RIGHTPADDING',(0,0),(-1,-1),6),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
story += [tt, Spacer(1, 8), P('Saat melapor masalah, sertakan: nama menu, nomor order/SKU, akun operator, jam kejadian, PC/browser, pesan error, dan screenshot bila memungkinkan.', 'Callout')]

story += [P('11. Checklist Sebelum Operasional', 'H1x')]
for text in ['Semua operator memakai akun masing-masing.', 'Cabang dan gudang sudah benar.', 'Status sinkronisasi menunjukkan tersambung.', 'SKU, lokasi, expiry, dan jumlah sudah dicek.', 'Operator tidak menekan scan/simpan berulang.', 'Supervisor tahu cara mengecek status order dan mencatat error.']: story.append(bullet(text))
story += [Spacer(1, 8), P('Dokumen ini adalah panduan operasional ringkas. Hak akses dan alur perusahaan tetap menjadi aturan utama bila berbeda dengan contoh di sini.', 'Smallx')]

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
