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
/// downgrading it to "unconditional". Exactly one field must be set; the
/// server validates that and answers `invalid_request` otherwise, because a
/// two-field precondition has no meaning.
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

/// One addressed key and what becomes of it. `key_path` is a dot-path
/// (`a.b.c`) addressing nested keys; an explicit JSON `value: null` deletes.
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
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FrontmatterEditDto {
    pub key_path: String,
    pub value: Option<PatchValueDto>,
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
        }

        struct FrontmatterEditVisitor;

        impl<'de> serde::de::Visitor<'de> for FrontmatterEditVisitor {
            type Value = FrontmatterEditDto;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a frontmatter edit with `key_path` and `value`")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut key_path: Option<String> = None;
                // The outer `Option` records whether the `value` key was
                // seen at all; the inner one is the deletion sentinel an
                // explicit JSON `null` produces.
                let mut value: Option<Option<PatchValueDto>> = None;
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
                    }
                }
                let key_path =
                    key_path.ok_or_else(|| serde::de::Error::missing_field("key_path"))?;
                let value = value.ok_or_else(|| serde::de::Error::missing_field("value"))?;
                Ok(FrontmatterEditDto { key_path, value })
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
    #[serde(default)]
    pub expected: ExpectedDto,
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
    #[serde(default)]
    pub expected: ExpectedDto,
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
    #[serde(default)]
    pub expected_source: ExpectedDto,
    #[serde(default)]
    pub if_exists: CopyConflictDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteNoteParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DeleteModeDto>,
    #[serde(default)]
    pub expected: ExpectedDto,
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
    #[serde(default)]
    pub expected: ExpectedDto,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WriteFileParams {
    pub path: String,
    pub content_base64: String,
    #[serde(default)]
    pub expected: ExpectedDto,
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
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GenerationResponse {
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RenameResponse {
    pub generation: u64,
    pub revision: String,
    pub links_rewritten: u64,
    pub link_rewrite_failures: Vec<LinkRewriteFailureDto>,
}

/// `generation` is absent and `semantic` is `false` for a write into the
/// `.obsidian` zone: nothing there is indexed, so no generation contains it.
///
/// `semantic` answers **"is this path inside the indexed vault"** — it is
/// `!` the configuration-zone test and nothing else. It deliberately does not
/// answer "did this write change indexed rows", which for a raw write is
/// always `false`: `write_file` reaches only attachments and the zone, and a
/// `.md` path is refused so a note can never bypass its generation.
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
