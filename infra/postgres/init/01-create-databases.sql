-- Runs once, on first initialisation of an empty data volume.
-- veyra_dev is created by POSTGRES_DB; the test database must be separate so
-- the destructive test reset can never reach development data.
CREATE DATABASE veyra_test OWNER veyra;
