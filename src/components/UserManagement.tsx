import { supabase, getActiveBranch } from '../supabase';
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
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [branches, setBranches] = useState<Array<{id:string;name:string}>>([]);
  const [branchId, setBranchId] = useState(getActiveBranch());
  useEffect(()=>{void supabase?.from('branches').select('id,name').order('id').then(({data})=>setBranches(data||[]));},[]);
  const [role, setRole] = useState('Picker');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isAdmin = currentUser?.role === 'Admin' || currentUser?.role === 'Administrator';
  const visibleUsers = useMemo(() => users.filter(user => (user.fullName + ' ' + (user.email || user.username) + ' ' + user.role).toLowerCase().includes(search.toLowerCase())), [users, search]);

  const openInvite = () => { setEditing(null); setInviteOpen(true); setFullName(''); setEmail(''); setPassword(''); setBranchId(getActiveBranch()); setRole('Picker'); setError(''); setNotice(''); };
  const openEdit = (user: UserAccount) => { setInviteOpen(false); setEditing(user); setFullName(user.fullName); setEmail(user.username); setRole(user.role); setBranchId(user.branch_id || getActiveBranch()); setError(''); setNotice(''); };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    const cleanName = fullName.trim(); const cleanEmail = email.trim().toLowerCase();
    try {
      if ((editing && !cleanName) || cleanName.length > 120 || !roles.includes(role)) throw new Error('Nama atau peran belum valid.');
      if (editing) {
        await onUpdateUser(editing.email || editing.username, { fullName: cleanName, role, branch_id: branchId });
        setNotice('Profil operator diperbarui.'); setEditing(null);
      } else {
        if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(cleanEmail)) throw new Error('ID harus 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.');
        if (password.length < 8 || password.length > 128) throw new Error('Password harus 8–128 karakter.');
        if (users.some(user => user.username.toLowerCase() === cleanEmail)) throw new Error('ID tersebut sudah terdaftar.');
        await onAddUser({ username: cleanEmail, password, fullName: cleanName || cleanEmail, role, branch_id: branchId });
        setNotice('Akun operator dibuat. Operator bisa langsung login dengan ID dan password.'); setPassword(''); setInviteOpen(false);
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
        <div><h2 className="text-xl font-extrabold text-white flex items-center gap-2"><Shield className="w-5 h-5 text-emerald-400" />Akun Operator</h2><p className="text-xs text-slate-400 mt-1">Buat akun operator dengan ID dan password, tanpa email.</p></div>
        {isAdmin && <button onClick={openInvite} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-emerald-400"><UserPlus className="w-4 h-4" />Tambah operator</button>}
      </div>
      {notice && <p className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-xs text-emerald-300">{notice}</p>}
      {error && <p className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-xs text-rose-300">{error}</p>}

      {editing && <form onSubmit={submit} className="rounded-2xl border border-slate-700 bg-[#11141B] p-4 space-y-3">
        <div className="flex justify-between items-center"><h3 className="text-sm font-bold text-white">Ubah profil operator</h3><button type="button" onClick={() => setEditing(null)} aria-label="Tutup"><X className="w-4 h-4" /></button></div>
        <div className="grid gap-3 sm:grid-cols-3"><input value={fullName} onChange={event => setFullName(event.target.value)} placeholder="Nama lengkap (opsional untuk akun baru)" maxLength={120} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" /><input value={email} readOnly className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-400" /><select value={role} onChange={event => setRole(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">{roles.filter(item=>currentUser?.role==='Administrator'||item!=='Administrator').map(item => <option key={item}>{item}</option>)}</select><select aria-label="Cabang operator" value={branchId} onChange={e=>setBranchId(e.target.value)} className="rounded-lg border px-3 py-2 text-sm">{branches.map(b=><option key={b.id} value={b.id}>{b.id} — {b.name}</option>)}</select></div>
        <button disabled={busy} className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 disabled:opacity-50">Simpan profil</button>
      </form>}

      <div className="rounded-2xl border border-slate-800 bg-[#11141B] overflow-hidden">
        <div className="p-3 border-b border-slate-800 relative"><Search className="absolute left-6 top-5 w-4 h-4 text-slate-500" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Cari berdasarkan nama atau ID" className="w-full rounded-lg border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-xs text-white" /></div>
        <div className="divide-y divide-slate-800/70">
          {visibleUsers.map(user => <div key={user.id || user.username} className="flex flex-col sm:flex-row sm:items-center gap-3 p-4">
            <div className="min-w-0 flex-1"><div className="font-semibold text-sm text-white truncate">{user.fullName}</div><div className="text-xs text-slate-400 truncate">{user.username} · {user.role === "Administrator" ? "Kantor pusat" : user.branch_id}</div><div className={user.is_active ? 'mt-1 text-[10px] text-emerald-400' : 'mt-1 text-[10px] text-amber-300'}>{user.is_active ? 'Akun aktif' : 'Belum diaktifkan'}</div></div>
            <span className="w-fit rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] font-bold uppercase text-slate-300">{user.role}</span>
            {isAdmin && <div className="flex gap-2"><button disabled={busy} onClick={() => openEdit(user)} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:text-white" title="Ubah profil"><Edit3 className="w-4 h-4" /></button><button disabled={busy || user.id === currentUser?.id} onClick={() => void removeUser(user)} className="rounded-lg border border-rose-900/60 p-2 text-rose-300 hover:text-rose-200 disabled:opacity-40" title="Hapus akun"><Trash2 className="w-4 h-4" /></button></div>}
          </div>)}
          {!visibleUsers.length && <div className="p-8 text-center text-xs text-slate-500">Belum ada akun operator yang terlihat.</div>}
        </div>
      </div>

      {inviteOpen && <form onSubmit={submit} className="rounded-2xl border border-emerald-500/20 bg-[#11141B] p-4 space-y-3">
        <div className="flex justify-between items-center"><h3 className="text-sm font-bold text-white flex gap-2 items-center"><User className="w-4 h-4 text-emerald-400" />Tambah operator baru</h3><button type="button" onClick={() => setInviteOpen(false)} aria-label="Tutup"><X className="w-4 h-4" /></button></div>
        <div className="grid gap-3 sm:grid-cols-3"><input value={fullName} onChange={event => setFullName(event.target.value)} placeholder="Nama lengkap (opsional untuk akun baru)" maxLength={120} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" /><input type="text" autoComplete="off" required minLength={3} maxLength={32} value={email} onChange={event => setEmail(event.target.value)} placeholder="ID akun, contoh: picker01" className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" /><select value={role} onChange={event => setRole(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white">{roles.filter(item=>currentUser?.role==='Administrator'||item!=='Administrator').map(item => <option key={item}>{item}</option>)}</select><select aria-label="Cabang operator" value={branchId} onChange={e=>setBranchId(e.target.value)} className="rounded-lg border px-3 py-2 text-sm">{branches.map(b=><option key={b.id} value={b.id}>{b.id} — {b.name}</option>)}</select></div>
        <input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="Password (minimal 8 karakter)" aria-label="Password akun baru" className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white" /><p className="text-[11px] text-slate-400">ID tidak membedakan huruf besar/kecil. Operator bisa langsung masuk tanpa konfirmasi email.</p>
        <button disabled={busy} className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 disabled:opacity-50">Buat akun</button>
      </form>}
    </div>
  );
}
