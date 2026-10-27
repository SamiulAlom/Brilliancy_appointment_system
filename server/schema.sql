-- Brilliancy Appointments: MySQL 8 / MariaDB 10.6+ schema.
-- Applied automatically by the server on startup (idempotent). All times are stored in UTC.

CREATE TABLE IF NOT EXISTS appt_admins (
  id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(200) NOT NULL UNIQUE,
  full_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appt_settings (
  id TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
  open_time CHAR(5) NOT NULL DEFAULT '10:00',
  close_time CHAR(5) NOT NULL DEFAULT '19:00',
  working_days VARCHAR(20) NOT NULL DEFAULT '6,0,1,2,3,4',   -- 0 = Sunday ... 6 = Saturday; Friday (5) closed
  slot_step_min INT NOT NULL DEFAULT 30,
  min_notice_min INT NOT NULL DEFAULT 120,
  max_days_ahead INT NOT NULL DEFAULT 30,
  modes VARCHAR(40) NOT NULL DEFAULT 'office,meet,phone',
  office_address VARCHAR(200) NOT NULL DEFAULT 'Level 13, Fareast Tower, 35 Topkhana Road, Dhaka 1000',
  calendar_id VARCHAR(200) NOT NULL DEFAULT 'primary',
  notify_email VARCHAR(200) NOT NULL DEFAULT 'brilliancycomms@gmail.com',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO appt_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS appt_services (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(600) NOT NULL DEFAULT '',
  duration_min INT NOT NULL DEFAULT 30,
  sort_order INT NOT NULL DEFAULT 100,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appt_off_days (
  id CHAR(36) NOT NULL PRIMARY KEY,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  reason VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appt_referrers (
  code VARCHAR(30) NOT NULL PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  designation VARCHAR(120) NOT NULL DEFAULT '',
  email VARCHAR(200) NULL,
  phone VARCHAR(30) NOT NULL DEFAULT '',
  notify TINYINT(1) NOT NULL DEFAULT 1,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appt_google (
  id TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
  google_email VARCHAR(200) NULL,
  refresh_token_enc TEXT NULL,
  connected_at DATETIME(3) NULL,
  connected_by CHAR(36) NULL,
  last_ok_at DATETIME(3) NULL,
  last_error VARCHAR(500) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO appt_google (id) VALUES (1);

CREATE TABLE IF NOT EXISTS appt_bookings (
  id CHAR(36) NOT NULL PRIMARY KEY,
  idempotency_key CHAR(36) NOT NULL UNIQUE,
  service_id CHAR(36) NULL,
  service_name VARCHAR(140) NOT NULL,
  duration_min INT NOT NULL,
  mode VARCHAR(10) NOT NULL,
  start_at DATETIME(3) NOT NULL,
  end_at DATETIME(3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'calendar_pending',   -- calendar_pending | confirmed | completed | no_show | cancelled
  client_name VARCHAR(120) NOT NULL,
  client_phone VARCHAR(16) NOT NULL,
  client_email VARCHAR(200) NOT NULL,
  client_institution VARCHAR(200) NOT NULL DEFAULT '',
  client_note TEXT NULL,
  referrer_code VARCHAR(30) NULL,
  referrer_source VARCHAR(10) NOT NULL DEFAULT 'none',
  referrer_other VARCHAR(120) NOT NULL DEFAULT '',
  google_event_id VARCHAR(200) NULL,
  meet_link VARCHAR(300) NULL,
  calendar_attempts INT NOT NULL DEFAULT 0,
  calendar_error VARCHAR(500) NULL,
  manage_token_hash VARCHAR(64) NOT NULL UNIQUE,
  internal_note TEXT NULL,
  cancelled_at DATETIME(3) NULL,
  cancelled_by VARCHAR(10) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY appt_bookings_start (start_at),
  KEY appt_bookings_status_start (status, start_at),
  KEY appt_bookings_phone (client_phone),
  KEY appt_bookings_email (client_email),
  KEY appt_bookings_referrer (referrer_code, start_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appt_email_outbox (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  booking_id CHAR(36) NOT NULL,
  kind VARCHAR(20) NOT NULL,          -- confirmation | reminder | cancellation | admin_alert | referrer_alert
  to_email VARCHAR(200) NOT NULL,
  to_name VARCHAR(120) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | sending | accepted | failed | needs_review | skipped
  attempts INT NOT NULL DEFAULT 0,
  idem_key CHAR(36) NOT NULL,
  not_before DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error VARCHAR(300) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY appt_outbox_once (booking_id, kind, to_email),
  KEY appt_outbox_pending (status, not_before)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appt_audit (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_admin_id CHAR(36) NULL,
  action VARCHAR(40) NOT NULL,
  booking_id CHAR(36) NULL,
  detail TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
