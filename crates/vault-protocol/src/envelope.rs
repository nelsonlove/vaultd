use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, ProtocolError};
use crate::operations::{Request, Response};

pub const PROTOCOL_VERSION: u16 = 1;

// `Eq` is not derivable: `Request` is only `PartialEq` (see its definition —
// `PatchFrontmatter` carries an `f64`).
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RequestEnvelope {
    pub version: u16,
    pub id: String,
    pub request: Request,
}

impl RequestEnvelope {
    pub fn new(id: impl Into<String>, request: Request) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            request,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResponseEnvelope {
    pub version: u16,
    pub id: String,
    pub outcome: ResponseOutcome,
}

impl ResponseEnvelope {
    pub fn success(id: impl Into<String>, response: Response) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            outcome: ResponseOutcome::Ok(response),
        }
    }

    pub fn error(id: impl Into<String>, error: ProtocolError) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            outcome: ResponseOutcome::Err(error),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum ResponseOutcome {
    Ok(Response),
    Err(ProtocolError),
}

pub fn validate_version(version: u16) -> Result<(), ProtocolError> {
    if version == PROTOCOL_VERSION {
        return Ok(());
    }
    Err(ProtocolError {
        code: ErrorCode::IncompatibleVersion,
        message: format!("unsupported protocol version {version}"),
        supported_version: Some(PROTOCOL_VERSION),
        current_generation: None,
        current_revision: None,
    })
}
