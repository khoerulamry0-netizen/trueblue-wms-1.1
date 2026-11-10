export function listenHost(productionRuntime: boolean): string {
  return productionRuntime ? '0.0.0.0' : '127.0.0.1';
}
