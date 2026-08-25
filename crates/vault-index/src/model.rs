#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileFingerprint {
    pub size: u64,
    pub modified_seconds: i64,
    pub modified_nanos: u32,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Generation(u64);

impl Generation {
    pub fn new(value: u64) -> Self {
        Self(value)
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn from_db(value: i64) -> Result<Self, crate::IndexError> {
        u64::try_from(value).map(Self).map_err(|_| {
            crate::IndexError::IncompatibleIndex(format!("negative generation {value}"))
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexState {
    Ready,
    Stale { last_error: String },
    Unavailable { last_error: Option<String> },
}
