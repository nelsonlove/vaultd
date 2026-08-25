use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

use crate::error::IndexError;
use crate::model::Generation;

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct CursorPayload {
    pub generation: u64,
    pub query: String,
    pub position: CursorPosition,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum CursorPosition {
    Note {
        path: String,
    },
    Reference {
        source: String,
        start: u64,
        end: u64,
        id: i64,
    },
    Diagnostic {
        path: Option<String>,
        start: Option<u64>,
        end: Option<u64>,
        code: String,
        message: String,
        id: i64,
    },
}

pub(crate) fn encode_cursor(
    generation: Generation,
    query: &str,
    position: CursorPosition,
) -> Result<String, IndexError> {
    let payload = CursorPayload {
        generation: generation.get(),
        query: query.to_string(),
        position,
    };
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload)?))
}

/// Decode strictly: malformed encoding, a mismatched query fingerprint, or a
/// wrong position shape is `InvalidCursor`; a stale generation is
/// `GenerationMismatch` carrying both values.
pub(crate) fn decode_cursor(
    encoded: &str,
    current: Generation,
    query: &str,
) -> Result<CursorPosition, IndexError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|error| IndexError::InvalidCursor(format!("invalid encoding: {error}")))?;
    let payload: CursorPayload = serde_json::from_slice(&bytes)
        .map_err(|error| IndexError::InvalidCursor(format!("invalid payload: {error}")))?;
    if payload.query != query {
        return Err(IndexError::InvalidCursor(format!(
            "cursor belongs to query {:?}, not {query:?}",
            payload.query
        )));
    }
    if payload.generation != current.get() {
        return Err(IndexError::GenerationMismatch {
            cursor: payload.generation,
            current: current.get(),
        });
    }
    Ok(payload.position)
}
