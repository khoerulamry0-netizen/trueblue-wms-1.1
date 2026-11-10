alter table public.branches add column sender_name text not null default 'Development Sender', add column sender_phone text not null default '00000000';
alter table public.branches add constraint branches_sender_name_valid check(sender_name=btrim(sender_name) and length(sender_name) between 1 and 100 and sender_name !~ '[[:cntrl:]]'), add constraint branches_sender_phone_valid check(sender_phone ~ '^[+]?[0-9]{8,20}$');
update public.branches set sender_name='Development Sender',sender_phone='00000000' where id='CENTER';
