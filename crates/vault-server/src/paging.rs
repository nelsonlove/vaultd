//! The collection paging every cached operation shares: the page limit, the
//! cursor codec, and the two refusals a page meets, worded exactly as every
//! other pager's.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use vault_index::IndexError;
use vault_protocol::ProtocolError;

use crate::convert;

/// The protocol's page rule: default 100, from 1 to 1000, `invalid_cursor`
/// outside it.
pub(crate) fn page_limit(limit: Option<u32>) -> Result<usize, ProtocolError> {
    let limit = limit.unwrap_or(vault_index::DEFAULT_PAGE_LIMIT);
    if limit == 0 || limit > vault_index::MAX_PAGE_LIMIT {
        return Err(invalid_cursor(format!(
            "limit must be between 1 and {}",
            vault_index::MAX_PAGE_LIMIT
        )));
    }
    Ok(limit as usize)
}

pub(crate) fn invalid_cursor(message: String) -> ProtocolError {
    convert::index_error(IndexError::InvalidCursor(message))
}

pub(crate) fn generation_mismatch(cursor: u64, current: u64) -> ProtocolError {
    convert::index_error(IndexError::GenerationMismatch { cursor, current })
}

/// A cursor as URL-safe base64 of its JSON, without padding.
pub(crate) fn encode_cursor<T: serde::Serialize>(cursor: &T) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).expect("a cursor serializes"))
}

pub(crate) fn decode_cursor<T: serde::de::DeserializeOwned>(
    cursor: &str,
) -> Result<T, ProtocolError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|failure| invalid_cursor(format!("invalid encoding: {failure}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|failure| invalid_cursor(format!("invalid payload: {failure}")))
}
