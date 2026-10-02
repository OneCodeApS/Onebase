-- Per-bucket policy: visibility (public/private), upload size cap, MIME
-- whitelist. Buckets exist in MinIO, but their dashboard-enforced policies
-- live here. Buckets without a row use the defaults baked into the app.

CREATE TABLE _dashboard.bucket_policies (
	bucket          text PRIMARY KEY,
	visibility      text NOT NULL DEFAULT 'private'
		CHECK (visibility IN ('public', 'private')),
	max_upload_mb   integer NOT NULL DEFAULT 25 CHECK (max_upload_mb > 0),
	-- NULL means "all MIME types allowed". An empty array would mean "nothing
	-- allowed" which is rarely useful — use NULL to express "no restriction".
	allowed_mime    text[],
	-- Private buckets only: a public.<fn>(p_bucket text, p_keys text[])
	-- returns setof text that the dashboard calls as the end-user (through
	-- PostgREST, so RLS applies) to decide which keys they may read / write.
	-- NULL = service_role only. Mirrors migration 0033.
	read_check      text CONSTRAINT bucket_policies_read_check_name
		CHECK (read_check IS NULL OR read_check ~ '^[a-z_][a-z0-9_]{0,62}$'),
	write_check     text CONSTRAINT bucket_policies_write_check_name
		CHECK (write_check IS NULL OR write_check ~ '^[a-z_][a-z0-9_]{0,62}$'),
	updated_at      timestamptz NOT NULL DEFAULT now(),
	updated_by      uuid REFERENCES _dashboard.users(id) ON DELETE SET NULL
);

GRANT ALL ON _dashboard.bucket_policies TO dashboard_admin;
