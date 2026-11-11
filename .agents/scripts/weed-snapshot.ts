import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const snapshotSchema = z.object({
  target: z.string().min(1),
  wholeVerdict: z.string().min(1),
  runFigures: z.string().min(1),
  pieces: z
    .array(
      z.object({
        range: z.string().min(1),
        lines: z.number().int().positive(),
        what: z.string().min(1),
        failure: z.string().min(1),
        verdict: z.enum(["Keep", "Platform", "Reuse", "Script", "Delete", "Joe's call"]),
        citation: z.string().min(1),
        loss: z.string().min(1),
      }),
    )
    .min(1),
  notAvailable: z.array(z.string().min(1)),
});

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const pieceText = (value: string) =>
  escapeHtml(value).replace(
    /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
const cell = (value: string) =>
  escapeHtml(value)
    .replace(/\|/g, "&#124;")
    .replace(/\r\n|[\r\n]/g, "<br>");

function render(data: z.infer<typeof snapshotSchema>) {
  const colors = ["success", "warning", "info", "chart-4", "destructive", "chart-5"];
  const totals = snapshotSchema.shape.pieces.element.shape.verdict.options.map((verdict, index) => ({
    verdict,
    color: `var(--${colors[index]})`,
    lines: data.pieces.filter((piece) => piece.verdict === verdict).reduce((sum, piece) => sum + piece.lines, 0),
  }));
  const total = totals.reduce((sum, group) => sum + group.lines, 0);
  const bar = totals
    .map((group) => `<span data-lines="${group.lines}" style="flex:${group.lines};background:${group.color}"></span>`)
    .join("");
  const legend = totals
    .map((group) => `<span style="color:${group.color}">${escapeHtml(group.verdict)} · ${group.lines} lines</span>`)
    .join("");
  const cards = data.pieces
    .map(
      (piece, index) => `<article class="piece"><div class="n">${index + 1}</div><div>
<div class="head"><strong>${pieceText(piece.range)}</strong><span>${piece.lines} lines</span></div>
<p>${pieceText(piece.what)}</p><p><b>${escapeHtml(piece.verdict)}</b> · ${pieceText(piece.citation)}</p>
<p class="note">Failure / origin · ${pieceText(piece.failure)}</p><p class="note">What would we lose? ${pieceText(piece.loss)}</p>
</div></article>`,
    )
    .join("\n");
  const landing = data.pieces
    .flatMap((piece, index) =>
      ["Platform", "Reuse", "Script"].includes(piece.verdict)
        ? [
            `<tr><td>Piece ${index + 1}</td><td>${escapeHtml(piece.verdict)}</td><td>${pieceText(piece.citation)}</td></tr>`,
          ]
        : [],
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(data.target)} review</title><style>
:root{--s-ink:var(--foreground,CanvasText);--s-muted:var(--muted-foreground,GrayText);--s-card:var(--card,Canvas);--s-line:var(--border,GrayText);color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;color:var(--s-ink);font:15px/1.5 var(--font-sans,system-ui)}
main{max-width:860px;margin:auto;padding:4px 0 24px;overflow-wrap:anywhere}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
p{white-space:pre-wrap;margin:6px 0}.note,.n,.head span{color:var(--s-muted);font-size:13px}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:12px 0}.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:13px}
.piece{background:var(--s-card);border:1px solid var(--s-line);border-radius:var(--radius,10px);padding:14px 16px;margin:10px 0;display:grid;grid-template-columns:28px minmax(0,1fr);gap:12px}
.head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.n{font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px;background:var(--s-card)}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--s-line);vertical-align:top}
</style></head><body><main>
<h1>${escapeHtml(data.target)}, piece by piece</h1><p>${escapeHtml(data.wholeVerdict)}</p><p class="note">${escapeHtml(data.runFigures)}</p>
<p>${data.pieces.length} pieces · ${total} lines</p><div class="bar" aria-label="Line split, ${total} lines" data-total="${total}">${bar}</div><div class="legend">${legend}</div>
${cards}
<h2>Where it would land</h2><table><thead><tr><th>Piece</th><th>Verdict</th><th>Destination / citation</th></tr></thead><tbody>${landing || '<tr><td colspan="3">No transfers proposed.</td></tr>'}</tbody></table>
<h2>Not available</h2>${data.notAvailable.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join("") || '<p class="note">None reported.</p>'}
</main></body></html>\n`;
  const table = [
    "| Range | Lines | What it does | Failure / origin | Verdict | Citation | What would we lose? |",
    "|---|---:|---|---|---|---|---|",
    ...data.pieces.map(
      (piece) =>
        `| ${[piece.range, String(piece.lines), piece.what, piece.failure, piece.verdict, piece.citation, piece.loss].map(cell).join(" | ")} |`,
    ),
  ].join("\n");
  return { html, table };
}

try {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error("Usage: node .agents/scripts/weed-snapshot.ts <json> [output.html]");
  const source = resolve(input);
  const destination = resolve(output ?? source.replace(/(?:\.json)?$/i, ".html"));
  if (source === destination) throw new Error("Output must differ from the input JSON path");
  const data = snapshotSchema.parse(JSON.parse(readFileSync(source, "utf8")));
  const { html, table } = render(data);
  writeFileSync(destination, html);
  console.log(table);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
