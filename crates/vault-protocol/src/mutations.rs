//! Mutation and raw-file DTOs.
//!
//! Additive to protocol version 1: no existing shape changes. Every wire
//! spelling here is contractual — the design names them, `docs/protocol.md`
//! documents them, and `tests/mutations.rs` pins them.

use serde::{Deserialize, Serialize};

/// The precondition a content-bearing mutation carries.
///
/// Modelled as three optional fields rather than a tagged enum because that
/// is the wire shape the design specifies (`{"revision": …}`,
/// `{"absent": true}`, `{"any": true}`), and because `deny_unknown_fields`
/// then rejects a misspelled precondition loudly instead of silently
/// downgrading it to "unconditional". Omitting `expected` altogether means
/// unconditional; an expected object that is *present* must name exactly one
/// field — the server answers `invalid_request` for an empty object (a
/// typo-shaped client bug) and for a two-field precondition (which has no
/// meaning).
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub any: Option<bool>,
}

/// How a delete disposes of its target. The shim passes the plugin's own
/// choice through; a direct client that omits this gets the vault's
/// `.obsidian/app.json` `trashOption` default.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteModeDto {
    TrashSystem,
    TrashLocal,
    Permanent,
}

/// What `copy_file` does when its destination already exists.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyConflictDto {
    #[default]
    Error,
    /// Obsidian's auto-numbering behaviour, for `getAvailablePath` parity.
    Suffix,
}

/// One frontmatter value a patch sets. There is no null variant: a JSON
/// `null` in `value` is the deletion spelling, carried as
/// `FrontmatterEditDto::value == None`.
///
/// `Serialize`/`Deserialize` are hand-written rather than derived with
/// `#[serde(untagged)]`: a derived untagged enum represents `Mapping`'s
/// `Vec<(String, PatchValueDto)>` as a JSON array of two-element arrays
/// (that is what `Vec<(K, V)>` serializes as), not the JSON object the
/// design requires. `Vec` rather than a map keeps key order — the order a
/// client wrote the frontmatter keys in — instead of a `HashMap`'s or
/// `BTreeMap`'s.
#[derive(Clone, Debug, PartialEq)]
pub enum PatchValueDto {
    Boolean(bool),
    Integer(i64),
    Float(f64),
    String(String),
    Sequence(Vec<PatchValueDto>),
    Mapping(Vec<(String, PatchValueDto)>),
}

impl Serialize for PatchValueDto {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Boolean(value) => value.serialize(serializer),
            Self::Integer(value) => value.serialize(serializer),
            Self::Float(value) => value.serialize(serializer),
            Self::String(value) => value.serialize(serializer),
            Self::Sequence(value) => value.serialize(serializer),
            Self::Mapping(entries) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for PatchValueDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct PatchValueVisitor;

        impl<'de> serde::de::Visitor<'de> for PatchValueVisitor {
            type Value = PatchValueDto;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a boolean, integer, float, string, array, or object")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(PatchValueDto::Boolean(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(PatchValueDto::Integer(value))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                i64::try_from(value)
                    .map(PatchValueDto::Integer)
                    .map_err(|_| E::custom(format!("integer {value} does not fit in i64")))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(PatchValueDto::Float(value))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(PatchValueDto::String(value.to_string()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(PatchValueDto::String(value))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<PatchValueDto>()? {
                    items.push(item);
                }
                Ok(PatchValueDto::Sequence(items))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut entries = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, PatchValueDto>()? {
                    entries.push((key, value));
                }
                Ok(PatchValueDto::Mapping(entries))
            }
        }

        deserializer.deserialize_any(PatchValueVisitor)
    }
}

/// How one patch entry addresses its key. Two spellings, both protocol
/// version 1, and the second is purely additive.
///
/// * [`KeyPathDto::Dotted`] is the original `a.b.c`, unchanged in meaning:
///   every `.` starts a new segment. That is why it cannot address a key
///   whose *own name* holds a dot — `my.key` means "`key` inside `my`", and a
///   host that sent it for a literal `my.key` grew a phantom nested mapping
///   beside the key it meant to edit.
/// * [`KeyPathDto::Segments`] is an array in which each element is one
///   literal key, dots included. It splits on nothing.
///
/// Tolerant on both sides: a string decodes as `Dotted` and serializes back
/// as a string, an array decodes as `Segments` and serializes back as an
/// array, so neither form is rewritten into the other in transit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KeyPathDto {
    Dotted(String),
    Segments(Vec<String>),
}

impl KeyPathDto {
    /// The segments this path addresses, in order — the dot-split for
    /// `Dotted`, the elements themselves for `Segments`.
    pub fn segments(&self) -> Vec<&str> {
        match self {
            Self::Dotted(text) => text.split('.').collect(),
            Self::Segments(segments) => segments.iter().map(String::as_str).collect(),
        }
    }

    /// A rendering for an error message. Never re-parsed: the array form is
    /// bracketed precisely so a segment carrying a dot is not mistaken for
    /// two segments in the text a client reads back.
    pub fn display(&self) -> String {
        match self {
            Self::Dotted(text) => text.clone(),
            Self::Segments(segments) => format!("[{}]", segments.join(", ")),
        }
    }
}

/// Equality against a dot-string compares what the two **address**, not how
/// they are spelled: `Segments(["my.key"])` is not equal to `"my.key"`,
/// because the string form addresses `key` inside `my` and the array form
/// addresses one literal key.
impl PartialEq<str> for KeyPathDto {
    fn eq(&self, other: &str) -> bool {
        self.segments() == other.split('.').collect::<Vec<_>>()
    }
}

impl PartialEq<&str> for KeyPathDto {
    fn eq(&self, other: &&str) -> bool {
        self == *other
    }
}

impl Serialize for KeyPathDto {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Dotted(text) => text.serialize(serializer),
            Self::Segments(segments) => segments.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for KeyPathDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct KeyPathVisitor;

        impl<'de> serde::de::Visitor<'de> for KeyPathVisitor {
            type Value = KeyPathDto;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a dot-path string or an array of literal key segments")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(KeyPathDto::Dotted(value.to_string()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(KeyPathDto::Dotted(value))
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut segments = Vec::new();
                while let Some(segment) = seq.next_element::<String>()? {
                    segments.push(segment);
                }
                Ok(KeyPathDto::Segments(segments))
            }
        }

        deserializer.deserialize_any(KeyPathVisitor)
    }
}

/// One addressed key and what becomes of it. `key_path` is a dot-path
/// (`a.b.c`) or an array of literal segments (see [`KeyPathDto`]); an
/// explicit JSON `value: null` deletes, and `set_null: true` — carried
/// **instead of** `value` — writes a YAML null.
///
/// `Deserialize` is hand-written rather than derived: the brief's own spec
/// text only ever describes an *explicit* JSON `null` as the deletion
/// spelling ("`value: null` deletes"), never "an absent `value` deletes".
/// Serde's derive makes `Option<T>` struct fields implicitly optional —
/// `{"key_path":"tags"}` would silently decode to `value: None`, the same
/// bit pattern as an explicit null, turning "forgot to set a value" into
/// "delete this key". The hand-written visitor requires the `value` key to
/// be present (null or not) and rejects anything else as `deny_unknown_fields`
/// would, so a misspelled key at this nesting level is also a typed error
/// rather than a silently-ignored field.
///
/// `set_null` is the third action, additive and mutually exclusive with
/// `value`. Obsidian's `processFrontMatter` writes `key: null` when a plugin
/// assigns `fm.key = null`, and until this field existed the wire could not
/// say it at all: a JSON `null` in `value` is the deletion spelling, so the
/// key would have vanished instead of holding a null. An entry carrying both
/// `set_null` and `value` says two contradictory things about one key and is
/// refused here rather than silently ordered; over the transport a decode
/// failure is reported as `invalid_request`.
///
/// `Serialize` is hand-written for the same mutual exclusion: a `set_null`
/// entry must not also carry a `value` key, and a `value` entry must keep
/// spelling its explicit `null`, which a skipped `Option` would swallow.
#[derive(Clone, Debug, PartialEq)]
pub struct FrontmatterEditDto {
    pub key_path: KeyPathDto,
    /// `None` is the deletion spelling — an explicit JSON `null` — and is
    /// also what a `set_null` entry carries, since it has no `value` key at
    /// all. `set_null` is what tells the two apart.
    pub value: Option<PatchValueDto>,
    /// Write a YAML null for the addressed key, creating it when absent.
    pub set_null: bool,
}

impl Serialize for FrontmatterEditDto {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("key_path", &self.key_path)?;
        // A `set_null` entry spells no `value`, which is the only shape that
        // decodes back into itself. The in-memory state carrying both never
        // came off the wire — that pair is a decode error — so serializing
        // one writes the action it names.
        if self.set_null {
            map.serialize_entry("set_null", &true)?;
        } else {
            map.serialize_entry("value", &self.value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for FrontmatterEditDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(field_identifier, rename_all = "snake_case")]
        enum Field {
            KeyPath,
            Value,
            SetNull,
        }

        struct FrontmatterEditVisitor;

        impl<'de> serde::de::Visitor<'de> for FrontmatterEditVisitor {
            type Value = FrontmatterEditDto;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(
                    "a frontmatter edit with `key_path` and either `value` or `set_null`",
                )
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut key_path: Option<KeyPathDto> = None;
                // The outer `Option` records whether the `value` key was
                // seen at all; the inner one is the deletion sentinel an
                // explicit JSON `null` produces.
                let mut value: Option<Option<PatchValueDto>> = None;
                let mut set_null: Option<bool> = None;
                while let Some(field) = map.next_key::<Field>()? {
                    match field {
                        Field::KeyPath => {
                            if key_path.is_some() {
                                return Err(serde::de::Error::duplicate_field("key_path"));
                            }
                            key_path = Some(map.next_value()?);
                        }
                        Field::Value => {
                            if value.is_some() {
                                return Err(serde::de::Error::duplicate_field("value"));
                            }
                            value = Some(map.next_value::<Option<PatchValueDto>>()?);
                        }
                        Field::SetNull => {
                            if set_null.is_some() {
                                return Err(serde::de::Error::duplicate_field("set_null"));
                            }
                            set_null = Some(map.next_value::<bool>()?);
                        }
                    }
                }
                let key_path =
                    key_path.ok_or_else(|| serde::de::Error::missing_field("key_path"))?;
                let set_null = set_null.unwrap_or(false);
                // Two contradictory actions on one key. Refused rather than
                // ordered, and refused for `value: null` too: "delete this
                // key" and "write a null here" are different outcomes and
                // picking one silently is the hazard this whole entry type
                // is shaped against.
                if set_null && value.is_some() {
                    return Err(serde::de::Error::custom(
                        "`set_null` cannot be combined with `value`",
                    ));
                }
                // `set_null: false` says nothing, so an omitted `value`
                // beside it is the decode error it always was.
                let value = match value {
                    Some(value) => value,
                    None if set_null => None,
                    None => return Err(serde::de::Error::missing_field("value")),
                };
                Ok(FrontmatterEditDto {
                    key_path,
                    value,
                    set_null,
                })
            }
        }

        deserializer.deserialize_map(FrontmatterEditVisitor)
    }
}

/// One referencing note a rename could not rewrite, and why.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LinkRewriteFailureDto {
    pub path: String,
    pub reason: String,
}

// `deny_unknown_fields` on every params struct below: mutations are the one
// request family where a lost precondition is a lost update, not a forward-
// compatibility nicety, so a misspelled field (`"expect"` for `"expected"`)
// must be a typed decode error rather than a silently-accepted no-op that
// downgrades a conditional write to an unconditional one.

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WriteNoteParams {
    pub path: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<ExpectedDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FolderParams {
    pub path: String,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenameNoteParams {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<ExpectedDto>,
    #[serde(default = "default_true")]
    pub rewrite_links: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenameFolderParams {
    pub from: String,
    pub to: String,
    #[serde(default = "default_true")]
    pub rewrite_links: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CopyFileParams {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_source: Option<ExpectedDto>,
    #[serde(default)]
    pub if_exists: CopyConflictDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteNoteParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DeleteModeDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<ExpectedDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteFolderParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DeleteModeDto>,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PatchFrontmatterParams {
    pub path: String,
    pub patch: Vec<FrontmatterEditDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<ExpectedDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WriteFileParams {
    pub path: String,
    pub content_base64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<ExpectedDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReadFileParams {
    pub path: String,
}

/// A content-bearing mutation's answer: the generation containing it, and
/// the revision it wrote.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MutationResponse {
    pub generation: u64,
    pub revision: String,
}

/// A mutation with no content revision to report — a folder operation, or a
/// delete (a deleted file has no revision).
///
/// `generation` is absent for exactly one case: a `create_folder` that landed
/// on an **unindexable** path — the configuration zone, or any hidden folder.
/// The scan never lists such a folder, so no generation will ever contain it,
/// and naming one would be a generation the client could read at and never
/// find its own write in. It is the same rule, and the same absent-not-zero
/// spelling, `WriteFileResponse::generation` already follows; `0` is a
/// well-formed generation a client would act on, so the key is omitted
/// outright instead. Every indexed create, every delete, and every folder
/// rename keeps reporting one, byte-identically.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GenerationResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RenameResponse {
    pub generation: u64,
    /// The renamed file's content revision. Absent for `rename_folder`: a
    /// folder has no bytes to hash, and a thing with no revision reports no
    /// `revision` key at all rather than an empty string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    pub links_rewritten: u64,
    pub link_rewrite_failures: Vec<LinkRewriteFailureDto>,
}

/// `generation` is absent and `semantic` is `false` for a write into the
/// `.obsidian` zone: nothing there is indexed, so no generation contains it.
///
/// `semantic` answers **"is this path inside the indexed universe"** — the
/// negation of the daemon's unindexable test, which is the configuration zone
/// **and** every hidden folder, because the vault scan lists neither. So a
/// write to `.hidden/data.bin` answers `semantic: false` with no `generation`
/// exactly as a zone write does; the zone is the common case, not the whole
/// rule. Reporting a generation for either would name one that will never
/// contain the write, which is a lie a client acts on.
///
/// It deliberately does not answer "did this write change indexed rows", which
/// for a raw write is always `false`: `write_file` reaches only attachments,
/// the zone, and hidden paths, and *indexable* Markdown is refused so a note
/// can never bypass its generation. An attachment inside the vault is the case
/// where the two answers differ — `semantic: true` here, no semantic rows
/// moved, and a real generation because the file tree moved.
///
/// Both fields answer about **where the bytes landed**, not about the path the
/// request carried. The two differ whenever a symlink or a case-folded
/// spelling resolves across the boundary — into `.obsidian/` under an
/// ordinary-looking name, or out of it into the indexed vault — and answering
/// from the request would name a generation that will never contain the write,
/// or withhold one that already does.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WriteFileResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    pub revision: String,
    pub semantic: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReadFileResponse {
    pub content_base64: String,
    pub revision: String,
}
