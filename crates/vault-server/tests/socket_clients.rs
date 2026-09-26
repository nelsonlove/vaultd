//! Two clients on one daemon. The socket's whole point: the connections are
//! independent, and what one does with its own subscription is not visible in
//! the other's stream except as the same generations in the same order.

mod socket;

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
