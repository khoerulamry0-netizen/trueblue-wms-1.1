import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

export function createMockEngine() {
  const sessions = new Map();
  let fault = 'none';
  let offline = false;
  const rejected = message => ({data: null, error: {code: 'P0001', message}});
  const notFound = () => rejected('Sesi scan tidak ditemukan');
  const find = id => [...sessions.values()].find(session => session.id === id);
  const basketFor = line => `A${fixture.findIndex(row => row.referenceNumber === line.referenceNumber) + 1}`;
  return {
    target(code, candidates) {
      if (offline) throw new Error('Mock offline');
      if (typeof code !== 'string' || !Array.isArray(candidates) || candidates.length === 0 || candidates.length > 20) {
        throw new Error('Permintaan target sorting mock tidak valid.');
      }
      if (new Set(candidates.map(candidate => candidate?.reference)).size !== candidates.length) throw new Error('Order duplikat.');
      for (const candidate of candidates) {
        const line = fixture.find(row => row.referenceNumber === candidate?.reference);
        const expectedBasket = line && basketFor(line);
        const session = line && sessions.get(line.referenceNumber);
        if (!line || candidate.basket !== expectedBasket ||
            (session && session.basket !== candidate.basket)) throw new Error('Order atau basket tidak valid.');
      }
      for (const line of fixture) {
        if (!candidates.some(candidate => candidate.reference === line.referenceNumber)) continue;
        const session = sessions.get(line.referenceNumber);
        if (code === line.skuId.replace('SKU', 'BC') &&
            (!session || (session.state === 'open' && session.events.length < line.qty))) {
          return {reference:line.referenceNumber};
        }
      }
      throw new Error('Barcode tidak cocok atau jumlah sorting sudah penuh.');
    },
    orders() {
      if (offline) throw new Error('Mock offline');
      return fixture.map(line => ({
        ...line,
        sortingState: sessions.get(line.referenceNumber)?.state === 'finished' ? 'finished' : 'pending'
      }));
    },
    control(action) {
      if (action === 'reconnect') { offline = false; fault = 'none'; return; }
      if (action === 'reset') { sessions.clear(); offline = false; fault = 'none'; return; }
      if (action === 'lose-before' || action === 'lose-after') { fault = action; return; }
      throw new Error('Kontrol mock tidak dikenal.');
    },
    async rpc(name, args) {
      if (offline) throw new Error('Mock offline');
      if (name === 'get_order_scan_status') {
        if (args.p_branch !== 'MOCK-BRANCH' || args.p_phase !== 'sorting') return rejected('branch/phase');
        const session = sessions.get(args.p_reference);
        if (!session) return notFound();
        return {data: {session: session.id, branch: 'MOCK-BRANCH', reference: session.reference,
          phase: 'sorting', basket: session.basket, state: session.state, current: true,
          finish_request: session.finishRequest,
          counts: [{document_id: session.line.id, sku: session.line.skuId,
            required: session.line.qty, scanned: session.events.length}],
          events: session.events.map(event => ({request_id: event.id, input_code: event.code,
            document_id: session.line.id, sku: session.line.skuId}))}, error: null};
      }
      if (name === 'start_order_scan') {
        const line = fixture.find(row => row.referenceNumber === args.p_reference);
        const expectedBasket = line && basketFor(line);
        if (!line || args.p_branch !== 'MOCK-BRANCH' || args.p_phase !== 'sorting' ||
            args.p_basket !== expectedBasket || sessions.has(args.p_reference) || find(args.p_session)) return rejected('start');
        sessions.set(args.p_reference, {id: args.p_session, reference: args.p_reference, basket: args.p_basket,
          line, state:'open', events:[], finishRequest:null});
        return {data:{session:args.p_session, state:'open'}, error:null};
      }
      const session = find(args.p_session);
      if (!session) return rejected('session');
      if (name === 'record_order_scan') {
        const previous = session.events.find(event => event.id === args.p_request);
        if (previous && previous.code !== args.p_code) return rejected('request mismatch');
        const barcode = session.line.skuId.replace('SKU', 'BC');
        if (!previous && (session.state !== 'open' || args.p_code !== barcode || session.events.length >= session.line.qty)) {
          return rejected('barcode or quantity');
        }
        if (fault === 'lose-before') { fault = 'none'; offline = true; throw new Error('Mock connection lost before commit'); }
        if (!previous) session.events.push({id:args.p_request, code:args.p_code});
        if (fault === 'lose-after') { fault = 'none'; offline = true; throw new Error('Mock response lost after commit'); }
        return {data:{document_id:session.line.id, sku:session.line.skuId}, error:null};
      }
      if (name === 'finish_order_scan') {
        if (session.state === 'finished' && session.finishRequest === args.p_request) {
          return {data:{session:session.id, phase:'sorting', state:'finished'}, error:null};
        }
        if (session.state !== 'open' || session.events.length !== session.line.qty) return rejected('incomplete');
        session.state = 'finished'; session.finishRequest = args.p_request;
        return {data:{session:session.id, phase:'sorting', state:'finished'}, error:null};
      }
      return rejected('RPC tidak tersedia pada simulasi sorting');
    }
  };
}
