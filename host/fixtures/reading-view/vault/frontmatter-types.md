---
string: a plain string
quoted: "a: quoted string"
number: 42
decimal: 3.14
bool-true: true
bool-false: false
date: 2026-01-15
datetime: 2026-01-15T10:30:00
list:
  - one
  - two
  - three
inline-list: [alpha, beta]
nested:
  child: value
  deeper:
    leaf: 1
link: "[[Link Target]]"
link-alias: "[[Link Target|an alias]]"
link-list:
  - "[[Link Target]]"
  - "[[Target With Headings]]"
external: https://example.com
empty:
null-value: null
tags: [fixture-type-tag]
aliases: [Frontmatter Types Alias]
cssclasses: [fixture-cssclass]
show-properties: true
---

Body text under the frontmatter. The note sets `show-properties`, which the reading view reads as a note-level switch for the properties block.
