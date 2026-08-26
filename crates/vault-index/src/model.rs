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

/// How the live runtime is currently keeping the cache up to date. Purely
/// observational: readers report it, nothing branches on it inside this
/// crate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveState {
    Starting,
    CatchingUp,
    Watching,
    PollingFallback,
    Stopped,
}

/// Everything a reader must agree with before it answers: the generation
/// that is client-visible, the live graph that matches those exact rows, and
/// the runtime's own status.
///
/// `generation` and `graph` are always installed together, inside the same
/// publication-barrier write section that holds the SQLite commit, so a
/// reader can never see rows from one generation and a live graph from
/// another. `generation: None` means "nothing published yet" — every read
/// answers `IndexError::IndexUnavailable` until the first publication.
#[derive(Clone)]
pub struct PublishedState {
    pub generation: Option<Generation>,
    pub graph: Option<std::sync::Arc<crate::LiveGraph>>,
    pub live_state: LiveState,
    pub runtime_error: Option<String>,
}

impl PublishedState {
    /// The state a freshly-opened service starts from: nothing published,
    /// no live graph, no runtime error.
    pub(crate) fn starting() -> Self {
        Self {
            generation: None,
            graph: None,
            live_state: LiveState::Starting,
            runtime_error: None,
        }
    }
}

impl std::fmt::Debug for PublishedState {
    /// Summarizes the graph rather than printing it: a `LiveGraph` debug
    /// dump is proportional to the whole vault.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PublishedState")
            .field("generation", &self.generation.map(Generation::get))
            .field(
                "graph_generation",
                &self.graph.as_ref().map(|graph| graph.generation().get()),
            )
            .field("live_state", &self.live_state)
            .field("runtime_error", &self.runtime_error)
            .finish()
    }
}

/// The publication barrier itself: the single lock that separates a
/// generation-consistent reader from the writer.
///
/// Lock order is always `publication barrier -> reader connection` (and
/// `publication barrier -> resolver cache`); the writer never takes a
/// reader's connection lock, and no reader ever takes the write side. A
/// poisoned barrier surfaces as `IndexError::Storage` — production code
/// never unwraps it.
pub type PublicationBarrier = std::sync::Arc<std::sync::RwLock<PublishedState>>;
