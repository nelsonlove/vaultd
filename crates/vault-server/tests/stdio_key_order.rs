//! `PatchValueDto::Mapping` exists precisely so a frontmatter patch's nested
//! keys survive in the order a client wrote them. This pins that guarantee
//! through the actual stdio decode path — `RawRequestEnvelope` followed by
//! the request-method decode — not just `serde_json::from_str::<Request>`
//! directly, because a `serde_json::Value` hop in between silently
//! alphabetizes every JSON object (`serde_json::Map` is a `BTreeMap` in this
//! build; `preserve_order` is not enabled).

use vault_protocol::{PatchValueDto, Request};
use vault_server::stdio::RawRequestEnvelope;

#[test]
fn a_nested_mapping_patch_keeps_its_key_order_through_the_real_decode_path() {
    let line = r##"{"version":1,"id":"p1","request":{"method":"patch_frontmatter","params":{"path":"One.md","patch":[{"key_path":"a","value":{"zebra":1,"apple":2,"mango":3}}],"expected":{}}}}"##;

    let raw: RawRequestEnvelope =
        serde_json::from_str(line).expect("decode the envelope, request left undecoded");
    let request: Request =
        serde_json::from_str(raw.request.get()).expect("decode the method-specific params");

    match request {
        Request::PatchFrontmatter(params) => {
            let value = params.patch[0].value.clone().expect("value is present");
            assert_eq!(
                value,
                PatchValueDto::Mapping(vec![
                    ("zebra".to_string(), PatchValueDto::Integer(1)),
                    ("apple".to_string(), PatchValueDto::Integer(2)),
                    ("mango".to_string(), PatchValueDto::Integer(3)),
                ]),
                "the mapping's key order must survive exactly as written on the wire, \
                 not alphabetized by an intermediate serde_json::Value"
            );
        }
        other => panic!("expected patch_frontmatter, got {other:?}"),
    }
}
