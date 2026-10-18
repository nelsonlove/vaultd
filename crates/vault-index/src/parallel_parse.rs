//! Parse many notes on several threads, for the complete (cold) refresh.
//!
//! [`vault_core::parse_note`] is a pure function of one document: it reads
//! no store, no source and no shared state. So the only part of a complete
//! refresh that is safe to spread across cores without touching the
//! single-writer rule is exactly this one. Reads, classification, every
//! SQLite write and the publication stay on the coordinator thread; the
//! workers only turn documents into parsed notes and hand them back.

use vault_core::{ParsedNote, SourceDocument};

/// Parse every document and return the notes in the same order.
///
/// `threads` is clamped to at least one and to at most one per document.
/// With one thread (or one document) this is a plain loop on the caller's
/// thread, so a tiny refresh pays nothing for the pool.
pub(crate) fn parse_in_order(documents: Vec<SourceDocument>, threads: usize) -> Vec<ParsedNote> {
    parse_in_order_with(documents, threads, vault_core::parse_note)
}

fn parse_in_order_with<F>(
    documents: Vec<SourceDocument>,
    threads: usize,
    parse: F,
) -> Vec<ParsedNote>
where
    F: Fn(SourceDocument) -> ParsedNote + Sync,
{
    let threads = threads.clamp(1, documents.len().max(1));
    if threads == 1 {
        return documents.into_iter().map(parse).collect();
    }

    // Each slot is taken by exactly one worker (the shared counter hands out
    // every index once), so the per-slot mutexes never contend; they only make
    // moving a document out and a note in safe without `unsafe`. Workers pull
    // the next index rather than owning a fixed chunk, so one multi-megabyte
    // note does not leave the other workers idle behind it.
    let inputs: Vec<std::sync::Mutex<Option<SourceDocument>>> = documents
        .into_iter()
        .map(|document| std::sync::Mutex::new(Some(document)))
        .collect();
    let outputs: Vec<std::sync::Mutex<Option<ParsedNote>>> =
        inputs.iter().map(|_| std::sync::Mutex::new(None)).collect();
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(input) = inputs.get(index) else {
                        break;
                    };
                    let document = take(input).expect("each slot is taken once");
                    let note = parse(document);
                    *lock(&outputs[index]) = Some(note);
                }
            });
        }
    });
    outputs
        .into_iter()
        .map(|slot| {
            slot.into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .expect("every slot was parsed")
        })
        .collect()
}

fn lock<T>(slot: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    slot.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn take(slot: &std::sync::Mutex<Option<SourceDocument>>) -> Option<SourceDocument> {
    lock(slot).take()
}

/// How many parse workers a complete refresh uses: the machine's parallelism,
/// capped so a cold index of a vault full of multi-megabyte notes does not
/// hold one large syntax tree per core at once.
pub(crate) fn parse_threads() -> usize {
    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1)
        .min(MAX_PARSE_THREADS)
}

const MAX_PARSE_THREADS: usize = 8;

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::VaultPath;

    fn documents(count: usize) -> Vec<SourceDocument> {
        (0..count)
            .map(|index| {
                let body = format!(
                    "---\ntitle: n{index}\n---\n# Note {index}\n\n- item [[Note {}]]\n{}\n",
                    index + 1,
                    "text ".repeat(index % 50)
                );
                SourceDocument::new(
                    VaultPath::new(format!("n{index:04}.md")).expect("path"),
                    body,
                )
            })
            .collect()
    }

    #[test]
    fn parallel_parse_matches_the_serial_parse_in_order() {
        let docs = documents(203);
        let serial: Vec<ParsedNote> = docs.iter().cloned().map(vault_core::parse_note).collect();
        for threads in [0, 1, 2, 3, 8, 500] {
            assert_eq!(
                parse_in_order(docs.clone(), threads),
                serial,
                "threads = {threads}"
            );
        }
    }

    #[test]
    fn parallel_parse_uses_more_than_one_thread_when_asked() {
        let seen = std::sync::Mutex::new(std::collections::BTreeSet::new());
        let docs = documents(64);
        let notes = parse_in_order_with(docs, 4, |doc| {
            seen.lock()
                .expect("probe")
                .insert(format!("{:?}", std::thread::current().id()));
            // Long enough that every worker is running before the queue
            // drains, so the assertion does not depend on scheduling luck.
            std::thread::sleep(std::time::Duration::from_millis(5));
            vault_core::parse_note(doc)
        });
        assert_eq!(notes.len(), 64);
        assert!(seen.lock().expect("probe").len() > 1);
    }

    #[test]
    fn empty_input_yields_empty_output() {
        assert!(parse_in_order(Vec::new(), 4).is_empty());
    }
}
