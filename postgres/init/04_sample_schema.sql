-- Sample table to demonstrate the API surface and RLS.
-- anon can SELECT; only callers with a valid JWT (role=authenticated) can INSERT.
--
-- ID convention: new tables default their primary key to uuidv7() — a
-- time-ordered UUID (Postgres 18+ built-in). It keeps the unguessable,
-- globally-unique properties of a UUID while sorting roughly by creation
-- time, so it indexes far better than random uuidv4 (gen_random_uuid()).
-- `ORDER BY id` therefore returns rows in insertion order for free.

-- We need an 'authenticated' role for the RLS policy to reference.
CREATE ROLE authenticated NOLOGIN NOINHERIT;
GRANT authenticated TO authenticator;
GRANT USAGE ON SCHEMA public TO authenticated;

CREATE TABLE public.todos (
	id         uuid PRIMARY KEY DEFAULT uuidv7(),
	title      text NOT NULL,
	done       boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

-- Public read: anyone can list todos.
CREATE POLICY todos_select_anon
	ON public.todos
	FOR SELECT
	TO anon, authenticated
	USING (true);

-- Authenticated insert only.
CREATE POLICY todos_insert_authenticated
	ON public.todos
	FOR INSERT
	TO authenticated
	WITH CHECK (true);

-- Authenticated update. USING (true) lets any authenticated caller edit any
-- row — fine for this demo. For per-user ownership, add a user_id column and
-- change both clauses to (user_id = auth.uid()).
CREATE POLICY todos_update_authenticated
	ON public.todos
	FOR UPDATE
	TO authenticated
	USING (true)
	WITH CHECK (true);

-- Authenticated delete.
CREATE POLICY todos_delete_authenticated
	ON public.todos
	FOR DELETE
	TO authenticated
	USING (true);

GRANT SELECT ON public.todos TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.todos TO authenticated;
-- No sequence grant needed: the uuidv7() default is generated in-row, not
-- from a sequence (uuidv7() is executable by PUBLIC, so authenticated can
-- call it implicitly on INSERT).

-- Seed a couple of rows so the API has something to return.
INSERT INTO public.todos (title, done) VALUES
	('Read the README', true),
	('Spin up the stack', false);
