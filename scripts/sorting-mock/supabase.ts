import { createServerScanRpc } from '../../src/utils/serverScanRpc';
import { parseOrders } from './orders';

export const SERVER_SCAN_ENABLED = true;
export const getActiveBranch = () => 'MOCK-BRANCH';
export const supabase = { auth: { getUser: async () => ({data:{user:{id:'mock-packer'}}, error:null}) } };
export const serverScanRpc = createServerScanRpc(async (name, args) => {
  const response = await fetch('/__sorting_mock/rpc', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, args})
  });
  if (!response.ok) throw new Error('Mock RPC offline');
  const result = await response.json();
  const orders = parseOrders(result.orders);
  window.dispatchEvent(new CustomEvent('sorting-mock-orders', {detail:orders}));
  return result;
}, getActiveBranch);
