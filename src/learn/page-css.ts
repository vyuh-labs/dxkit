/**
 * The learn page's design system — every token and component style, inline
 * (the page loads nothing external). Split from render.ts for module size;
 * render.ts remains the one assembler.
 */

export const CSS = `
:root {
  --bg:#f7f7f8; --surface:#ffffff; --card:#ffffff; --raise:#f1f1f3;
  --border:#e4e4e7; --border-strong:#d4d4d8;
  --text:#18181b; --text-2:#3f3f46; --muted:#71717a;
  --accent:#2563eb; --accent-soft:#eff4ff; --on-accent:#ffffff;
  --ok:#16a34a; --warn:#d97706; --bad:#dc2626;
  --shadow:0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.06);
  --shadow-lg:0 12px 40px rgba(0,0,0,.18);
  --radius:10px;
}
[data-theme="dark"] {
  --bg:#0b0b0d; --surface:#131316; --card:#17171b; --raise:#1e1e23;
  --border:#26262c; --border-strong:#34343c;
  --text:#f4f4f5; --text-2:#d4d4d8; --muted:#9d9da8;
  --accent:#4f83ff; --accent-soft:#182236; --on-accent:#ffffff;
  --ok:#4ade80; --warn:#fbbf24; --bad:#f87171;
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35);
  --shadow-lg:0 12px 48px rgba(0,0,0,.6);
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior:smooth; scroll-padding-top:76px; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  background:var(--bg); color:var(--text-2); font-size:15px; line-height:1.65; }
code, pre, kbd { font-family:ui-monospace,'SF Mono','Cascadia Code',Consolas,monospace; }

/* topbar */
.topbar { position:fixed; inset:0 0 auto 0; height:56px; z-index:40; display:flex; align-items:center;
  gap:14px; padding:0 18px; background:color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter:blur(10px); border-bottom:1px solid var(--border); }
.brand { display:flex; align-items:baseline; gap:8px; font-weight:700; color:var(--text); font-size:15.5px; white-space:nowrap; }
.brand .v { font-weight:500; font-size:11.5px; color:var(--muted); }
.brand .mode { font-size:10.5px; font-weight:600; letter-spacing:.4px; text-transform:uppercase;
  color:var(--accent); background:var(--accent-soft); border-radius:20px; padding:2px 9px; }
.searchbtn { flex:1; max-width:440px; display:flex; align-items:center; gap:8px; height:34px;
  padding:0 12px; background:var(--raise); border:1px solid var(--border); border-radius:8px;
  color:var(--muted); font-size:13px; cursor:pointer; }
.searchbtn:hover { border-color:var(--border-strong); }
.searchbtn kbd { margin-left:auto; font-size:10.5px; background:var(--surface); border:1px solid var(--border);
  border-radius:4px; padding:1px 6px; color:var(--muted); }
.topbar .spacer { flex:1; }
.tbtn { display:flex; align-items:center; gap:7px; height:34px; padding:0 13px; border-radius:8px;
  border:1px solid var(--border); background:var(--surface); color:var(--text-2); font-size:13px;
  cursor:pointer; font-family:inherit; white-space:nowrap; }
.tbtn:hover { background:var(--raise); }
.tbtn.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); font-weight:600; }
.tbtn.primary:hover { filter:brightness(1.08); }

/* layout */
.layout { display:flex; padding-top:56px; min-height:100vh; }
.sidebar { width:248px; flex-shrink:0; position:sticky; top:56px; height:calc(100vh - 56px);
  overflow-y:auto; padding:18px 10px 40px 14px; border-right:1px solid var(--border); }
.nav-label { font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.8px;
  color:var(--muted); padding:16px 10px 5px; }
.sidebar a { display:block; color:var(--text-2); text-decoration:none; font-size:13px;
  padding:5.5px 10px; border-radius:7px; border-left:2px solid transparent; }
.sidebar a:hover { background:var(--raise); color:var(--text); }
.sidebar a.active { color:var(--accent); background:var(--accent-soft); border-left-color:var(--accent); font-weight:500; }
.main { flex:1; min-width:0; padding:30px 40px 100px; max-width:1020px; }

/* sections */
h2.section { font-size:21px; font-weight:700; color:var(--text); margin:44px 0 6px; letter-spacing:-.01em; }
h2.section:first-child { margin-top:0; }
.section-sub { color:var(--muted); font-size:13.5px; margin-bottom:18px; }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:14px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
  padding:15px 17px; transition:border-color .12s ease; }
.card:hover { border-color:var(--border-strong); }
.card .cmd { font-size:14px; color:var(--accent); font-weight:650; font-family:ui-monospace,'SF Mono',Consolas,monospace; }
.card .aliases { font-size:11px; color:var(--muted); margin-left:5px; }
.card .runtime { float:right; font-size:10.5px; color:var(--muted); background:var(--raise);
  padding:2px 9px; border-radius:20px; }
.card p { font-size:13px; line-height:1.6; margin-top:8px; color:var(--text-2); }
.card .knobs { margin-top:9px; font-size:11.5px; color:var(--muted); }
.card .knobs code { color:var(--warn); background:var(--raise); padding:1px 5px; border-radius:4px; font-size:11px; }

/* docs */
.doc { background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
  padding:26px 30px; margin-bottom:20px; }
.doc h1 { font-size:23px; font-weight:750; color:var(--text); margin-bottom:14px; letter-spacing:-.015em; }
.doc h2 { font-size:17.5px; font-weight:700; color:var(--text); margin:26px 0 9px; }
.doc h3 { font-size:15px; font-weight:650; color:var(--text); margin:18px 0 6px; }
.doc h4 { font-size:13.5px; font-weight:650; color:var(--text); margin:14px 0 5px; }
.doc p, .doc li { font-size:14px; line-height:1.7; }
.doc p { margin-bottom:11px; }
.doc ul, .doc ol { padding-left:24px; margin-bottom:13px; }
.doc li { margin-bottom:3px; }
.doc pre { position:relative; background:var(--raise); border:1px solid var(--border); border-radius:8px;
  padding:13px 15px; font-size:12.5px; overflow-x:auto; margin:11px 0 15px; line-height:1.55; }
.doc code { background:var(--raise); padding:1.5px 6px; border-radius:5px; font-size:12.5px; color:var(--text); }
.doc pre code { background:none; padding:0; }
.doc a { color:var(--accent); text-decoration:none; }
.doc a:hover { text-decoration:underline; }
.doc strong { color:var(--text); font-weight:650; }
.doc blockquote { border-left:3px solid var(--accent); padding:2px 0 2px 14px; color:var(--muted); margin-bottom:11px; }

/* copy button */
.copybtn { position:absolute; top:7px; right:7px; border:1px solid var(--border); background:var(--surface);
  color:var(--muted); font-size:10.5px; border-radius:6px; padding:3px 9px; cursor:pointer; opacity:0;
  transition:opacity .12s ease; font-family:inherit; }
pre:hover .copybtn, .fix:hover .copybtn { opacity:1; }
.copybtn.done { color:var(--ok); border-color:var(--ok); opacity:1; }

/* repo status */
.pill-row { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 18px; }
.pill { font-size:12px; background:var(--card); border:1px solid var(--border);
  border-radius:20px; padding:4px 13px; color:var(--text-2); }
.status-line { display:flex; gap:10px; align-items:baseline; padding:9px 13px; border-radius:8px; font-size:13.5px; }
.status-line.fail { background:var(--card); border:1px solid var(--border); margin-bottom:9px; display:block; }
.badge-ok { color:var(--ok); } .badge-fail { color:var(--bad); } .badge-warn { color:var(--warn); }
.fix { position:relative; font-size:12.5px; color:var(--muted); margin:5px 0 3px 22px; line-height:1.55; }
.fix code { background:var(--raise); border:1px solid var(--border); padding:2.5px 8px;
  border-radius:6px; color:var(--accent); user-select:all; font-size:12px; }
.note { font-size:13px; color:var(--muted); background:var(--card); border:1px solid var(--border);
  border-radius:var(--radius); padding:12px 16px; margin:10px 0; line-height:1.65; }

/* tables (docs + reference) */
.doc table, .ref-doc table { border-collapse:collapse; margin:12px 0 16px; font-size:12.5px; width:100%; display:block; overflow-x:auto; }
.doc th, .ref-doc th { text-align:left; font-weight:650; color:var(--text); border-bottom:2px solid var(--border-strong);
  padding:7px 12px 7px 0; }
.doc td, .ref-doc td { border-bottom:1px solid var(--border); padding:7px 12px 7px 0; vertical-align:top; }

/* reference shelf */
.ref-group { margin-bottom:10px; }
.ref-group > summary { cursor:pointer; font-size:14.5px; font-weight:650; color:var(--text);
  padding:11px 15px; background:var(--card); border:1px solid var(--border); border-radius:var(--radius); }
.ref-group[open] > summary { border-radius:var(--radius) var(--radius) 0 0; }
.ref-doc { border:1px solid var(--border); border-top:none; padding:4px 15px; }
.ref-doc > summary { cursor:pointer; font-size:13px; color:var(--text-2); padding:8px 4px; }
.ref-doc .doc { border:none; padding:8px 12px 16px; margin:0; }
.list-plain { list-style:none; display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:10px; }
.list-plain li { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:10px 14px; font-size:12.5px; }
.list-plain li b { color:var(--text); font-weight:650; }
.list-plain li .tier { float:right; font-size:10px; color:var(--muted); background:var(--raise); border-radius:12px; padding:1px 8px; }
.task-why { font-size:11px; color:var(--muted); }
.models-note { font-size:11px; color:var(--muted); }
.models-note.live { color:var(--ok); }

/* search palette */
.palette-overlay { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.35); display:none;
  align-items:flex-start; justify-content:center; padding-top:12vh; }
.palette-overlay.open { display:flex; }
.palette { width:min(620px, 92vw); background:var(--surface); border:1px solid var(--border-strong);
  border-radius:14px; box-shadow:var(--shadow-lg); overflow:hidden; }
.palette input { width:100%; border:none; outline:none; background:transparent; color:var(--text);
  font-size:15px; padding:16px 18px; border-bottom:1px solid var(--border); font-family:inherit; }
.palette-results { max-height:46vh; overflow-y:auto; padding:6px; }
.presult { display:block; width:100%; text-align:left; background:none; border:none; cursor:pointer;
  border-radius:8px; padding:9px 12px; font-family:inherit; }
.presult:hover, .presult.sel { background:var(--accent-soft); }
.presult .rt { font-size:13.5px; color:var(--text); font-weight:550; }
.presult .rk { font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.5px;
  color:var(--accent); margin-right:8px; }
.presult .rs { font-size:12px; color:var(--muted); margin-top:1px; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; }
.palette-empty { padding:18px; font-size:13px; color:var(--muted); text-align:center; }

/* assistant panel */
.assistant-fab { position:fixed; right:22px; bottom:22px; z-index:45; height:46px; padding:0 19px;
  border-radius:24px; border:none; background:var(--accent); color:var(--on-accent); font-size:13.5px;
  font-weight:650; cursor:pointer; box-shadow:var(--shadow-lg); display:flex; align-items:center; gap:8px;
  font-family:inherit; }
.assistant-panel { position:fixed; top:56px; right:0; bottom:0; width:min(430px, 100vw); z-index:50;
  background:var(--surface); border-left:1px solid var(--border); display:flex; flex-direction:column;
  transform:translateX(105%); transition:transform .22s ease; box-shadow:var(--shadow-lg); }
.assistant-panel.open { transform:translateX(0); }
.ap-head { display:flex; align-items:center; gap:10px; padding:13px 16px; border-bottom:1px solid var(--border); }
.ap-head .t { font-weight:700; color:var(--text); font-size:14.5px; }
.ap-head .sub { font-size:11px; color:var(--muted); }
.ap-head .close { margin-left:auto; border:none; background:none; color:var(--muted); font-size:17px; cursor:pointer; }
.ap-config { padding:11px 16px; border-bottom:1px solid var(--border); display:flex; flex-direction:column; gap:8px; }
.ap-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--muted); }
.ap-row label { display:flex; gap:6px; align-items:center; }
.ap-row select, .ap-row input[type=text], .ap-row input[type=password] { background:var(--raise); color:var(--text);
  border:1px solid var(--border); border-radius:7px; padding:5.5px 9px; font-size:12.5px; font-family:inherit; }
.ap-row select { max-width:180px; }
#key-env-note { font-size:11.5px; color:var(--ok); }
.ap-disclosure summary { font-size:11.5px; color:var(--muted); cursor:pointer; }
.ap-disclosure ul { padding:6px 0 0 18px; font-size:11.5px; color:var(--muted); }
.ap-chat { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; }
.ap-empty { margin:auto; text-align:center; color:var(--muted); font-size:13px; max-width:280px; line-height:1.7; }
.msg { max-width:92%; border-radius:12px; padding:10px 13px; font-size:13.5px; line-height:1.6; }
.msg.user { background:var(--accent); color:var(--on-accent); align-self:flex-end; white-space:pre-wrap; }
.msg.assistant { background:var(--card); border:1px solid var(--border); align-self:flex-start; color:var(--text-2); }
.msg.assistant pre { background:var(--raise); border:1px solid var(--border); border-radius:7px; padding:9px 11px;
  overflow-x:auto; font-size:11.5px; margin:8px 0; }
.msg.assistant code { background:var(--raise); padding:1px 5px; border-radius:4px; font-size:12px; }
.msg.assistant p { margin:0 0 8px; } .msg.assistant p:last-child { margin-bottom:0; }
.msg.assistant ul, .msg.assistant ol { padding-left:19px; margin:4px 0 8px; }
.msg.assistant h1, .msg.assistant h2, .msg.assistant h3 { font-size:13.5px; color:var(--text); margin:8px 0 4px; }
.msg-meta { font-size:10.5px; color:var(--muted); align-self:flex-start; margin:-7px 0 0 4px; }
.typing { display:inline-flex; gap:4px; padding:4px 2px; }
.typing i { width:6px; height:6px; border-radius:50%; background:var(--muted); animation:tp 1s infinite; }
.typing i:nth-child(2) { animation-delay:.15s; } .typing i:nth-child(3) { animation-delay:.3s; }
@keyframes tp { 0%,60%,100% { opacity:.25; } 30% { opacity:1; } }
.ap-input { display:flex; gap:9px; padding:13px 16px; border-top:1px solid var(--border); align-items:flex-end; }
.ap-input textarea { flex:1; resize:none; background:var(--raise); color:var(--text); border:1px solid var(--border);
  border-radius:10px; padding:9px 12px; font-size:13.5px; font-family:inherit; line-height:1.5; max-height:130px; }
.ap-input button { height:38px; padding:0 17px; border:none; border-radius:9px; background:var(--accent);
  color:var(--on-accent); font-weight:650; font-size:13px; cursor:pointer; font-family:inherit; }
.ap-error { color:var(--bad); font-size:12px; padding:0 16px 10px; }

/* SPA views (wiki mode): with JS, exactly one view is visible */
body.spa .view { display:none; }
body.spa .view.active { display:block; animation:viewin .14s ease; }
@keyframes viewin { from { opacity:.4; transform:translateY(4px); } to { opacity:1; transform:none; } }

/* hero */
.hero { padding:34px 34px 30px; background:linear-gradient(135deg, var(--accent-soft), var(--card));
  border:1px solid var(--border); border-radius:14px; margin-bottom:28px; }
.hero h1 { font-size:27px; font-weight:750; color:var(--text); letter-spacing:-.02em; margin-bottom:10px; }
.hero p { font-size:14.5px; max-width:640px; margin-bottom:18px; }
.hero-actions { display:flex; gap:10px; flex-wrap:wrap; }
.hero-actions .tbtn { text-decoration:none; height:38px; display:inline-flex; }

/* breadcrumbs + prev/next */
.crumbs { font-size:12px; color:var(--muted); margin-bottom:14px; min-height:16px; }
.crumbs a { color:var(--muted); text-decoration:none; }
.crumbs a:hover { color:var(--accent); }
.crumbs .sep { margin:0 7px; opacity:.6; }
.crumbs .here { color:var(--text); font-weight:550; }
.pagenav { display:flex; justify-content:space-between; gap:12px; margin-top:44px; }
.pagenav a { flex:1; max-width:46%; text-decoration:none; border:1px solid var(--border); background:var(--card);
  border-radius:10px; padding:12px 16px; }
.pagenav a:hover { border-color:var(--accent); }
.pagenav .dir { font-size:10.5px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); }
.pagenav .pt { font-size:13.5px; color:var(--accent); font-weight:550; margin-top:2px; }
.pagenav a.next { text-align:right; margin-left:auto; }

/* per-page TOC rail */
.toc { width:200px; flex-shrink:0; position:sticky; top:56px; height:calc(100vh - 56px);
  overflow-y:auto; padding:26px 16px 40px 6px; display:none; }
.toc .toc-label { font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.8px;
  color:var(--muted); margin-bottom:8px; }
.toc a { display:block; font-size:12px; color:var(--muted); text-decoration:none; padding:3.5px 0 3.5px 10px;
  border-left:2px solid var(--border); }
.toc a:hover { color:var(--accent); }
.toc a.h3 { padding-left:22px; }
@media (min-width: 1240px) { .toc { display:block; } }

/* reference index */
.ref-index-group { font-size:14px; font-weight:650; color:var(--text); margin:22px 0 10px; }
.ref-card { display:block; text-decoration:none; }
.ref-card:hover { border-color:var(--accent); }

@media (max-width: 900px) { .sidebar { display:none; } .main { padding:24px 18px 90px; } }
`;
