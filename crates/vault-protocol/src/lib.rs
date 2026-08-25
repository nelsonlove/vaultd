use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Request {
    Health,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Response {
    Health(HealthResponse),
}

impl Response {
    pub fn health(service: impl Into<String>) -> Self {
        Self::Health(HealthResponse {
            service: service.into(),
            status: "ok".into(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HealthResponse {
    pub service: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    pub supported_version: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    IncompatibleVersion,
    InvalidRequest,
    Internal,
}

pub fn validate_version(version: u16) -> Result<(), ProtocolError> {
    if version == PROTOCOL_VERSION {
        return Ok(());
    }
    Err(ProtocolError {
        code: ErrorCode::IncompatibleVersion,
        message: format!("unsupported protocol version {version}"),
        supported_version: Some(PROTOCOL_VERSION),
    })
}
