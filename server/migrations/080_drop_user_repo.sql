-- The API server no longer keeps member checkouts (issue #777): runners clone onto their own task
-- volume, and a task launches against any tracked repository, so the per-member selection and its
-- clone/purge state have no reader. Nothing references the table by foreign key.
drop table if exists user_repo;
