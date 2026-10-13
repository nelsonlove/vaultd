# Third-party notices

vaultd itself is MIT-licensed (see `LICENSE`). The golden test fixtures under `host/fixtures/golden/*/plugin/` contain release builds of Obsidian community plugins, copied unchanged and used only as test inputs for the headless plugin host. Each bundle keeps its own licence, and the full licence text sits next to it as `plugin/LICENSE`. Versions marked `-nl.N` are builds from a fork that carries small patches on top of the named upstream release; the fork's source for that exact tag is public at the URL given.

| Fixture | Plugin | Version | Source | Licence | Copyright |
| --- | --- | --- | --- | --- | --- |
| `automatic-linker` | Automatic Linker | 4.9.0 | https://github.com/kdnk/obsidian-automatic-linker (tag `4.9.0`) | Apache-2.0 | Kodai Nakamura (the upstream LICENSE carries no filled-in copyright line) |
| `find-replace` | Find & Replace | 0.1.0 | https://github.com/nelsonlove/obsidian-find-replace | MIT | Copyright (c) 2026 Nelson Love |
| `folder-notes` | Folder notes | 1.8.26-nl.5 | https://github.com/nelsonlove/obsidian-folder-notes (tag `v1.8.26-nl.5`), fork of https://github.com/LostPaul/obsidian-folder-notes | AGPL-3.0 | Lost Paul and contributors (the upstream LICENSE carries no project copyright line) |
| `nested-properties` | Nested Properties | 1.6.0 | https://github.com/mnaoumov/obsidian-nested-properties (tag `1.6.0`) | MIT | Copyright (c) 2026 Michael Naumov |
| `obsidian-linter` | Linter | 1.32.1-nl.1 | https://github.com/nelsonlove/obsidian-linter (tag `v1.32.1-nl.1`), fork of https://github.com/platers/obsidian-linter | MIT | Copyright (c) 2021-2022 Victor Tao |
| `obsidian-rollover-daily-todos` | Rollover Daily Todos | 1.2.0 | https://github.com/lumoe/obsidian-rollover-daily-todos (tag `1.2.0`) | MIT | Copyright (c) 2022 Lukas Mölschl |
| `quickadd` | QuickAdd | 2.24.2 | https://github.com/chhoumann/quickadd (tag `2.24.2`) | MIT | Copyright (c) 2021 Christian Bager Bach Houmann |
| `tag-wrangler` | Tag Wrangler | 0.6.5-nl.2 | https://github.com/nelsonlove/obsidian-tag-wrangler (tag `v0.6.5-nl.2`), fork of https://github.com/pjeby/tag-wrangler | ISC | Copyright 2021 PJ Eby |

## Other third-party data

- `host/fixtures/golden/obsidian-linter/plugin/default-misspellings.md` is the Linter plugin's default misspellings list. Its entries come from the codespell dictionary (https://github.com/codespell-project/codespell), which the codespell project releases under CC BY-SA 3.0 as a derivative work of English Wikipedia. See `default-misspellings.NOTICE` beside it.

## Copyleft note

The `folder-notes` bundle is AGPL-3.0. It is shipped as a separate test input, not linked into vaultd, and its complete corresponding source is the public tag named above.
