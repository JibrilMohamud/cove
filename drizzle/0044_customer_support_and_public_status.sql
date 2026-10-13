-- Customer-visible conversations are separate from confidential staff case notes.
CREATE TABLE customer_support_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  order_id TEXT REFERENCES commerce_orders(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK(category IN ('billing','refund','download','account','reading','other')),
  subject TEXT NOT NULL CHECK(length(subject) BETWEEN 3 AND 180),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','pending_customer','pending_internal','resolved','closed')),
  version INTEGER NOT NULL DEFAULT 1,
  creation_key TEXT NOT NULL,
  creation_sha256 TEXT NOT NULL,
  request_reference TEXT,
  last_read_version INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,creation_key)
);
CREATE INDEX idx_customer_support_owner ON customer_support_tickets(user_id,updated_at DESC,id);
CREATE INDEX idx_customer_support_queue ON customer_support_tickets(status,updated_at,id);
CREATE TRIGGER trg_customer_support_open_limit BEFORE INSERT ON customer_support_tickets BEGIN
  SELECT RAISE(ABORT,'customer support open limit')
    WHERE (SELECT count(*) FROM customer_support_tickets WHERE user_id=NEW.user_id AND status NOT IN ('resolved','closed'))>=10;
END;
CREATE TRIGGER trg_customer_support_reopen_limit BEFORE UPDATE OF status ON customer_support_tickets
WHEN OLD.status IN ('resolved','closed') AND NEW.status NOT IN ('resolved','closed') BEGIN
  SELECT RAISE(ABORT,'customer support open limit')
    WHERE (SELECT count(*) FROM customer_support_tickets WHERE user_id=NEW.user_id AND status NOT IN ('resolved','closed'))>=10;
END;
CREATE TABLE customer_support_messages (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES customer_support_tickets(id) ON DELETE CASCADE,
  sender_kind TEXT NOT NULL CHECK(sender_kind IN ('customer','staff')),
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 6000),
  request_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(ticket_id,sender_id,request_key)
);
CREATE UNIQUE INDEX idx_customer_support_messages ON customer_support_messages(ticket_id,expected_version DESC);
CREATE TRIGGER trg_customer_support_message_version BEFORE INSERT ON customer_support_messages BEGIN
  SELECT RAISE(ABORT,'customer support version conflict')
    WHERE (SELECT version FROM customer_support_tickets WHERE id=NEW.ticket_id)<>NEW.expected_version;
  SELECT RAISE(ABORT,'customer support ticket closed')
    WHERE NEW.sender_kind='customer' AND (SELECT status FROM customer_support_tickets WHERE id=NEW.ticket_id)='closed';
END;

-- Explicitly authored public notices; never expose raw internal incidents or errors.
CREATE TABLE public_service_notices (
  id TEXT PRIMARY KEY NOT NULL,
  creation_sha256 TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 3 AND 180),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 3000),
  status TEXT NOT NULL CHECK(status IN ('investigating','identified','monitoring','resolved')),
  severity TEXT NOT NULL CHECK(severity IN ('degraded','outage')),
  components_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  published_by TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_public_service_notices ON public_service_notices(status,updated_at DESC);
CREATE TABLE public_service_notice_history (
  id TEXT PRIMARY KEY NOT NULL,
  notice_id TEXT NOT NULL REFERENCES public_service_notices(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  components_json TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES staff_principals(user_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(notice_id,version)
);
CREATE TRIGGER trg_public_notice_history_version BEFORE INSERT ON public_service_notice_history BEGIN
  SELECT RAISE(ABORT,'public notice version conflict') WHERE NOT (
    (NEW.version=1 AND (SELECT version FROM public_service_notices WHERE id=NEW.notice_id)=1 AND NOT EXISTS(SELECT 1 FROM public_service_notice_history WHERE notice_id=NEW.notice_id))
    OR (NEW.version=(SELECT version+1 FROM public_service_notices WHERE id=NEW.notice_id))
  );
END;
CREATE TRIGGER trg_public_notice_history_update BEFORE UPDATE ON public_service_notice_history BEGIN SELECT RAISE(ABORT,'public notice history is immutable'); END;
CREATE TRIGGER trg_public_notice_history_delete BEFORE DELETE ON public_service_notice_history BEGIN SELECT RAISE(ABORT,'public notice history is immutable'); END;
