CREATE TABLE index_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    semantic_format_version INTEGER NOT NULL,
    vault_identity TEXT NOT NULL,
    generation INTEGER,
    created_at_unix_ms INTEGER NOT NULL,
    refreshed_at_unix_ms INTEGER,
    last_refresh_error TEXT
);

CREATE TABLE notes (
    path TEXT PRIMARY KEY,
    content_revision TEXT NOT NULL,
    source_bytes BLOB NOT NULL,
    filename_comparison_key TEXT NOT NULL,
    stem_comparison_key TEXT NOT NULL,
    observed_size INTEGER NOT NULL CHECK (observed_size >= 0),
    observed_mtime_seconds INTEGER NOT NULL,
    observed_mtime_nanos INTEGER NOT NULL
        CHECK (observed_mtime_nanos >= 0 AND observed_mtime_nanos < 1000000000)
);

CREATE TABLE properties (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    key_text TEXT NOT NULL,
    value_json TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    key_span_start INTEGER NOT NULL,
    key_span_end INTEGER NOT NULL,
    value_span_start INTEGER NOT NULL,
    value_span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE aliases (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    value TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE headings (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    level INTEGER NOT NULL,
    text TEXT NOT NULL,
    comparison_key TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE blocks (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    identifier TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE tags (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    value TEXT NOT NULL,
    comparison_key TEXT NOT NULL,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE note_references (
    id INTEGER PRIMARY KEY,
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    raw_target TEXT NOT NULL,
    file_target TEXT,
    subpath_kind TEXT,
    subpath_value TEXT,
    display TEXT,
    span_start INTEGER NOT NULL,
    span_end INTEGER NOT NULL,
    target_span_start INTEGER NOT NULL,
    target_span_end INTEGER NOT NULL,
    UNIQUE (note_path, ordinal)
);

CREATE TABLE resolutions (
    reference_id INTEGER PRIMARY KEY
        REFERENCES note_references(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target_path TEXT,
    subpath_kind TEXT,
    subpath_value TEXT
);

CREATE TABLE resolution_candidates (
    reference_id INTEGER NOT NULL
        REFERENCES note_references(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    candidate_path TEXT NOT NULL,
    PRIMARY KEY (reference_id, ordinal)
);

CREATE TABLE note_diagnostics (
    note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    path TEXT,
    span_start INTEGER,
    span_end INTEGER,
    PRIMARY KEY (note_path, ordinal)
);

CREATE TABLE scan_diagnostics (
    ordinal INTEGER PRIMARY KEY,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    path TEXT,
    span_start INTEGER,
    span_end INTEGER
);

CREATE TABLE diagnostics (
    id INTEGER PRIMARY KEY,
    ordinal INTEGER NOT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    path TEXT,
    span_start INTEGER,
    span_end INTEGER
);

CREATE INDEX headings_lookup ON headings(note_path, comparison_key);
CREATE INDEX blocks_lookup ON blocks(note_path, identifier);
CREATE INDEX tags_lookup ON tags(comparison_key, note_path, ordinal);
CREATE INDEX notes_filename_lookup ON notes(filename_comparison_key, path);
CREATE INDEX notes_stem_lookup ON notes(stem_comparison_key, path);
CREATE INDEX references_source_order
    ON note_references(note_path, span_start, span_end, id);
CREATE INDEX resolutions_target
    ON resolutions(target_path, kind, reference_id);
CREATE INDEX resolutions_kind
    ON resolutions(kind, reference_id);
CREATE INDEX diagnostics_path_order
    ON diagnostics(path, span_start, span_end, code, message, id);
CREATE INDEX diagnostics_severity_order
    ON diagnostics(severity, path, span_start, span_end, id);
