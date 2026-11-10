type PageResult<T> = {data: T[] | null; error: {message: string} | null};
type PageQuery<T> = PromiseLike<PageResult<T>> & {
  order(column: string): PageQuery<T>;
  limit(count: number): PageQuery<T>;
  gt(column: string, value: string): PageQuery<T>;
  abortSignal(signal: AbortSignal): PageQuery<T>;
};

// Continue until an empty page, including when the API cap is smaller than our request.
// A stable unique cursor avoids offset gaps after rows are removed between requests.
export async function readAllRows<T extends Record<string, any>>(
  makeQuery: () => PageQuery<T>,
  cursorColumn: keyof T & string,
  isCurrent: () => boolean = () => true,
  pageSize = 500,
  signal?: AbortSignal
): Promise<T[]> {
  const rows: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    if (!isCurrent()) throw new Error('Pembacaan dibatalkan karena cabang atau halaman berubah.');
    let query = makeQuery().order(cursorColumn).limit(pageSize);
    if (cursor !== undefined) query = query.gt(cursorColumn, cursor);
    if (signal) query = query.abortSignal(signal);
    const {data, error} = await query;
    if (!isCurrent()) throw new Error('Pembacaan dibatalkan karena cabang atau halaman berubah.');
    if (error) throw new Error(error.message);
    if (!data?.length) return rows;
    for (const row of data) {
      const key = row[cursorColumn];
      if (typeof key !== 'string' || !key || seen.has(key)) throw new Error('Halaman data berulang atau identitas baris tidak valid. Muat ulang daftar.');
      seen.add(key);
      rows.push(row);
    }
    cursor = data[data.length - 1][cursorColumn];
  }
}
