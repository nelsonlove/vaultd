//! Narrow SQL for populating a `LiveGraph`: paths, headings, block ids,
//! reference target columns, stored resolution columns, and ambiguous
//! candidates. Never `source_bytes`, `properties`, `aliases`, or `tags` —
//! enforced below by `hydration_never_selects_full_note_bodies_or_metadata`.
//!
//! One stated exception: `bases.source_bytes`, read by
//! `crate::store::BASE_RECORDS_SQL`. A base's bytes are its whole state (a
//! few hundred bytes of YAML), and re-parsing them is what keeps a restart
//! from reading the vault while still giving the live graph the parsed
//! `BaseFile` that evaluation needs. Note bodies are never read.

use std::collections::BTreeMap;

use rusqlite::{Connection, params};
use vault_core::{LinkTarget, VaultPath};

use crate::codec;
use crate::error::IndexError;
use crate::live_graph::{HydratedNote, HydratedReference, LiveGraph};
use crate::model::Generation;
use crate::store::i64_to_usize;

const GENERATION_SQL: &str = "SELECT generation FROM index_metadata WHERE singleton = 1";

const NOTES_SQL: &str = "SELECT path FROM notes ORDER BY path";
const HEADINGS_SQL: &str = "SELECT note_path, text FROM headings ORDER BY note_path, ordinal";
const BLOCKS_SQL: &str = "SELECT note_path, identifier FROM blocks ORDER BY note_path, ordinal";
const REFERENCES_SQL: &str = "SELECT r.id, r.note_path, r.ordinal, r.raw_target, r.file_target, \
     r.subpath_kind, r.subpath_value, s.kind, s.target_path, s.subpath_kind, s.subpath_value \
     FROM note_references r JOIN resolutions s ON s.reference_id = r.id \
     ORDER BY r.note_path, r.ordinal";
const CANDIDATES_SQL: &str =
    "SELECT candidate_path FROM resolution_candidates WHERE reference_id = ?1 ORDER BY ordinal";

/// Hydrate a `LiveGraph` from one consistent snapshot: the generation and
/// every row read here are taken from a single deferred read transaction
/// (`Connection::unchecked_transaction`, which takes `&self` rather than
/// `&mut self`, since under WAL a deferred transaction's first read pins a
/// snapshot for every statement that follows). Without this, a publish
/// committing between the five separate implicit read transactions the
/// individual statements would otherwise each open could hand back notes
/// and references from different generations — exactly the "torn read"
/// `LiveGraph::from_hydrated` now refuses to accept silently.
pub(crate) fn hydrate_live_graph(connection: &Connection) -> Result<LiveGraph, IndexError> {
    let transaction = connection.unchecked_transaction()?;

    let generation = load_generation(&transaction)?.ok_or(IndexError::IndexUnavailable)?;
    let paths = load_paths(&transaction)?;
    let mut headings = load_text_map(&transaction, HEADINGS_SQL)?;
    let mut blocks = load_text_map(&transaction, BLOCKS_SQL)?;

    let notes: Vec<HydratedNote> = paths
        .into_iter()
        .map(|path| {
            let key = path.as_str().to_string();
            HydratedNote {
                headings: headings.remove(&key).unwrap_or_default(),
                blocks: blocks.remove(&key).unwrap_or_default(),
                path,
            }
        })
        .collect();

    let references = load_references(&transaction)?;

    // Read-only: no commit needed, and dropping the transaction here rolls
    // back (a no-op against an unmodified database) rather than panicking.
    let bases = crate::store::load_base_records(&transaction)?;
    let mut graph = LiveGraph::from_hydrated(generation, notes, references)?;
    graph.install_bases(bases, &[]);
    Ok(graph)
}

fn load_generation(connection: &Connection) -> Result<Option<Generation>, IndexError> {
    let value: Option<i64> = connection.query_row(GENERATION_SQL, [], |row| row.get(0))?;
    value.map(Generation::from_db).transpose()
}

fn load_paths(connection: &Connection) -> Result<Vec<VaultPath>, IndexError> {
    let mut statement = connection.prepare(NOTES_SQL)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    rows.iter().map(|path| codec::decode_path(path)).collect()
}

fn load_text_map(
    connection: &Connection,
    sql: &str,
) -> Result<BTreeMap<String, Vec<String>>, IndexError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (path, value) in rows {
        map.entry(path).or_default().push(value);
    }
    Ok(map)
}

struct ReferenceSeed {
    id: i64,
    source_path: String,
    ordinal: i64,
    raw_target: String,
    file_target: Option<String>,
    subpath_kind: Option<String>,
    subpath_value: Option<String>,
    resolution_kind: String,
    resolution_target: Option<String>,
    resolution_subpath_kind: Option<String>,
    resolution_subpath_value: Option<String>,
}

fn load_references(connection: &Connection) -> Result<Vec<HydratedReference>, IndexError> {
    let mut statement = connection.prepare(REFERENCES_SQL)?;
    let seeds = statement
        .query_map([], |row| {
            Ok(ReferenceSeed {
                id: row.get(0)?,
                source_path: row.get(1)?,
                ordinal: row.get(2)?,
                raw_target: row.get(3)?,
                file_target: row.get(4)?,
                subpath_kind: row.get(5)?,
                subpath_value: row.get(6)?,
                resolution_kind: row.get(7)?,
                resolution_target: row.get(8)?,
                resolution_subpath_kind: row.get(9)?,
                resolution_subpath_value: row.get(10)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut references = Vec::with_capacity(seeds.len());
    for seed in seeds {
        let source_path = codec::decode_path(&seed.source_path)?;
        let ordinal =
            u32::try_from(i64_to_usize(seed.ordinal, "reference ordinal")?).map_err(|_| {
                IndexError::IncompatibleIndex("reference ordinal exceeds u32 range".into())
            })?;
        let target = LinkTarget {
            raw_target: seed.raw_target,
            file_target: seed.file_target,
            subpath: codec::decode_subpath(
                seed.subpath_kind.as_deref(),
                seed.subpath_value.as_deref(),
            )?,
        };
        let candidates = if seed.resolution_kind == "ambiguous" {
            load_candidates(connection, seed.id)?
        } else {
            Vec::new()
        };
        let resolution = codec::decode_resolution(
            &seed.resolution_kind,
            seed.resolution_target.as_deref(),
            seed.resolution_subpath_kind.as_deref(),
            seed.resolution_subpath_value.as_deref(),
            candidates,
        )?;
        references.push(HydratedReference {
            source_path,
            ordinal,
            target,
            resolution,
        });
    }
    Ok(references)
}

fn load_candidates(connection: &Connection, reference_id: i64) -> Result<Vec<String>, IndexError> {
    let mut statement = connection.prepare(CANDIDATES_SQL)?;
    let rows = statement
        .query_map(params![reference_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::{
        BLOCKS_SQL, CANDIDATES_SQL, GENERATION_SQL, HEADINGS_SQL, NOTES_SQL, REFERENCES_SQL,
    };

    /// Every statement hydration runs against the note tables, checked
    /// directly against its literal text so a future edit that starts
    /// selecting a note-body or metadata column fails this test immediately.
    /// `BASE_RECORDS_SQL`, the one stated exception, is pinned by
    /// `the_base_hydration_query_reads_only_the_bases_table`.
    const HYDRATION_QUERIES: &[&str] = &[
        GENERATION_SQL,
        NOTES_SQL,
        HEADINGS_SQL,
        BLOCKS_SQL,
        REFERENCES_SQL,
        CANDIDATES_SQL,
    ];

    #[test]
    fn hydration_never_selects_full_note_bodies_or_metadata() {
        for sql in HYDRATION_QUERIES {
            let lower = sql.to_lowercase();
            assert!(
                !lower.contains("source_bytes"),
                "hydration SQL touched source_bytes: {sql}"
            );
            assert!(
                !lower.contains("properties"),
                "hydration SQL touched properties: {sql}"
            );
            assert!(
                !lower.contains("property_scalars"),
                "hydration SQL touched property_scalars: {sql}"
            );
            assert!(
                !lower.contains("aliases"),
                "hydration SQL touched aliases: {sql}"
            );
            assert!(!lower.contains("tags"), "hydration SQL touched tags: {sql}");
        }
    }

    /// The one hydration statement allowed to read `source_bytes`: a base's
    /// bytes are its whole state, and re-parsing them is what keeps a restart
    /// from reading the vault. It reads `bases` and nothing else.
    #[test]
    fn the_base_hydration_query_reads_only_the_bases_table() {
        let lower = crate::store::BASE_RECORDS_SQL.to_lowercase();
        assert!(lower.contains("from bases "), "{lower}");
        for table in [
            "notes",
            "properties",
            "property_scalars",
            "aliases",
            "tags",
            "join",
        ] {
            assert!(
                !lower.contains(table),
                "base hydration SQL touched {table}: {lower}"
            );
        }
    }
}
