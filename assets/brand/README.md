# Raven logo assets

The right-facing indigo raven keeps its faceted eye, parted hooked beak, violet feathers, and mint/cyan accents. Restored rear feathers and a folded wing root enter the lower-left frame naturally. Quill pennants form the independent lavender background.

## Asset roles

| Surface | Asset | Treatment |
| --- | --- | --- |
| README header | `assets/brand/icon-rounded.png` | Selected presentation at 128 px |
| Both sidebar states / login | `packages/dashboard/public/logo-{24,80}.png` | Transparent artwork without additional masks |
| Browser | `packages/dashboard/src/app/icon.png`, `favicon.ico` | Transparent 32 px PNG and 16/32 px ICO; Next file metadata |
| Apple touch | `packages/dashboard/src/app/apple-icon.png` | Opaque square presentation, 180 px |
| Social | `packages/dashboard/src/app/opengraph-image.png` | Rounded presentation on the existing 1200 × 630 dark canvas |

Root `logo.png` is the canonical 2048 × 2048 transparent master. `icon.png` and `icon-rounded.png` in this directory are separate square and rounded presentations. Small app/browser marks use the foreground without external glow, extra backgrounds, filters, or circular masks. Independent user/provider identities remain separate.

## Reproduce and verify

```sh
uv run --with pillow python scripts/resize-logos.py
```

One Azure gpt-image-2 request produced native 2048 × 2048 artwork. Selected study/pass: `2026-09-07-04 / 02`. The protected face features and complete accessories have at least 148.5 native pixels of clearance from the actual 23% rounded outline; intentional lower shoulder/wing entries are measured separately. Source-colored continuation layers are archived behind the inset foreground where needed, with opaque accepted pixels preserved. The UI theme remains separate from the artwork palette.

[source.json](source.json) records the exact master hashes. Untouched generation, exact prompt, references, sampled palette, extraction, all ten export sizes, and frozen finishing layers are preserved in the [Hexly archive](https://github.com/nocoo/hexly.ai/tree/main/artwork/logo-family/raven/2026-09-07-04).

- [Individual before/after review](https://hexly.ai/logos/raven)
- [Local static review](https://index.dev.hexly.ai/artwork/logo-family/raven/2026-09-07-04/review.html)
- [Shared logo usage SOP](https://github.com/nocoo/hexly.ai/blob/main/docs/07-logo-usage-sop.md)

Regenerate PNG and ICO consumers from these selected masters. Verify every ICO resolution and actual small marks on both themes, including both sidebar states.
