//! Two clients on one daemon. The socket's whole point: the connections are
//! independent, and what one does with its own subscription is not visible in
//! the other's stream except as the same generations in the same order.

mod socket;

use std::time::{Duration, Instant};

use socket::ListeningDaemon;
use tempfile::TempDir;
use vault_protocol::{Response, ResponseOutcome, RuntimeEventDto};

fn vault_with_one_note() -> (TempDir, TempDir, TempDir) {
    let vault = TempDir::new().expect("vault tempdir");
    let index = TempDir::new().expect("index tempdir");
    let run = TempDir::new().expect("run tempdir");
    std::fs::write(vault.path().join("One.md"), "# One\n").expect("write One");
    (vault, index, run)
}

#[test]
fn two_clients_see_the_same_generation_each_under_its_own_subscription_id() {
    let (vault, index, run) = vault_with_one_note();
    let daemon = ListeningDaemon::start(&vault, &index, &run);
    let mut first = daemon.connect();
    let mut second = daemon.connect();

    first.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let first_id = subscription_id(&mut first, "s1");
    let second_id = subscription_id(&mut second, "s2");
    assert_eq!(
        first_id, second_id,
        "identifiers are per connection, so two connections may each hold sub-1"
    );

    // One client mutates; both must see the generation it produced.
    // `r##` rather than `r#`: the note bodies contain `"#`, which would end a
    // single-hash raw string in the middle of the request line.
    let written = first.call(
        r##"{"version":1,"id":"w","request":{"method":"write_note","params":{"path":"Two.md","content":"# Two\n","expected":{"absent":true}}}}"##,
    );
    let generation = match written.outcome {
        ResponseOutcome::Ok(Response::WriteNote(response)) => response.generation,
        other => panic!("the write did not land: {other:?}"),
    };

    for (label, client, id) in [
        ("the writer", &mut first, first_id.as_str()),
        ("the observer", &mut second, second_id.as_str()),
    ] {
        let event = client.wait_for_event(|envelope| {
            matches!(&envelope.event, RuntimeEventDto::GenerationCommitted(committed) if committed.generation == generation)
        });
        // The fan-out reaching only one connection is what this catches: the
        // other `wait_for_event` would hang and panic at its bound. The id
        // check below is the weaker half — both ids are the same string, so
        // it pins the string and not the attribution; the attribution is
        // proven at the end, where the unsubscribed client must hear nothing.
        assert_eq!(
            event.subscription_id, id,
            "{label} sees the generation under its own subscription id"
        );
    }

    // Unsubscribing one leaves the other serving.
    second.call(&format!(
        r#"{{"version":1,"id":"u","request":{{"method":"unsubscribe","params":{{"subscription_id":"{second_id}"}}}}}}"#
    ));
    let after = first.call(
        r##"{"version":1,"id":"w2","request":{"method":"write_note","params":{"path":"Three.md","content":"# Three\n","expected":{"absent":true}}}}"##,
    );
    let later = match after.outcome {
        ResponseOutcome::Ok(Response::WriteNote(response)) => response.generation,
        other => panic!("the second write did not land: {other:?}"),
    };
    let event = first.wait_for_event(|envelope| {
        matches!(&envelope.event, RuntimeEventDto::GenerationCommitted(committed) if committed.generation == later)
    });
    assert_eq!(event.subscription_id, first_id);

    // And the other half, which is what actually proves the events are
    // attributed per connection: the client that unsubscribed must hear
    // nothing about that generation. `first` has already received it, so the
    // fan-out has run and this is not a race against a slow daemon.
    assert!(
        second
            .try_wait_for_event(
                |envelope| matches!(
                    &envelope.event,
                    RuntimeEventDto::GenerationCommitted(committed) if committed.generation == later
                ),
                Duration::from_secs(1),
            )
            .is_none(),
        "unsubscribing must stop this connection's events and nobody else's — \
         an event arriving here means the registries are shared or the \
         unsubscribe reached the wrong one"
    );
}

fn subscription_id(client: &mut socket::Client, request_id: &str) -> String {
    let response = client.call(&format!(
        r#"{{"version":1,"id":"{request_id}","request":{{"method":"subscribe_events","params":{{}}}}}}"#
    ));
    match response.outcome {
        ResponseOutcome::Ok(Response::SubscribeEvents(subscribed)) => subscribed.subscription_id,
        other => panic!("subscribe_events was refused: {other:?}"),
    }
}

/// The kernel receive buffer a stalled client in this file runs with.
///
/// The socket buffers sit in front of the daemon's own queues, and their
/// default size is the host's business rather than this test's. Set to a
/// kilobyte — four or five event lines at the size this vault produces — the
/// depth of the road between the fan-out and the client is the daemon's three
/// published queue depths plus a rounding error, which is what lets
/// [`CHAIN_DEPTH`] below be arithmetic instead of a margin measured once on
/// one machine. `socket_lifecycle`'s wedge test shrinks it to the same value
/// for the same reason.
const STALLED_RECEIVE_BUFFER: libc::c_int = 1024;

/// What the shrunk socket buffer and the harness's own `BufReader` can hold
/// between them, in event lines, generously rounded up.
///
/// A kilobyte of receive buffer is about four lines; the harness's
/// `BufReader` fills 8 KiB at a time, so a reader parked mid-buffer can have
/// taken about thirty-three more off the socket. Sixty-four covers both with
/// room to spare, and it is the one term in [`CHAIN_DEPTH`] that is an
/// allowance rather than a published number — so it is named, and a host that
/// exceeds it fails the self-check in
/// [`a_client_that_stops_reading_stalls_only_itself_and_is_told_when_it_returns`]
/// with the count printed rather than failing obscurely.
const SOCKET_BUFFER_ALLOWANCE: usize = 64;

/// How many notices the road between the fan-out and a stalled client's own
/// reader can hold, computed from the daemon's published depths rather than
/// measured.
///
/// Three 256-deep queues in series — the connection's notice inbox
/// ([`vault_server::broadcast::CONNECTION_NOTICE_CAPACITY`]), the
/// dispatcher's input mailbox ([`vault_server::connection::INPUT_CAPACITY`])
/// and its output queue ([`vault_server::connection::OUTPUT_CAPACITY`]) —
/// plus [`SOCKET_BUFFER_ALLOWANCE`] for the buffers in front of them. Past
/// this the fan-out's non-blocking send has nowhere to put a notice, which is
/// the only way a gap is ever latched.
const CHAIN_DEPTH: usize = vault_server::broadcast::CONNECTION_NOTICE_CAPACITY
    + vault_server::connection::INPUT_CAPACITY
    + vault_server::connection::OUTPUT_CAPACITY
    + SOCKET_BUFFER_ALLOWANCE;

/// How many generations are committed while a client is stalled: one whole
/// allowance past the end of the road, so at least
/// [`SOCKET_BUFFER_ALLOWANCE`] notices must be dropped rather than merely
/// buffered.
const STALL_WRITES: usize = CHAIN_DEPTH + SOCKET_BUFFER_ALLOWANCE;

/// How many `get_note` round trips one side of the isolation measurement
/// takes. Enough that a median is a median and not a coin toss, few enough
/// that the two measurements together cost well under a second.
const ISOLATION_SAMPLES: usize = 201;

/// How much slower the peer's median round trip may be while its neighbour is
/// stalled.
///
/// **The spec's 10 percent stands, and it is not this test's to enforce.**
/// `docs/design/vaultd-socket-transport.md` requires a second client's
/// `get_note` p50 to stay within 10 percent of its single-client value, and
/// that measurement belongs to the baseline harness Task 9 adds — a release
/// build, a warmed vault, and its own `--transport socket|stdio` switch.
/// Nothing here amends it.
///
/// This constant is a *flake guard* on a debug build inside a parallel test
/// run, and it is a doubling for a reason the measurement shows. Measured on
/// this machine over three runs, 201 samples per side, the ratio was
/// **1.149, 1.113 and 1.132** — a p50 of about 384 µs alone against about
/// 435 µs with the neighbour stalled. A warm `get_note` over this socket is
/// tens of microseconds, so the median is a handful of scheduler slices, and
/// the spec's 10 percent would have failed all three runs: a gate that tight
/// on a quantity that small measures the machine's mood, not the daemon's
/// queues. What the defect would actually look like is not a few percent: a
/// shared queue, a shared writer, or a fan-out that blocks on a full inbox
/// makes the peer wait on the stalled client's socket, which is unbounded —
/// hundreds of times the baseline, or a hang. Measured too: with the fan-out
/// made blocking, this case fails by timeout rather than by percentages. A
/// doubling separates those two worlds with room to spare and does not flake.
const ISOLATION_TOLERANCE: u32 = 2;

/// The median of [`ISOLATION_SAMPLES`] `get_note` round trips, which is the
/// quantity the spec's slow-client requirement names ("a second client's
/// `get_note` p50 is within 10 percent of its single-client value").
fn get_note_p50(client: &mut socket::Client, tag: &str) -> Duration {
    let mut samples = Vec::with_capacity(ISOLATION_SAMPLES);
    for at in 0..ISOLATION_SAMPLES {
        let started = Instant::now();
        let response = client.call(&format!(
            r#"{{"version":1,"id":"{tag}{at}","request":{{"method":"get_note","params":{{"path":"One.md"}}}}}}"#
        ));
        samples.push(started.elapsed());
        assert!(
            matches!(response.outcome, ResponseOutcome::Ok(Response::GetNote(_))),
            "the measured request must be the one being measured: {:?}",
            response.outcome
        );
    }
    samples.sort_unstable();
    samples[samples.len() / 2]
}

/// A client that stops reading must cost its peer nothing, and must be told
/// its view is stale when it comes back.
///
/// **What actually backs up, in order.** The stalled peer's kernel receive
/// buffer fills; then its writer thread blocks; then its dispatcher's output
/// queue fills; then its own notice inbox fills; and at that point the
/// broadcaster's non-blocking send to that connection starts failing, drops
/// the notice and latches the gap. Nothing in that chain is shared with the
/// other connection, which is the property being asserted.
///
/// **The gap is announced on the next notice, never on its own.** The latch
/// is a debt the fan-out pays the first time it has a notice to carry the
/// marker on, so one more generation is committed after the stalled client
/// starts reading again — and that generation is the one the marker names,
/// because a client told to re-read is told to re-read at the newest.
#[test]
fn a_client_that_stops_reading_stalls_only_itself_and_is_told_when_it_returns() {
    let (vault, index, run) = vault_with_one_note();
    let daemon = ListeningDaemon::start(&vault, &index, &run);
    // The one client that stalls runs with a kilobyte of receive buffer, so
    // the road behind it is [`CHAIN_DEPTH`] deep by arithmetic rather than by
    // whatever this host's socket defaults happen to be.
    let mut slow = daemon.connect_with_receive_buffer(STALLED_RECEIVE_BUFFER);
    let mut fast = daemon.connect();

    slow.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let slow_id = subscription_id(&mut slow, "s1");
    let fast_id = subscription_id(&mut fast, "s2");

    // The peer's round trip with nobody stalled. Taken before the stall and
    // on a warm index, so the only difference between this and the second
    // measurement is the state of the other connection.
    let alone = get_note_p50(&mut fast, "b");

    // The slow client goes silent: still connected, no longer reading.
    let parked = slow.stop_reading();

    // Enough generations to fill every queue on the slow connection's road
    // and then overrun it — the count is [`CHAIN_DEPTH`] plus an allowance,
    // computed from the daemon's own published depths rather than measured
    // here once and trusted everywhere.
    let writes = STALL_WRITES;
    let mut bulk_newest = 0;
    for at in 0..writes {
        // `r##`, like the two-client case above: the note bodies contain
        // `"#`, which ends a single-hash raw string in the middle of the line.
        let response = fast.call(&format!(
            r##"{{"version":1,"id":"w{at}","request":{{"method":"write_note","params":{{"path":"Bulk-{at}.md","content":"# Bulk {at}\n","expected":{{"absent":true}}}}}}}}"##
        ));
        bulk_newest = match response.outcome {
            ResponseOutcome::Ok(Response::WriteNote(written)) => written.generation,
            other => panic!("write {at} did not land: {other:?}"),
        };
    }

    // The fast client kept working throughout — that is the isolation claim,
    // and this is the assertion of it that does not depend on a clock.
    let event = fast.wait_for_event(|envelope| {
        matches!(&envelope.event, RuntimeEventDto::GenerationCommitted(committed) if committed.generation == bulk_newest)
    });
    assert_eq!(event.subscription_id, fast_id);
    assert_eq!(
        fast.call(r#"{"version":1,"id":"h","request":{"method":"health"}}"#)
            .id,
        "h",
        "and it is still answering requests while its peer is stalled"
    );

    // Clear what the bulk left in the peer's own stream, so the second
    // measurement times `get_note` and not the tail of the fan-out.
    fast.drain_events();
    let stalled = get_note_p50(&mut fast, "s");
    assert!(
        stalled <= alone * ISOLATION_TOLERANCE,
        "the peer's get_note p50 was {stalled:?} with a stalled neighbour \
         against {alone:?} alone: a client that stops reading must cost its \
         peer nothing, so a difference on this scale is a queue, a writer or \
         a fan-out shared between the two connections"
    );

    // The slow client returns. Somewhere in what it reads is the resync that
    // names the newest generation; it need not be the first line, because
    // everything already buffered ahead of the gap is still owed to it.
    let mut caught_up = slow.resume_reading(parked);

    // The stall was real, said without a clock and against a number this
    // test computed rather than measured: the road holds [`CHAIN_DEPTH`]
    // notices, so a client handed more than that was never stalled, and one
    // handed every generation was never behind — a `runtime_recovered` in
    // that transcript would have to have come from something other than a
    // drop.
    assert!(
        caught_up.len() <= CHAIN_DEPTH,
        "the stalled client was handed {} lines for {writes} generations, but \
         the road behind it is only {CHAIN_DEPTH} deep by arithmetic \
         ({} + {} + {} queued, plus {SOCKET_BUFFER_ALLOWANCE} of socket and \
         reader buffer): this host buffers more than SOCKET_BUFFER_ALLOWANCE \
         allows for, so raise it and raise STALL_WRITES with it",
        caught_up.len(),
        vault_server::broadcast::CONNECTION_NOTICE_CAPACITY,
        vault_server::connection::INPUT_CAPACITY,
        vault_server::connection::OUTPUT_CAPACITY,
    );

    // One more generation, which is what carries the marker: the debt was
    // latched with no notice left to announce it on, and this is the next
    // one. It is also the newest, which is what the marker must name.
    let newest = match fast
        .call(
            r##"{"version":1,"id":"wc","request":{"method":"write_note","params":{"path":"Carrier.md","content":"# Carrier\n","expected":{"absent":true}}}}"##,
        )
        .outcome
    {
        ResponseOutcome::Ok(Response::WriteNote(written)) => written.generation,
        other => panic!("the carrier write did not land: {other:?}"),
    };
    caught_up.extend(slow.drain_events());

    let announced = caught_up.iter().any(|line| {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => return false,
        };
        value
            .pointer("/event/value/reason")
            .and_then(serde_json::Value::as_str)
            == Some("runtime_recovered")
            && value
                .pointer("/event/value/current_generation")
                .and_then(serde_json::Value::as_u64)
                == Some(newest)
    });
    assert!(
        announced,
        "the stalled client is told to re-read at generation {newest}; it saw \
         {} lines, the last of them:\n{}",
        caught_up.len(),
        caught_up
            .iter()
            .rev()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert!(
        caught_up
            .iter()
            .all(|line| !line.contains("\"subscription_id\"") || line.contains(&slow_id)),
        "and every event it sees is its own subscription's"
    );
}

/// How many generations this case commits through a stalled connection:
/// comfortably past [`vault_server::subscriptions::SUBSCRIBER_CAPACITY`] and
/// comfortably short of [`CHAIN_DEPTH`], so the per-subscription queue is the
/// only bound in reach — and it must not be reached.
const PAST_THE_SUBSCRIPTION_BOUND: usize = vault_server::subscriptions::SUBSCRIBER_CAPACITY * 4;

/// The per-subscription bound is the registry's, and this transport never
/// approaches it: a stalled client's detail is **not** collapsed at 64.
///
/// **Which marker, and why this is the honest claim about that queue.** The
/// dispatcher drains every queued event immediately after each
/// `enqueue_notice` (`subscriptions.rs`, and its module doc says so in
/// terms), so a subscription queue holds at most one notice's worth of
/// events and `SUBSCRIBER_CAPACITY` is unreachable through any transport's
/// dispatcher — `docs/protocol.md` states it as "Not reachable through the
/// stdio dispatcher", and the socket inherits it unchanged because the
/// registry is per connection either way. A socket client that stops reading
/// therefore **never** produces `subscriber_lag`: it backs the output queue
/// up, and the loss is latched at the fan-out and announced as
/// `runtime_recovered`, which the case above pins.
///
/// So the daemon's own answer about the per-subscription queue is what this
/// asserts, and every number in it is the daemon's rather than this test's
/// loop: through a connection that is not draining, over four times the
/// bound in generations, the detail keeps coming — more events than the
/// bound, one per generation — and no `subscriber_lag` marker is ever
/// written. A registry that collapsed at its bound would hand back at most
/// 64 events and a marker, which is exactly what the assertions below refuse.
///
/// **Where the bound's *value* is pinned**, since it cannot be here:
/// `tests/subscriptions.rs::a_subscriber_queue_collapses_at_exactly_its_documented_bound`
/// drives the registry directly and pins the threshold, and
/// `tests/docs.rs::the_documented_per_subscription_bound_matches_the_constant`
/// ties the number 64 to the two documents that publish it.
#[test]
fn a_stalled_connection_is_not_collapsed_at_its_subscription_bound() {
    let (vault, index, run) = vault_with_one_note();
    let daemon = ListeningDaemon::start(&vault, &index, &run);
    let mut slow = daemon.connect_with_receive_buffer(STALLED_RECEIVE_BUFFER);
    let mut fast = daemon.connect();
    slow.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);
    let slow_id = subscription_id(&mut slow, "s1");
    let parked = slow.stop_reading();
    for at in 0..PAST_THE_SUBSCRIPTION_BOUND {
        fast.call(&format!(
            r##"{{"version":1,"id":"w{at}","request":{{"method":"write_note","params":{{"path":"Q-{at}.md","content":"# Q\n","expected":{{"absent":true}}}}}}}}"##
        ));
    }
    let caught_up = slow.resume_reading(parked);

    let bound = vault_server::subscriptions::SUBSCRIBER_CAPACITY;
    let detail = caught_up
        .iter()
        .filter(|line| line.contains(r#""type":"generation_committed""#))
        .count();
    assert!(
        caught_up
            .iter()
            .all(|line| !line.contains("\"subscription_id\"") || line.contains(&slow_id)),
        "every event is this subscription's"
    );
    assert!(
        !caught_up.iter().any(|line| line.contains("subscriber_lag")),
        "a subscription queue on this transport never fills, because the \
         dispatcher drains it after every notice — a `subscriber_lag` here \
         means the dispatcher stopped draining to completion, and a client \
         that stopped reading has lost detail it was never told it lost; it \
         saw:\n{}",
        caught_up.join("\n")
    );
    assert!(
        detail > bound,
        "the stalled client was handed {detail} generation_committed events \
         for {PAST_THE_SUBSCRIPTION_BOUND} generations, which is no more than \
         the per-subscription bound of {bound}: its detail was collapsed at \
         that queue, which on this transport must never happen"
    );
    assert_eq!(
        detail, PAST_THE_SUBSCRIPTION_BOUND,
        "and in fact nothing was lost at all — {PAST_THE_SUBSCRIPTION_BOUND} \
         generations fit inside the {CHAIN_DEPTH}-deep road, so this case \
         says what it means to say and nothing else"
    );
}

/// The daemon's whole allowance of concurrent snapshot sessions, which is
/// what makes "the connection's sessions were closed" observable from
/// outside the process: exhaust it on one connection, close that connection,
/// and a successor can only open a session if the allowance came back.
///
/// Read from the very configuration the daemon under test is built with —
/// the same vault root and the same explicit index path the harness passes
/// on its command line — rather than copied as a literal, so a change to the
/// default fails nothing and drifts nowhere.
fn max_concurrent_snapshots(vault: &TempDir, index: &TempDir) -> usize {
    vault_index::IndexConfig::explicit(vault.path(), index.path().join("index.sqlite3"))
        .expect("the daemon's own index configuration")
        .max_concurrent_snapshots
}

/// Sessions are connection-scoped. One connection's snapshot identifier means
/// nothing on another, and closing a connection closes what it held.
///
/// This is the **end-to-end** pin on the wiring between `serve` and `handle`
/// that Task 4 unit-tested from the inside: the `snapshot_id → ConnectionId`
/// map, and `Server::close_sessions_of` running when a connection ends. If
/// this fails while Task 4's `session_ownership` tests pass, the defect is in
/// the wiring, not in the ownership rule.
///
/// **Why the allowance and not the identifier.** Identifiers come from one
/// process-wide counter on the snapshot registry, not from a per-connection
/// one, so a successor's first session is never `snap-1` and the identifier
/// says nothing about whether anything was closed. What does say it is the
/// allowance: the registry holds at most [`max_concurrent_snapshots`]
/// sessions at once and refuses the next with
/// `too_many_snapshots`, and nothing in this test is idle long enough for the
/// idle sweep to close anything. So the owner takes the whole allowance, and
/// the successor's `open_snapshot` can only be answered if closing the
/// owner's connection gave it back.
#[test]
fn a_snapshot_session_belongs_to_the_connection_that_opened_it() {
    let (vault, index, run) = vault_with_one_note();
    let daemon = ListeningDaemon::start(&vault, &index, &run);
    let mut owner = daemon.connect();
    let mut stranger = daemon.connect();
    owner.call(r#"{"version":1,"id":"r","request":{"method":"refresh_index","params":{}}}"#);

    // The whole allowance, on one connection.
    let allowance = max_concurrent_snapshots(&vault, &index);
    let mut held = Vec::new();
    for at in 0..allowance {
        let opened = owner.call(&format!(
            r#"{{"version":1,"id":"o{at}","request":{{"method":"open_snapshot","params":{{}}}}}}"#
        ));
        match opened.outcome {
            ResponseOutcome::Ok(Response::OpenSnapshot(session)) => held.push(session.snapshot_id),
            other => panic!("open_snapshot {at} was refused: {other:?}"),
        }
    }
    let snapshot = held.first().expect("the owner holds a session").clone();

    let refused = stranger.call(&format!(
        r#"{{"version":1,"id":"p","request":{{"method":"snapshot_tree","params":{{"snapshot_id":"{snapshot}","limit":10}}}}}}"#
    ));
    match refused.outcome {
        ResponseOutcome::Err(error) => assert_eq!(
            error.code,
            vault_protocol::ErrorCode::SnapshotNotFound,
            "a session another connection opened is not this connection's to page"
        ),
        other => panic!("a stranger paged someone else's session: {other:?}"),
    }

    // And the allowance really is spent while the owner holds it, so the
    // assertion after the disconnect is about the close and not about a
    // limit that was never reached.
    let over = stranger
        .call(r#"{"version":1,"id":"over","request":{"method":"open_snapshot","params":{}}}"#);
    match over.outcome {
        ResponseOutcome::Err(error) => assert_eq!(
            error.code,
            vault_protocol::ErrorCode::TooManySnapshots,
            "the allowance is one registry's, shared by every connection"
        ),
        other => panic!("the allowance was not spent: {other:?}"),
    }

    // Closing the owner's connection closes every session it held, which the
    // successor proves by being able to open one at all.
    //
    // Polled, not slept on: the close happens on the daemon's own thread
    // after the peer goes away, so the successor may ask before it has
    // landed. A build that never closes them spends the bound and then
    // fails, which is the failure this case exists to produce.
    owner.disconnect();
    let mut successor = daemon.connect();
    let deadline = Instant::now() + Duration::from_secs(10);
    let reopened = loop {
        let answer = successor
            .call(r#"{"version":1,"id":"o2","request":{"method":"open_snapshot","params":{}}}"#);
        match answer.outcome {
            ResponseOutcome::Ok(Response::OpenSnapshot(session)) => break session,
            ResponseOutcome::Err(error)
                if error.code == vault_protocol::ErrorCode::TooManySnapshots
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            other => panic!(
                "the successor could not open a session, so the owner's were \
                 never closed with its connection: {other:?}"
            ),
        }
    };
    assert!(
        !held.contains(&reopened.snapshot_id),
        "identifiers come from one monotonic counter and are never reused"
    );
}
