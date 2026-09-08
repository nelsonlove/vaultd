//! Deterministic rendezvous points inside the reconciliation engine.
//!
//! A race is only worth asserting on if it can be *forced*. Sleeping until a
//! window "probably" opened proves nothing and flakes under load, so the
//! engine exposes a handful of named points a test can park on, rendezvous
//! at, or mutate the world from. Production never installs a hook: every
//! constructor leaves the slot `None` and each point costs one `Option`
//! check.
//!
//! Only points a test cannot reach any other way live here. The commit /
//! live-install boundary is already covered by
//! [`crate::IndexService::pause_publication_for_test`], and the
//! row-writing window by `pause_row_writes_for_test`, so neither is
//! duplicated as a `HookPoint`.

use std::sync::Arc;

/// Where inside one reconciliation cycle a test wants control.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HookPoint {
    /// One dirty path's bytes have been read and decoded, and its
    /// after-read fingerprint has *not* been taken yet. Rewriting the file
    /// from here is what makes the stability re-check's rejection
    /// deterministic instead of a matter of timing.
    AfterBodyRead,
    /// Every path this cycle will create, replace, or delete has been
    /// planned and resolved, and `confirm_planned_presence` has not run yet.
    /// Creating or deleting a planned path from here forces the
    /// pre-publication presence check to reject the batch.
    BeforePresenceCheck,
    /// The graph delta is prepared and the compare-and-swap has not run yet.
    /// Committing a foreign generation from here — through a separate
    /// connection, as another process would — forces the delta to lose its
    /// compare-and-swap and re-plan.
    BeforeDeltaPublication,
    /// A mutation's precondition has been satisfied and its bytes have not
    /// been written yet. Writing the same path from here — as another process
    /// would — is what makes the compare-and-swap's re-check deterministic
    /// instead of a matter of timing.
    AfterMutationPrecondition,
    /// A rename's movement has landed and not one referencing note has been
    /// rewritten yet. Three claims are asserted from here rather than argued:
    /// aborting produces exactly the crash the ordering guarantee is about
    /// (inbound links left pointing at a path that no longer exists, so
    /// visibly unresolved); editing a referrer forces the write-time
    /// compare-and-swap; and deleting one forces the absent-referrer skip.
    BeforeLinkRewrites,
    /// Every referencing note has been rewritten, the destination is reserved,
    /// and the renamed file has not moved yet. Aborting from here produces
    /// exactly the crash the ordering guarantee is about, so the convergence
    /// claim can be asserted rather than argued; removing the source from here
    /// forces the reservation's cleanup path.
    BeforeRenameMove,
}

/// A test's callback into the engine. `Send + Sync` because the writer may
/// live on its own thread, and `&self` because a hook is shared rather than
/// owned: hooks that need to fire once, or count, use interior mutability.
pub trait TestHook: Send + Sync {
    fn reach(&self, point: HookPoint);
}

/// The installed hook, if any. `None` in every production build.
pub(crate) type InstalledHook = Option<Arc<dyn TestHook>>;
