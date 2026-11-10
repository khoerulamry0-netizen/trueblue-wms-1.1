SELECT
  COALESCE(collection_name, 'TOTAL') AS jenis,
  COUNT(*) AS jumlah
FROM public.wms_documents
WHERE branch_id = 'DEV_LOCAL'
GROUP BY ROLLUP(collection_name)
ORDER BY collection_name NULLS LAST;