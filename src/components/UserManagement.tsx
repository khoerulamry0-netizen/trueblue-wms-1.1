import { supabase, getActiveBranch } from '../supabase';
import { useLanguage } from '../i18n/LanguageContext';
import { validatePasswordNotLeaked } from '../utils/passwordSecurity';
import React, { useMemo, useState, useEffect } from 'react';
import { UserAccount } from '../types';
import { Search, Shield, UserPlus, Edit3, Trash2, X, User } from 'lucide-react';

interface UserManagementProps {
  users: UserAccount[];
  currentUser: UserAccount | null;
  onAddUser: (user: UserAccount) => Promise<void> | void;
  onUpdateUser: (email: string, fields: Partial<UserAccount>) => Promise<void> | void;
  onDeleteUser: (email: string) => Promise<void> | void;
}

const roles = ['Admin', 'Administrator', 'Picker', 'Packer', 'Shipping', 'Viewer'];

export default function UserManagement({ users, currentUser, onAddUser, onUpdateUser, onDeleteUser }: UserManagementProps) {
  const { t, language } = useLanguage();
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('ALL');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [branches, setBranches] = useState<Array<{id:string;name:string}>>([]);
  const [branchId, setBranchId] = useState(() => getActiveBranch() || 'CENTER');
  useEffect(() => {
    void supabase?.from('branches').select('id,name').order('id').then(({ data }) => {
      const list = data ? [...data] : [];
      const current = getActiveBranch() || 'CENTER';
      if (current && !list.some(b => b.id === current)) {
        list.unshift({ id: current, name: current });
      }
      setBranches(list);
    }, () => {});
  }, []);
  const [role, setRole] = useState('Picker');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isAdmin = currentUser?.role === 'Admin' || currentUser?.role === 'Administrator';

  const branchOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const user of users) {
      const key = (user.branch_id || '').trim().toUpperCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const optionMap = new Map<string, { id: string; label: string; count: number }>();
    for (const branch of branches) {
      const key = branch.id.trim().toUpperCase();
      if (!key) continue;
      const displayName = branch.name && branch.name !== branch.id ? `${branch.id} — ${branch.name}` : branch.id;
      optionMap.set(key, { id: branch.id, label: displayName, count: counts.get(key) || 0 });
    }
    for (const user of users) {
      const raw = (user.branch_id || '').trim();
      const key = raw.toUpperCase();
      if (key && !optionMap.has(key)) {
        optionMap.set(key, { id: raw, label: raw, count: counts.get(key) || 0 });
      }
    }
    return Array.from(optionMap.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, [branches, users]);

  const usersInBranch = useMemo(() => {
    if (branchFilter === 'ALL') return users;
    const targetBranch = branchFilter.trim().toUpperCase();
    return users.filter(user => (user.branch_id || '').trim().toUpperCase() === targetBranch);
  }, [users, branchFilter]);

  const roleOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const user of usersInBranch) {
      const r = (user.role || '').trim();
      if (r) counts.set(r, (counts.get(r) || 0) + 1);
    }
    const orderedRoles = Array.from(new Set([...roles, ...counts.keys()]));
    return orderedRoles.map(r => ({ role: r, count: counts.get(r) || 0 }));
  }, [usersInBranch]);

  const visibleUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return usersInBranch.filter(user => {
      if (roleFilter !== 'ALL' && user.role !== roleFilter) return false;
      if (!q) return true;
      return `${user.fullName} ${user.email || user.username} ${user.role} ${user.branch_id || ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [usersInBranch, roleFilter, search]);

  const openInvite = () => {
    setEditing(null);
    setInviteOpen(true);
    setFullName('');
    setEmail('');
    setPassword('');
    setBranchId(branchFilter !== 'ALL' ? branchFilter : getActiveBranch());
    setRole(roleFilter !== 'ALL' && (currentUser?.role === 'Administrator' || roleFilter !== 'Administrator') ? roleFilter : 'Picker');
    setError('');
    setNotice('');
  };
  const openEdit = (user: UserAccount) => { setInviteOpen(false); setEditing(user); setFullName(user.fullName); setEmail(user.username); setRole(user.role); setBranchId(user.branch_id || getActiveBranch()); setError(''); setNotice(''); };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    const cleanName = fullName.trim(); 
    const cleanEmail = email.trim().toLowerCase().replace(/\s+/g, '');
    const finalFullName = cleanName || cleanEmail;
    try {
      if (!cleanEmail) throw new Error('ID akun wajib diisi.');
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(cleanEmail)) {
        throw new Error('ID harus 3–32 karakter berupa huruf kecil, angka, titik, strip (-), atau garis bawah (_) tanpa spasi. Contoh: picker01');
      }
      if (!editing) {
        const leakError = await validatePasswordNotLeaked(password, cleanEmail, 8);
        if (leakError) throw new Error(leakError);
      }
      if (!roles.includes(role)) throw new Error('Peran yang dipilih tidak valid.');
      if (editing) {
        await onUpdateUser(editing.email || editing.username, { fullName: finalFullName, role, branch_id: branchId });
        setNotice('Profil operator diperbarui.'); setEditing(null);
      } else {
        if (users.some(user => (user.email || user.username).toLowerCase() === cleanEmail)) {
          throw new Error('ID akun "' + cleanEmail + '" sudah terdaftar.');
        }
        await onAddUser({ username: cleanEmail, password, fullName: finalFullName, role, branch_id: branchId });
        setNotice('Akun operator berhasil dibuat. Operator bisa langsung login dengan ID dan password.'); 
        setPassword(''); 
        setEmail('');
        setFullName('');
        setInviteOpen(false);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Perubahan akun gagal.'); }
    finally { setBusy(false); }
  };

  const removeUser = async (user: UserAccount) => {
    const targetEmail = user.email || user.username;
    if (!isAdmin || user.id === currentUser?.id) return;
    if (!confirm('Hapus akses untuk ' + targetEmail + '?')) return;
    setBusy(true); setError(''); setNotice('');
    try { await onDeleteUser(targetEmail); setNotice('Akun operator dihapus.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Penghapusan akun gagal.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div><h2 className="text-xl font-extrabold text-white flex items-center gap-2"><Shield className="w-5 h-5 text-emerald-400" />{t('user.title')}</h2><p className="text-xs text-slate-400 mt-1">{t('user.subtitle')}</p></div>
        {isAdmin && <button onClick={openInvite} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-emerald-400"><UserPlus className="w-4 h-4" />{t('user.addOperator')}</button>}
      </div>
      {notice && <p className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-xs text-emerald-300">{notice}</p>}
      {error && <p className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-xs text-rose-300">{error}</p>}

      {editing && <form onSubmit={submit} className="rounded-2xl border border-slate-700 bg-[#11141B] p-4 space-y-3">
        <div className="flex justify-between items-center"><h3 className="text-sm font-bold text-white">{t('user.editProfile')}</h3><button type="button" onClick={() => setEditing(null)} aria-label="Tutup"><X className="w-4 h-4" /></button></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input value={fullName} onChange={event => setFullName(event.target.value)} placeholder={t('user.fullNamePlaceholder')} maxLength={120} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" />
          <input value={email} readOnly className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-400" />
          <select value={role} onChange={event => setRole(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">{roles.filter(item=>currentUser?.role==='Administrator'||item!=='Administrator').map(item => <option key={item}>{item}</option>)}</select>
          <select aria-label="Cabang operator" value={branchId} onChange={e=>setBranchId(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">{branches.length ? branches.map(b=><option key={b.id} value={b.id}>{b.id} — {b.name}</option>) : <option value={branchId || 'CENTER'}>{branchId || 'CENTER'}</option>}</select>
        </div>
        <button disabled={busy} className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 disabled:opacity-50">{t('user.saveProfile')}</button>
      </form>}

      <div className="rounded-2xl border border-slate-800 bg-[#11141B] overflow-hidden">
        <div className="p-3 border-b border-slate-800 flex flex-col md:flex-row md:items-center gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500 pointer-events-none" />
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t('user.searchPlaceholder')}
              className="w-full rounded-lg border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-xs text-white"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter cabang operator"
              value={branchFilter}
              onChange={event => setBranchFilter(event.target.value)}
              className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white cursor-pointer"
            >
              <option value="ALL">
                {language === 'en' ? `All Branches (${users.length})` : `Semua Cabang (${users.length})`}
              </option>
              {branchOptions.map(b => (
                <option key={b.id} value={b.id}>
                  {b.label} ({b.count})
                </option>
              ))}
            </select>
            <select
              aria-label="Filter role operator"
              value={roleFilter}
              onChange={event => setRoleFilter(event.target.value)}
              className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white cursor-pointer"
            >
              <option value="ALL">
                {language === 'en' ? `All Roles (${usersInBranch.length})` : `Semua Role (${usersInBranch.length})`}
              </option>
              {roleOptions.map(opt => (
                <option key={opt.role} value={opt.role}>
                  {opt.role} ({opt.count})
                </option>
              ))}
            </select>
            {(search || branchFilter !== 'ALL' || roleFilter !== 'ALL') && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setBranchFilter('ALL');
                  setRoleFilter('ALL');
                }}
                className="rounded-lg border border-slate-700 px-2.5 py-2 text-xs font-bold text-slate-300 hover:text-white cursor-pointer"
              >
                Reset
              </button>
            )}
          </div>
        </div>
        {(branchFilter !== 'ALL' || roleFilter !== 'ALL' || search) && (
          <div className="px-4 py-2 border-b border-slate-800/70 text-[11px] text-slate-400">
            {language === 'en'
              ? `Showing ${visibleUsers.length} of ${users.length} operators`
              : `Menampilkan ${visibleUsers.length} dari ${users.length} operator`}
          </div>
        )}
        <div className="divide-y divide-slate-800/70">
          {visibleUsers.map(user => <div key={user.id || user.username} className="flex flex-col sm:flex-row sm:items-center gap-3 p-4">
            <div className="min-w-0 flex-1"><div className="font-semibold text-sm text-white truncate">{user.fullName}</div><div className="text-xs text-slate-400 truncate">{user.username} · {user.role === "Administrator" ? (language === 'en' ? 'Headquarters' : 'Kantor pusat') : user.branch_id}</div><div className={user.is_active ? 'mt-1 text-[10px] text-emerald-400' : 'mt-1 text-[10px] text-amber-300'}>{user.is_active ? t('user.active') : t('user.inactive')}</div></div>
            <span className="w-fit rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-300">{user.role}</span>
            {isAdmin && <div className="flex gap-2"><button disabled={busy} onClick={() => openEdit(user)} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:text-white" title="Ubah profil"><Edit3 className="w-4 h-4" /></button><button disabled={busy || user.id === currentUser?.id} onClick={() => void removeUser(user)} className="rounded-lg border border-rose-900/60 p-2 text-rose-300 hover:text-rose-200 disabled:opacity-40" title="Hapus akun"><Trash2 className="w-4 h-4" /></button></div>}
          </div>)}
          {!visibleUsers.length && <div className="p-8 text-center text-xs text-slate-500">{language === 'en' ? 'No operator accounts visible.' : 'Belum ada akun operator yang terlihat.'}</div>}
        </div>
      </div>

      {inviteOpen && <><button type="button" className="fixed inset-0 z-[140] bg-black/45 backdrop-blur-[2px]" aria-label="Tutup form tambah operator" onClick={() => setInviteOpen(false)} /><form onSubmit={submit} role="dialog" aria-modal="true" aria-label={t('user.addOperatorTitle')} className="fixed top-20 left-1/2 z-[150] max-h-[calc(100dvh-96px)] w-[min(1100px,calc(100vw-32px))] -translate-x-1/2 overflow-y-auto rounded-2xl border border-emerald-500/20 bg-[#11141B] p-4 space-y-3 shadow-2xl">
        <div className="flex justify-between items-center"><h3 className="text-sm font-bold text-white flex gap-2 items-center"><User className="w-4 h-4 text-emerald-400" />{t('user.addOperatorTitle')}</h3><button type="button" onClick={() => setInviteOpen(false)} aria-label="Tutup"><X className="w-4 h-4" /></button></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input autoFocus value={fullName} onChange={event => setFullName(event.target.value)} placeholder={t('user.fullNamePlaceholder')} maxLength={120} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" />
          <input type="text" autoComplete="off" required minLength={3} maxLength={32} value={email} onChange={event => setEmail(event.target.value)} placeholder={t('user.idPlaceholder')} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" />
          <select value={role} onChange={event => setRole(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">{roles.filter(item=>currentUser?.role==='Administrator'||item!=='Administrator').map(item => <option key={item}>{item}</option>)}</select>
          <select aria-label="Cabang operator" value={branchId} onChange={e=>setBranchId(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">{branches.length ? branches.map(b=><option key={b.id} value={b.id}>{b.id} — {b.name}</option>) : <option value={branchId || 'CENTER'}>{branchId || 'CENTER'}</option>}</select>
        </div>
        <input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder={t('user.passwordPlaceholder')} aria-label="Password akun baru" className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" /><p className="text-[11px] text-slate-400">{language === 'en' ? 'ID is case-insensitive. Operators can log in directly without email confirmation.' : 'ID tidak membedakan huruf besar/kecil. Operator bisa langsung masuk tanpa konfirmasi email.'}</p>
        <button disabled={busy} className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 disabled:opacity-50">{t('user.createAccount')}</button>
      </form></>}
    </div>
  );
}
