-- PostgreSQL initialization script for succ
-- This runs automatically when the container is first created

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Grant all privileges to succ user
GRANT ALL PRIVILEGES ON DATABASE succ TO succ;

-- Create schema (optional, tables are created by the app)
-- The PostgresBackend.init() method creates all necessary tables
