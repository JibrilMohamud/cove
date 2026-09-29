CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS epub_source_url TEXT,
  ADD COLUMN IF NOT EXISTS epub_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS epub_cached_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
UPDATE public.books SET epub_source_url = epub_url WHERE epub_source_url IS NULL;

ALTER TABLE public.ingest_state
  ADD COLUMN IF NOT EXISTS next_url TEXT DEFAULT 'https://gutendex.com/books/?copyright=false',
  ADD COLUMN IF NOT EXISTS total_catalog_count INTEGER,
  ADD COLUMN IF NOT EXISTS cycle_started_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
UPDATE public.ingest_state
SET next_url = COALESCE(next_url, 'https://gutendex.com/books/?copyright=false&page=' || next_page::text)
WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.epub_ingest_jobs (
  book_id BIGINT PRIMARY KEY REFERENCES public.books(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','downloading','retry','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS epub_jobs_work_idx ON public.epub_ingest_jobs(status, next_attempt_at, created_at);
ALTER TABLE public.epub_ingest_jobs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.epub_ingest_jobs TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('epubs', 'epubs', true, 104857600, ARRAY['application/epub+zip','application/zip'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles are publicly readable" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
GRANT SELECT ON public.profiles TO anon, authenticated;
GRANT INSERT, UPDATE ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
INSERT INTO public.profiles (id, display_name)
SELECT id, COALESCE(raw_user_meta_data->>'display_name', split_part(email, '@', 1)) FROM auth.users
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.user_library (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id BIGINT NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  book_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'want-to-read' CHECK (status IN ('want-to-read','reading','finished')),
  progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  current_page INTEGER NOT NULL DEFAULT 1,
  total_pages INTEGER NOT NULL DEFAULT 1,
  shelves TEXT[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  review TEXT NOT NULL DEFAULT '',
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS user_library_recent_idx ON public.user_library(user_id, last_read_at DESC NULLS LAST);
ALTER TABLE public.user_library ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own their library" ON public.user_library FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT ALL ON public.user_library TO authenticated;

CREATE TABLE IF NOT EXISTS public.shelves (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📚',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS shelves_user_name_unique ON public.shelves(user_id, lower(name)) WHERE deleted_at IS NULL;
ALTER TABLE public.shelves ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own shelves" ON public.shelves FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT ALL ON public.shelves TO authenticated;

CREATE TABLE IF NOT EXISTS public.highlights (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id BIGINT NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  book_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  quote TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('yellow','green','blue','pink','purple')),
  note_html TEXT NOT NULL DEFAULT '',
  page INTEGER NOT NULL DEFAULT 1,
  progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS highlights_user_book_idx ON public.highlights(user_id, book_id, created_at DESC);
CREATE INDEX IF NOT EXISTS highlights_quote_trgm_idx ON public.highlights USING GIN (quote gin_trgm_ops);
ALTER TABLE public.highlights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own highlights" ON public.highlights FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT ALL ON public.highlights TO authenticated;

CREATE TABLE IF NOT EXISTS public.bookmarks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id BIGINT NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  book_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  page INTEGER NOT NULL,
  progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bookmarks_user_book_idx ON public.bookmarks(user_id, book_id);
ALTER TABLE public.bookmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own bookmarks" ON public.bookmarks FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT ALL ON public.bookmarks TO authenticated;

CREATE TABLE IF NOT EXISTS public.reading_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  book_id BIGINT NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  book_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  words_read INTEGER NOT NULL DEFAULT 0,
  page_turns INTEGER NOT NULL DEFAULT 0,
  start_progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  end_progress DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reading_sessions_user_time_idx ON public.reading_sessions(user_id, started_at DESC);
ALTER TABLE public.reading_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own reading sessions" ON public.reading_sessions FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
GRANT ALL ON public.reading_sessions TO authenticated;

CREATE TABLE IF NOT EXISTS public.book_reviews (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  book_id BIGINT NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  review TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, book_id),
  CHECK (rating IS NOT NULL OR length(trim(review)) > 0)
);
CREATE INDEX IF NOT EXISTS book_reviews_book_idx ON public.book_reviews(book_id, updated_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE public.book_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Published reviews are readable" ON public.book_reviews FOR SELECT USING (deleted_at IS NULL OR auth.uid() = user_id);
CREATE POLICY "Users insert own reviews" ON public.book_reviews FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own reviews" ON public.book_reviews FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own reviews" ON public.book_reviews FOR DELETE USING (auth.uid() = user_id);
GRANT SELECT ON public.book_reviews TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.book_reviews TO authenticated;
