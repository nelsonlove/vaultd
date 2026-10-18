//! Deal with several changes in events, batching them together.
//!
//! Preferably, changes should be kept to a minimum.
//! Sometimes, it’s needed to change the list of events, because parsing can be
//! messy, and it helps to expose a cleaner interface of events to the compiler
//! and other users.
//! It can also help to merge many adjacent similar events.
//! And, in other cases, it’s needed to parse subcontent: pass some events
//! through another tokenizer and inject the result.

use crate::event::Event;
use alloc::{vec, vec::Vec};

/// Shift `previous` and `next` links according to `jumps`.
///
/// This fixes links in case there are events removed or added between them.
fn shift_links(events: &mut [Event], jumps: &[(usize, usize, usize)]) {
    let mut jump_index = 0;
    let mut index = 0;
    let mut add = 0;
    let mut rm = 0;

    while index < events.len() {
        let rm_curr = rm;

        while jump_index < jumps.len() && jumps[jump_index].0 <= index {
            add = jumps[jump_index].2;
            rm = jumps[jump_index].1;
            jump_index += 1;
        }

        // Ignore items that will be removed.
        if rm > rm_curr {
            index += rm - rm_curr;
        } else {
            if let Some(link) = &events[index].link {
                if let Some(next) = link.next {
                    events[next].link.as_mut().unwrap().previous = Some(index + add - rm);

                    while jump_index < jumps.len() && jumps[jump_index].0 <= next {
                        add = jumps[jump_index].2;
                        rm = jumps[jump_index].1;
                        jump_index += 1;
                    }

                    events[index].link.as_mut().unwrap().next = Some(next + add - rm);
                    index = next;
                    continue;
                }
            }

            index += 1;
        }
    }
}

/// Tracks a bunch of edits.
#[derive(Debug)]
pub struct EditMap {
    /// Record of changes, in call order: place, how many events to remove,
    /// events to add, and whether to add them before earlier additions at
    /// the same place.
    ///
    /// Edits at the same place are merged in `consume`, not here, so that
    /// adding an edit does not scan every pending edit.
    map: Vec<(usize, usize, Vec<Event>, bool)>,
}

impl EditMap {
    /// Create a new edit map.
    pub fn new() -> EditMap {
        EditMap { map: vec![] }
    }
    /// Create an edit: a remove and/or add at a certain place.
    pub fn add(&mut self, index: usize, remove: usize, add: Vec<Event>) {
        add_impl(self, index, remove, add, false);
    }
    /// Create an edit: but insert `add` before existing additions.
    pub fn add_before(&mut self, index: usize, remove: usize, add: Vec<Event>) {
        add_impl(self, index, remove, add, true);
    }
    /// Done, change the events.
    pub fn consume(&mut self, events: &mut Vec<Event>) {
        if self.map.is_empty() {
            return;
        }

        // Stable, so edits at the same place stay in call order.
        self.map.sort_by_key(|edit| edit.0);

        // Merge edits at the same place.
        let mut map: Vec<(usize, usize, Vec<Event>)> = Vec::with_capacity(self.map.len());
        for (at, remove, mut add, before) in self.map.drain(..) {
            match map.last_mut() {
                Some(last) if last.0 == at => {
                    last.1 += remove;

                    if before {
                        add.append(&mut last.2);
                        last.2 = add;
                    } else {
                        last.2.append(&mut add);
                    }
                }
                _ => map.push((at, remove, add)),
            }
        }

        // Calculate jumps: where items in the current list move to.
        let mut jumps = Vec::with_capacity(map.len());
        let mut index = 0;
        let mut add_acc = 0;
        let mut remove_acc = 0;
        while index < map.len() {
            let (at, remove, add) = &map[index];
            remove_acc += remove;
            add_acc += add.len();
            jumps.push((*at, remove_acc, add_acc));
            index += 1;
        }

        shift_links(events, &jumps);

        let len_before = events.len();
        let mut index = map.len();
        let mut vecs = Vec::with_capacity(index * 2 + 1);
        while index > 0 {
            index -= 1;
            vecs.push(events.split_off(map[index].0 + map[index].1));
            vecs.push(map[index].2.split_off(0));
            events.truncate(map[index].0);
        }
        vecs.push(events.split_off(0));

        events.reserve(len_before + add_acc - remove_acc);

        while let Some(mut slice) = vecs.pop() {
            events.append(&mut slice);
        }
    }
}

/// Create an edit.
fn add_impl(edit_map: &mut EditMap, at: usize, remove: usize, add: Vec<Event>, before: bool) {
    if remove == 0 && add.is_empty() {
        return;
    }

    edit_map.map.push((at, remove, add, before));
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use crate::event::{Content, Kind, Link, Name, Point};
    use alloc::{vec, vec::Vec};
    use core::convert::TryFrom;

    /// The `EditMap` of markdown-rs 1.0.0, kept as an oracle: the new one must
    /// change events exactly like this one.
    mod reference {
        use super::super::shift_links;
        use crate::event::Event;
        use alloc::{vec, vec::Vec};

        pub struct EditMap {
            map: Vec<(usize, usize, Vec<Event>)>,
        }

        impl EditMap {
            pub fn new() -> EditMap {
                EditMap { map: vec![] }
            }
            pub fn add(&mut self, index: usize, remove: usize, add: Vec<Event>) {
                add_impl(self, index, remove, add, false);
            }
            pub fn add_before(&mut self, index: usize, remove: usize, add: Vec<Event>) {
                add_impl(self, index, remove, add, true);
            }
            pub fn consume(&mut self, events: &mut Vec<Event>) {
                self.map
                    .sort_unstable_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                if self.map.is_empty() {
                    return;
                }
                let mut jumps = Vec::with_capacity(self.map.len());
                let mut index = 0;
                let mut add_acc = 0;
                let mut remove_acc = 0;
                while index < self.map.len() {
                    let (at, remove, add) = &self.map[index];
                    remove_acc += remove;
                    add_acc += add.len();
                    jumps.push((*at, remove_acc, add_acc));
                    index += 1;
                }
                shift_links(events, &jumps);
                let len_before = events.len();
                let mut index = self.map.len();
                let mut vecs = Vec::with_capacity(index * 2 + 1);
                while index > 0 {
                    index -= 1;
                    vecs.push(events.split_off(self.map[index].0 + self.map[index].1));
                    vecs.push(self.map[index].2.split_off(0));
                    events.truncate(self.map[index].0);
                }
                vecs.push(events.split_off(0));
                events.reserve(len_before + add_acc - remove_acc);
                while let Some(mut slice) = vecs.pop() {
                    events.append(&mut slice);
                }
                self.map.clear();
            }
        }

        fn add_impl(
            edit_map: &mut EditMap,
            at: usize,
            remove: usize,
            mut add: Vec<Event>,
            before: bool,
        ) {
            let mut index = 0;
            if remove == 0 && add.is_empty() {
                return;
            }
            while index < edit_map.map.len() {
                if edit_map.map[index].0 == at {
                    edit_map.map[index].1 += remove;
                    if before {
                        add.append(&mut edit_map.map[index].2);
                        edit_map.map[index].2 = add;
                    } else {
                        edit_map.map[index].2.append(&mut add);
                    }
                    return;
                }
                index += 1;
            }
            edit_map.map.push((at, remove, add));
        }
    }

    /// An event tagged by `tag` (kept in `point.index`), optionally linked.
    fn event(tag: usize, link: Option<(Option<usize>, Option<usize>)>) -> Event {
        Event {
            kind: Kind::Enter,
            name: Name::Data,
            point: Point {
                line: 1,
                column: 1,
                index: tag,
                vs: 0,
            },
            link: link.map(|(previous, next)| Link {
                previous,
                next,
                content: Content::Text,
            }),
        }
    }

    /// An event's tag and its link.
    type Shape = (usize, Option<(Option<usize>, Option<usize>)>);

    /// What identifies an event in these tests: its tag and its link.
    fn shape(events: &[Event]) -> Vec<Shape> {
        events
            .iter()
            .map(|d| {
                (
                    d.point.index,
                    d.link.as_ref().map(|link| (link.previous, link.next)),
                )
            })
            .collect()
    }

    fn plain(count: usize) -> Vec<Event> {
        (0..count).map(|tag| event(tag, None)).collect()
    }

    #[test]
    fn edits_at_the_same_index_merge_in_call_order() {
        let mut events = plain(6);
        let mut map = EditMap::new();
        map.add(2, 1, vec![event(100, None)]);
        map.add(4, 0, vec![event(200, None)]);
        map.add(2, 0, vec![event(101, None)]);
        map.add_before(2, 0, vec![event(99, None)]);
        map.add(2, 1, vec![event(102, None)]);
        map.add_before(4, 1, vec![event(199, None)]);
        // An empty edit is ignored, wherever it is.
        map.add(1, 0, vec![]);
        map.add_before(2, 0, vec![]);
        map.consume(&mut events);

        let tags: Vec<usize> = shape(&events).iter().map(|d| d.0).collect();
        assert_eq!(tags, vec![0, 1, 99, 100, 101, 102, 199, 200, 5]);
    }

    #[test]
    fn edits_added_in_any_order_change_events_like_upstream_1_0_0() {
        // A small deterministic generator (no dev-dependencies).
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move |bound: usize| -> usize {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            usize::try_from(seed % bound as u64).unwrap()
        };

        for round in 0..200 {
            let count = 1 + next(60);
            // Even events form one linked chain; odd events are plain and are
            // the only ones edits remove.
            let mut events = Vec::with_capacity(count);
            let mut index = 0;
            while index < count {
                if index % 2 == 0 {
                    let previous = if index >= 2 { Some(index - 2) } else { None };
                    let next_link = if index + 2 < count {
                        Some(index + 2)
                    } else {
                        None
                    };
                    events.push(event(index, Some((previous, next_link))));
                } else {
                    events.push(event(index, None));
                }
                index += 1;
            }
            let mut expected_events = events.clone();

            let mut map = EditMap::new();
            let mut expected = reference::EditMap::new();
            let mut tag = 1000 * (round + 1);
            let mut removed = vec![false; count];
            for _ in 0..next(40) {
                // Few distinct indices, so many edits share one; and `count`
                // itself (an insert at the end) is allowed.
                let at = next(count / 3 + 2).min(count);
                // Each odd event is removed at most once.
                let remove = usize::from(at % 2 == 1 && at < count && !removed[at] && next(3) == 0);
                if remove == 1 {
                    removed[at] = true;
                }
                let add: Vec<Event> = (0..next(3))
                    .map(|_| {
                        tag += 1;
                        event(tag, None)
                    })
                    .collect();
                if next(2) == 0 {
                    map.add(at, remove, add.clone());
                    expected.add(at, remove, add);
                } else {
                    map.add_before(at, remove, add.clone());
                    expected.add_before(at, remove, add);
                }
            }

            map.consume(&mut events);
            expected.consume(&mut expected_events);
            assert_eq!(shape(&events), shape(&expected_events), "round {}", round);
        }
    }

    #[test]
    fn a_consumed_map_can_be_used_again() {
        let mut map = EditMap::new();
        let mut events = plain(3);
        map.add(1, 1, vec![event(10, None)]);
        map.consume(&mut events);
        map.add(0, 0, vec![event(20, None)]);
        map.consume(&mut events);
        let tags: Vec<usize> = shape(&events).iter().map(|d| d.0).collect();
        assert_eq!(tags, vec![20, 0, 10, 2]);
    }

    #[test]
    fn adding_an_edit_does_not_scan_every_pending_edit() {
        // 1.0.0 scanned every pending edit on each add: n^2 / 2 compares for
        // n edits at distinct indices (5e9 here). This bound is generous for
        // a debug build of an n log n map.
        let count = 100_000;
        let mut events = plain(count);
        let mut map = EditMap::new();
        let start = std::time::Instant::now();
        let mut index = count;
        while index > 0 {
            index -= 1;
            map.add(index, 0, vec![event(count + index, None)]);
        }
        map.consume(&mut events);
        let elapsed = start.elapsed();
        assert_eq!(events.len(), count * 2);
        assert!(elapsed.as_secs() < 3, "{} edits took {:?}", count, elapsed);
    }
}
