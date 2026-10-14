-- A school's terms never overlap (CARM-60, docs/architecture/data-model.md
-- "Terms"). Both first and last day count: a term ending on 30 Jan and one
-- starting on 30 Jan overlap; back-to-back terms (30 Jan / 31 Jan) don't.
-- Hand-written: Prisma does not model CHECK or EXCLUDE constraints.

-- Refuse to migrate over data that already breaks the rule, naming the
-- clashing terms so they can be fixed (edit the dates or delete one) first.
DO $$
DECLARE
  clashes TEXT;
BEGIN
  SELECT string_agg(
           format('%s: "%s" (%s – %s) and "%s" (%s – %s)',
                  s."name", a."name", a."start_date", a."end_date",
                  b."name", b."start_date", b."end_date"),
           E'\n')
    INTO clashes
    FROM "terms" a
    JOIN "terms" b
      ON b."school_id" = a."school_id"
     AND a."id" < b."id"
     AND a."start_date" <= b."end_date"
     AND b."start_date" <= a."end_date"
    JOIN "schools" s ON s."id" = a."school_id";
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION E'Overlapping terms must be fixed before this migration:\n%', clashes;
  END IF;
END $$;

-- `terms_dates_check` (start <= end) already keeps the range below valid.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "terms"
  ADD CONSTRAINT "terms_no_overlap" EXCLUDE USING gist (
    "school_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  );
