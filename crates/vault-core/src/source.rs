use std::sync::Arc;

use thiserror::Error;

use crate::{Revision, SourceSpan, VaultPath};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceDocument {
    path: VaultPath,
    revision: Revision,
    text: Arc<str>,
}

impl SourceDocument {
    pub fn new(path: VaultPath, text: impl Into<Arc<str>>) -> Self {
        let text = text.into();
        let digest = blake3::hash(text.as_bytes());
        let revision = Revision::new(format!("blake3:{digest}"))
            .expect("a formatted BLAKE3 revision is non-empty");
        Self {
            path,
            revision,
            text,
        }
    }

    pub fn from_utf8(path: VaultPath, bytes: Vec<u8>) -> Result<Self, SourceError> {
        let text = String::from_utf8(bytes).map_err(|error| SourceError::InvalidUtf8 {
            path: path.clone(),
            error,
        })?;
        Ok(Self::new(path, text))
    }

    pub fn path(&self) -> &VaultPath {
        &self.path
    }

    pub fn revision(&self) -> &Revision {
        &self.revision
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn slice(&self, span: SourceSpan) -> Option<&str> {
        self.text.get(span.start()..span.end())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spanned<T> {
    pub value: T,
    pub span: SourceSpan,
}

impl<T> Spanned<T> {
    pub fn new(value: T, span: SourceSpan) -> Self {
        Self { value, span }
    }
}

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("{path:?} is not valid UTF-8")]
    InvalidUtf8 {
        path: VaultPath,
        #[source]
        error: std::string::FromUtf8Error,
    },
}
