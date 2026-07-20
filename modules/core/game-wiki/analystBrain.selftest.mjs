// Runnable check for analystBrain.js: `node analystBrain.selftest.mjs`.
// Part 1 = pure fixtures (pageNames filtering, mishear parse/render round-trip).
// Part 2 = the LIVE vault (fs-shimmed api): known heroes present, no Index/dot-file noise.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pageNames, parseMishears, renderLexicon, buildLexicon, LEXICON_PATH, LEXICON_SOURCES, parseDigested, renderPatchDigest, patchDigestStale, buildPatchDigest, stripFrontmatter, sectionOf, collectPriorTldrs, buildBrainContext } from './analystBrain.js';

// pageNames: keeps .md basenames, drops dot-sidecars / Index / non-md, sorts
const names = pageNames({ pages: [
  { path: '/Deadlock/Fact/Heroes/Mirage.md' },
  { path: 'Deadlock/Fact/Heroes/Abrams.md' },
  { path: 'Deadlock/Fact/Heroes/.autoclass.junk.json' },
  { path: 'Deadlock/Fact/Heroes/Index.md' },
  { path: 'Deadlock/Fact/Heroes/notes.txt' },
] });
assert.deepEqual(names, ['Abrams', 'Mirage']);
assert.deepEqual(pageNames(null), []);

// mishears: render → parse round-trip, and fresh-scaffold tolerance
const md = renderLexicon([['Heroes', ['Mirage']]], [['grey talem', 'Grey Talon']], '2026-07-13');
assert.deepEqual(parseMishears(md), [['grey talem', 'Grey Talon']]);
assert.deepEqual(parseMishears('no section here'), []);
assert.deepEqual(parseMishears(renderLexicon([], [])), []); // header-only table = no rows
assert.ok(md.includes('## Aliases') && md.includes('| Doorman | The Doorman |'));
assert.ok(md.includes('- Mirage'));

// patch digest: frontmatter round-trip + staleness
const dig = renderPatchDigest('## Heroes\n- Mirage buffed (2026-04-30)', ['2026-04-10', '2026-04-30'], '2026-07-13');
assert.deepEqual(parseDigested(dig), ['2026-04-10', '2026-04-30']);
assert.ok(!patchDigestStale(dig, ['2026-04-30', '2026-04-10']));
assert.ok(patchDigestStale(dig, ['2026-05-01']));
assert.deepEqual(parseDigested('no frontmatter'), []);
assert.deepEqual(parseDigested(renderPatchDigest('', [])), []);

// LIVE vault: fs-shim the two api calls buildLexicon uses
const root = path.join(process.env.APPDATA || '', 'dev.malthaiel.mortar-pestle', 'GameWiki');
assert.ok(fs.existsSync(path.join(root, 'Deadlock')), `GameWiki vault not found at ${root}`);
const api = {
  getVaultFolder: async (slug, rel) => ({
    pages: fs.readdirSync(path.join(root, slug, rel)).map((f) => ({ path: `${slug}/${rel}/${f}` })),
  }),
  getRawFileMeta: async (p) => ({ content: fs.readFileSync(path.join(root, p), 'utf8') }),
};
const live = await buildLexicon(api, '2026-07-13');
for (const hero of ['Mirage', 'Infernus', 'Grey Talon']) assert.ok(live.includes(`- ${hero}`), `missing hero ${hero}`);
assert.ok(!live.includes('- Index'), 'Index leaked into lexicon');
assert.ok(!/^- \./m.test(live), 'dot-file leaked into lexicon');
for (const [heading] of LEXICON_SOURCES) assert.ok(live.includes(`## ${heading}`), `missing section ${heading}`);
const heroCount = (live.match(/^- /gm) || []).length;
assert.ok(heroCount >= 40, `suspiciously small lexicon (${heroCount} entries)`);
assert.ok(LEXICON_PATH === 'Deadlock/Coaching/Analyst/Lexicon.md');

// buildPatchDigest with a fake invoke: prompt carries patch bodies, digest carries covered dates
let seen = null;
const fakeInvoke = async (cmd, args) => { seen = { cmd, args }; return 'FAKE DIGEST BODY'; };
const digLive = await buildPatchDigest(api, fakeInvoke, {}, { count: 2, stamp: '2026-07-13' });
assert.equal(seen.cmd, 'coaching_classify_match');
assert.ok(seen.args.userPrompt.includes('=== PATCH 2026-04-30 ==='), 'newest patch not in prompt');
assert.ok(digLive.includes('FAKE DIGEST BODY'));
assert.deepEqual(parseDigested(digLive), ['2026-04-10', '2026-04-30']);

// stripFrontmatter / sectionOf (CRLF-tolerant, backtick-mention-proof)
assert.equal(stripFrontmatter('---\r\nType: X\r\n---\r\nbody'), 'body');
assert.equal(stripFrontmatter('no fm'), 'no fm');
assert.equal(sectionOf('intro mentions `## Distilled` here\n\n## Distilled\n\nfact one\n\n## Log\nx', 'Distilled'), 'fact one');
assert.equal(sectionOf('nothing', 'Distilled'), '');

// buildBrainContext over an in-memory fixture vault
const fix = new Map([
  ['Deadlock/Coaching/Analyst/Analyst.md', '---\nType: Deadlock-Analyst\n---\n## Charter\n\nBe elite.'],
  ['Deadlock/Coaching/Analyst/Lexicon.md', '---\nType: Deadlock-Analyst\n---\n## Heroes\n\n- Mirage\n\n## Mishears\n\n| Heard | Canonical |\n|---|---|'],
  ['Deadlock/Coaching/Analyst/Patch Digest.md', '---\nDigested: [2026-04-30]\n---\n## Digest\n\n- Mirage buffed (2026-04-30)'],
  ['Deadlock/Coaching/Analyst/Concepts.md', '---\n---\n## Distilled\n\nScarabs win tempo.\n\n## Log\n'],
  // Corrections.md deliberately ABSENT → loud placeholder
  ['Deadlock/Coaching/Teams/Alpha.md', '# Alpha — Team Progress\nstuff'],
  ['Deadlock/Coaching/Teams/.teamprogress.Alpha.json', JSON.stringify({ scrimCount: 2, record: { won: 1, lost: 1 }, recurring: [], homework: [{ text: 'ward river', done: false }, { text: 'done thing', done: true }], recurringLessons: [] })],
  // schema v2 scrims: folder per scrim, Overview.md + .vodreport.json inside
  ['Deadlock/Coaching/Scrim/Alpha VS Beta (07-01-26)/Overview.md', '---\nCoached Team: Alpha\n---\nbody'],
  ['Deadlock/Coaching/Scrim/Alpha VS Beta (07-01-26)/.vodreport.json', JSON.stringify({ tldr: 'Lost lanes, won fights.' })],
  // takeaways section preferred over tldr when both exist
  ['Deadlock/Coaching/Scrim/Alpha VS Epsilon (07-10-26)/Overview.md', '---\nCoached Team: Alpha\n---\nbody'],
  ['Deadlock/Coaching/Scrim/Alpha VS Epsilon (07-10-26)/.vodreport.json', JSON.stringify({ tldr: 'Stale digest.', sections: [{ id: 'vod-takeaways', heading: 'VOD Takeaways', md: '1. Group up.' }] })],
  ['Deadlock/Coaching/Scrim/Gamma VS Delta (07-05-26)/Overview.md', '---\nCoached Team: Gamma\n---\nbody'],
]);
const fixApi = {
  getRawFileMeta: async (p) => { if (!fix.has(p)) throw new Error('absent'); return { content: fix.get(p) }; },
  getVaultFolder: async (slug, rel) => {
    const depth = `${slug}/${rel}/x`.split('/').length;
    const under = [...fix.keys()].filter((k) => k.startsWith(`${slug}/${rel}/`));
    return {
      pages: under.filter((k) => k.split('/').length === depth).map((p) => ({ path: p })),
      subfolders: [...new Set(under.filter((k) => k.split('/').length > depth).map((k) => k.split('/')[depth - 1]))].map((name) => ({ name })),
    };
  },
};
const ctx = await buildBrainContext(fixApi, { coachedTeam: 'Alpha' });
assert.ok(ctx.text.includes('=== ANALYST CHARTER ===') && ctx.text.includes('Be elite.'));
assert.ok(ctx.text.includes('=== LEXICON ===') && ctx.text.includes('- Mirage'));
assert.ok(ctx.text.includes('=== TAUGHT CONCEPTS ===') && ctx.text.includes('Scarabs win tempo.'));
assert.ok(!ctx.text.includes('## Log\nx'), 'Distilled slice leaked past section');
assert.ok(ctx.text.includes('[MISSING: Corrections.md ## Distilled]'), 'missing file not loud');
assert.deepEqual(ctx.warnings, ['[MISSING: Corrections.md ## Distilled]']);
assert.ok(ctx.text.includes('=== TEAM PAGE ===') && ctx.text.includes('Alpha — Team Progress'));
assert.ok(ctx.text.includes('=== TEAM PROGRESS ===') && ctx.text.includes('ward river') && !ctx.text.includes('done thing'));
assert.ok(ctx.text.includes('=== PRIOR REPORT TAKEAWAYS ===') && ctx.text.includes('Lost lanes, won fights.'), 'tldr fallback for pre-takeaways reports');
assert.ok(ctx.text.includes('1. Group up.') && !ctx.text.includes('Stale digest.'), 'takeaways section preferred over tldr');
assert.equal(ctx.sections.length, 8);
assert.equal(ctx.sections.filter((s) => s.present).length, 7); // Corrections.md absent by design
const noTeam = await buildBrainContext(fixApi, {});
assert.ok(!noTeam.text.includes('=== TEAM PAGE ===')); // team sections only with a coached team
const tldrs = await collectPriorTldrs(fixApi, 'alpha  '); // normalized team match
assert.equal(tldrs.length, 2);
// deterministic across runs
assert.equal(ctx.text, (await buildBrainContext(fixApi, { coachedTeam: 'Alpha' })).text);

// distiller: parse coercion, shrinkage guard, section replace, mishear append
const { buildDistillerPrompt, parseDistillerOutput, distilledShrunk, replaceDistilled, addMishears } = await import('./analystBrain.js');
const dp = buildDistillerPrompt({ taught: 'Scarabs win tempo.', concepts: 'old fact', mishears: [['gray talon', 'Grey Talon']] });
assert.ok(dp.includes('=== NEW MATERIAL: TAUGHT BY THE COACH ===') && dp.includes('gray talon → Grey Talon'));
assert.ok(!buildDistillerPrompt({}).includes('=== NEW MATERIAL'));
const parsed = parseDistillerOutput('```json\n{"concepts":"- a\\n- b","corrections":"","mishears":[["x","Y"],["bad"],["",""]]}\n```');
assert.deepEqual(parsed, { concepts: '- a\n- b', corrections: '', mishears: [['x', 'Y']] });
assert.throws(() => parseDistillerOutput('no json here'));
assert.ok(distilledShrunk('a'.repeat(100), 'a'.repeat(50)), 'big shrink w/o marker must trip');
assert.ok(!distilledShrunk('a'.repeat(100), `${'a'.repeat(50)} SUPERSEDED: old → new`), 'marker excuses shrink');
assert.ok(!distilledShrunk('_(nothing taught yet)_', 'x'), 'placeholder before never trips');
assert.ok(!distilledShrunk('abc', 'abcdef'));
const page = '---\nType: X\n---\nIntro.\n\n## Distilled\n\n_(nothing taught yet)_\n\n## Log\n';
const merged = replaceDistilled(page, '- Scarabs win tempo.', '2026-07-13 — taught: scarabs');
assert.ok(merged.includes('## Distilled\n\n- Scarabs win tempo.\n\n## Log'));
assert.ok(merged.trimEnd().endsWith('- 2026-07-13 — taught: scarabs'));
assert.equal(sectionOf(merged, 'Distilled'), '- Scarabs win tempo.');
assert.throws(() => replaceDistilled('no sections', 'x'));
const lex2 = addMishears(md, [['grey talem', 'Grey Talon'], ['infernal', 'Infernus']]); // 'grey talem' already present → deduped
assert.deepEqual(parseMishears(lex2), [['grey talem', 'Grey Talon'], ['infernal', 'Infernus']]);
assert.equal(addMishears(md, [['GREY TALEM', 'Grey Talon']]), md); // case-insensitive dedupe, no-op returns input

// live vault: context assembles with real brain files present (no coached team)
const liveCtx = await buildBrainContext(api, {});
assert.ok(liveCtx.text.includes('=== ANALYST CHARTER ===') && liveCtx.text.includes('=== LEXICON ==='));

console.log('analystBrain selftest OK —', heroCount, 'lexicon entries from live vault;', liveCtx.warnings.length, 'live brain warnings', JSON.stringify(liveCtx.warnings));
