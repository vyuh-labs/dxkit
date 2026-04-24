---
description: Convert a markdown report to PDF
argument-hint: "[file-path or 'all' for all reports]"
---

Convert markdown report(s) to PDF.

## Arguments
- `$ARGUMENTS`
- If empty or "all", convert all reports in `.dxkit/reports/`
- If a file path, convert that specific file

## How to Convert

Try these tools in order (use whichever is available):

1. **md-to-pdf** (Node.js): `npx md-to-pdf <file.md>` — creates `<file.pdf>` alongside it
2. **pandoc**: `pandoc <file.md> -o <file.pdf> --pdf-engine=wkhtmltopdf`
3. **If neither is available**, install md-to-pdf: `npx md-to-pdf <file.md>`

## For "all" reports
```
for f in .dxkit/reports/*.md; do
  npx md-to-pdf "$f"
done
```

## Output
- PDFs are saved alongside the markdown files in `.dxkit/reports/`
- Report which files were converted and their paths
