import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  ORDER_IMPORT_TEMPLATE_COL_WIDTHS,
  ORDER_IMPORT_TEMPLATE_HEADERS,
  parseOrderTable,
} from '../src/utils/orderImport.ts';

test('order import template headers include No PO and matching column widths', () => {
  assert.deepEqual([...ORDER_IMPORT_TEMPLATE_HEADERS], [
    'No Order',
    'SKU',
    'Qty (pcs)',
    'Pelanggan',
    'Alamat Pelanggan',
    'Telepon Pelanggan',
    'Batch Number',
    'No PO',
  ]);
  assert.equal(ORDER_IMPORT_TEMPLATE_COL_WIDTHS.length, ORDER_IMPORT_TEMPLATE_HEADERS.length);
  for (const col of ORDER_IMPORT_TEMPLATE_COL_WIDTHS) {
    assert.ok(col.wch > 0);
  }
});

test('parseOrderTable parses No PO from downloaded template xlsx round-trip and PO header aliases', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...ORDER_IMPORT_TEMPLATE_HEADERS],
    ['ORD-2026-001', 'SKU-A1', 12, 'Toko Maju', 'Jl. Sudirman 1', '08123456789', 'BATCH-PAGI', 'PO-8899'],
    ['ORD-2026-002', 'SKU-A2', '5', 'Toko Baru', 'Jl. Thamrin 2', '08199998888', '', ''],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Order');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const parsedBook = XLSX.read(bytes, { type: 'buffer', raw: true });
  const table = XLSX.utils.sheet_to_json(parsedBook.Sheets[parsedBook.SheetNames[0]], {
    header: 1,
    defval: '',
    raw: true,
  });

  const parsed = parseOrderTable(table);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].noPo, 'PO-8899');
  assert.deepEqual(parsed[0].errors, []);
  assert.equal(parsed[1].noPo, '');
  assert.deepEqual(parsed[1].errors, []);

  const aliasTable = [
    ['Order Number', 'PO Number', 'SKU', 'Qty'],
    ['ORD-300', 'PO-300', 'SKU-B1', '4'],
  ];
  const aliasParsed = parseOrderTable(aliasTable);
  assert.equal(aliasParsed[0].noPo, 'PO-300');
  assert.deepEqual(aliasParsed[0].errors, []);
});

test('parseOrderTable rejects inconsistent No PO within the same No Order', () => {
  const parsed = parseOrderTable([
    [...ORDER_IMPORT_TEMPLATE_HEADERS],
    ['ORD-500', 'SKU-A', 2, 'Budi', 'Jl. A', '0811', 'B-1', 'PO-01'],
    ['ORD-500', 'SKU-B', 3, 'Budi', 'Jl. A', '0811', 'B-1', 'PO-02'],
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].errors.length, 0);
  assert.match(parsed[1].errors[0], /tidak konsisten/i);
});

test('OrderFileImport uses template constants and shows No PO in instructions and preview table', () => {
  const source = readFileSync(new URL('../src/components/OrderFileImport.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('ORDER_IMPORT_TEMPLATE_HEADERS'));
  assert.ok(source.includes('ORDER_IMPORT_TEMPLATE_COL_WIDTHS'));
  assert.ok(source.includes("['Baris','No Order','No PO','SKU','Qty pcs','Pelanggan','Alamat / Telepon','Hasil pemeriksaan']"));
  assert.ok(source.includes('dan No PO opsional'));
  assert.ok(source.includes('l.noPo'));
});

test('parseOrderTable directly parses Upfos detail order export with decimal .0 quantities', () => {
  const upfosTable = [
    [
      'Waktu Pembuatan', 'Platform', 'Nama Toko', 'Nomor Transaksi Platform', 'Nomor order pengiriman',
      'Manajemen Logistik', 'Layanan logistik', 'No.Logistik Pengembalian', 'Gudang', 'Kode Produk',
      'Nama Produk', 'Kode Spesifik Produk', 'Nama SKU', 'Produk Qty', 'Nama pembeli',
      'Nama Penerima', 'Nomor HP penerima', 'Nomor Telpon Penerima', 'Daerah', 'Kode Pos Penerima',
      'Alamat Penerima', 'Port code', 'Penanda Sistem', 'Waktu Pemindaian', 'Berat', 'Sumber',
      'Atribut Produk', 'NDD Waktu hadiah',
    ],
    [
      '2026-11-24 08:58:33', 'Shopee', 'SHOPEE - HER HARMONY', '26112450B90A0H', '105785215867',
      'SPX Sameday', '', '26112450B90A0H', 'SWH', 'POMTR253045621',
      'Her Harmony Terragenix', 'POMTR253045621', 'POMTR253045621', '1.0', 'daganganlaris2018',
      'R**i', '******88', '', 'Dki Jakarta/Kota Adm. Jakarta Utara/Cilincing', '14140',
      '******rand orchard, KOTA JAKARTA UTARA', '', 'Waktu,Distribusi kota', '2026-11-24 09:58:30', '0.024', '',
      'Produk General', '',
    ],
    [
      '2026-11-24 08:58:33', 'Shopee', 'SHOPEE - HER HARMONY', '26112450B90A0H', '105785215867',
      'SPX Sameday', '', '26112450B90A0H', 'SWH', 'BUBBLEWRAP-3 LAYER',
      'BUBBLE WRAP 3 LAYER', 'BUBBLEWRAP-3 LAYER', 'BUBBLE WRAP 3 LAYER', '3.0', 'daganganlaris2018',
      'R**i', '******88', '', 'Dki Jakarta/Kota Adm. Jakarta Utara/Cilincing', '14140',
      '******rand orchard, KOTA JAKARTA UTARA', '', 'Waktu,Distribusi kota', '2026-11-24 09:58:30', '0.024', '',
      'Produk General', '',
    ],
  ];

  const parsed = parseOrderTable(upfosTable);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].errors, []);
  assert.deepEqual(parsed[1].errors, []);
  assert.equal(parsed[0].orderNumber, '26112450B90A0H');
  assert.equal(parsed[0].skuId, 'POMTR253045621');
  assert.equal(parsed[0].qty, 1);
  assert.equal(parsed[0].customerName, 'R**i');
  assert.equal(parsed[0].customerPhone, '******88');
  assert.equal(parsed[1].skuId, 'BUBBLEWRAP-3 LAYER');
  assert.equal(parsed[1].qty, 3);
});
