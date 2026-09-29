
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE public.books (
  id BIGINT PRIMARY KEY,
  title TEXT NOT NULL,
  authors JSONB NOT NULL DEFAULT '[]'::jsonb,
  translators JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  categories TEXT[] NOT NULL DEFAULT '{}',
  languages TEXT[] NOT NULL DEFAULT '{}',
  cover_url TEXT,
  epub_url TEXT,
  html_url TEXT,
  text_url TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.books TO anon, authenticated;
GRANT ALL ON public.books TO service_role;
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Books are public" ON public.books FOR SELECT USING (true);

CREATE INDEX books_download_count_idx ON public.books (download_count DESC);
CREATE INDEX books_created_at_idx ON public.books (created_at DESC);
CREATE INDEX books_categories_idx ON public.books USING GIN (categories);
CREATE INDEX books_title_trgm_idx ON public.books USING GIN (title gin_trgm_ops);

CREATE TABLE public.ingest_state (
  id INT PRIMARY KEY DEFAULT 1,
  next_page INT NOT NULL DEFAULT 1,
  last_run_at TIMESTAMPTZ,
  last_inserted INT NOT NULL DEFAULT 0,
  CONSTRAINT single_row CHECK (id = 1)
);
GRANT ALL ON public.ingest_state TO service_role;
ALTER TABLE public.ingest_state ENABLE ROW LEVEL SECURITY;
INSERT INTO public.ingest_state (id) VALUES (1);
