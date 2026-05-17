# `vyuh-dxkit to-xlsx`

> **Run as:** `vyuh-dxkit <cmd>` after `npm install -g @vyuhlabs/dxkit`,
> or `npx @vyuhlabs/dxkit <cmd>` for one-shot use. Examples on this
> page use the short form.

Convert a `licenses` or `bom` detailed JSON report into the standard
15-column BOM XLSX template.

## Usage

```bash
vyuh-dxkit to-xlsx <path-to-json>
```

The input must be one of:

- `licenses-<date>-detailed.json` — license inventory
- `bom-<date>-detailed.json` — full Bill of Materials

The XLSX is written next to the JSON (same directory, same basename
with `.xlsx`).

## Example

```bash
vyuh-dxkit bom --detailed
vyuh-dxkit to-xlsx .dxkit/reports/bom-2026-05-14-detailed.json
# → .dxkit/reports/bom-2026-05-14-detailed.xlsx
```

You could also pass `--xlsx` directly to `bom` or `licenses` and get
the same output in one step:

```bash
vyuh-dxkit bom --detailed --xlsx
```

`to-xlsx` is the standalone path for converting an existing JSON
report (e.g. one a teammate emailed you) without re-running the
analyzer.

## Template details

The XLSX uses the canonical 15-column BoM template that's standard
across customer security audits. Column headers and ordering are
preserved exactly (including any double-space / trailing-space quirks
the template specifies).

## See also

- [`bom`](bom.md) — generate the JSON in the first place
- [`licenses`](licenses.md) — license-only inventory
