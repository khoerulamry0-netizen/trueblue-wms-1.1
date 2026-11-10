import { getActiveBranch } from '../supabase';
export function localScopeKey(name:string,user:{id?:string;username?:string}|null|undefined,daily=false){
 const account=user?.id || user?.username;
 const date=daily ? new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()) : '';
 return 'blues:v2:'+JSON.stringify([getActiveBranch(),account || 'no-session',name,date]);
}
