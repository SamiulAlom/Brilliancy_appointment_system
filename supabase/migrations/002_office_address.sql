-- 26 October 2026: office moved. Updates the address shown to clients, in emails and on calendar events.
update public.appt_settings set office_address = 'Level 13, Fareast Tower, 35 Topkhana Road, Dhaka 1000', updated_at = now() where id = 1;
select office_address from public.appt_settings;
