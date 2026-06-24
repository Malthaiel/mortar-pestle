#!/usr/bin/env python3
"""Regenerate the five vendored Shield seed artifacts from raw filter lists.

Reads pre-fetched upstream lists from an input dir and writes the seed into an
output dir (see regen.sh, which fetches then calls this):

  hosts.txt                    pure-domain blocklist  -> proxy host layer
  cosmetics.css                generic element-hide   -> per-tab UserStyleSheet
  content_filter_net.json      path/1st-party block   -> WebKit content-filter
  content_filter_cosmetic.json domain-scoped hide     -> WebKit content-filter
  scriptlets.json              ##+js(...) rule table   -> scriptlet bootstrap

Inputs (file names in the input dir):
  hosts/cosmetics/content-filter : easylist.txt, easyprivacy.txt (easylist.to)
  scriptlets                     : ubo-{filters,privacy,quick-fixes,badware,
                                   resource-abuse}.txt (uBlockOrigin/uAssets)

Conservative on purpose — every dropped rule is counted, never silently capped.
The hosts + cosmetics logic mirrors `blocker::parse_hosts` / `parse_cosmetics`
exactly so the offline seed equals the first runtime refresh; the content-filter
and scriptlet logic is lifted verbatim from the throwaway generators that
produced the gate-approved seed (Plan SF2b / SF3).

Usage: gen_seed.py <input_dir> <output_dir> [date]
"""
import json
import re
import sys
from pathlib import Path

# Shared: a "plain hostname" (no scheme/path/wildcard, has a dot, ASCII).
HOST_RE = re.compile(r'^[a-z0-9][a-z0-9.\-]*\.[a-z0-9\-]+$')

# Regression tripwire: these first-party domains must NEVER land in an ad/tracker
# HOST blocklist. Their presence means host_from_line collapsed a path/wildcard or
# cosmetic rule into a bare host again (the SF5 white-screen regression). Asserted
# in main() BEFORE hosts.txt is written, so a poisoned seed is never emitted.
SENTINEL_NEVER_BLOCK = {
    'google.com', 'www.google.com', 'youtube.com', 'www.youtube.com',
    'm.youtube.com', 'duckduckgo.com', 'reddit.com', 'github.com',
    'wikipedia.org', 'amazon.com', 'x.com', 'twitter.com', 'facebook.com',
    'instagram.com', 'bing.com', 'netflix.com', 'linkedin.com',
    'cloudflare.com', 'nytimes.com', 'apple.com', 'microsoft.com',
}


# ----------------------------------------------------------------------------
# hosts.txt  — mirrors blocker::parse_hosts / host_from_line / is_plain_host
# ----------------------------------------------------------------------------
def is_plain_host(h):
    return (len(h) > 1 and '.' in h and '..' not in h
            and h[0] not in '-.' and h[-1] not in '-.'
            and all((c.isascii() and c.isalnum()) or c in '.-' for c in h))


def host_from_line(line):
    s = line.strip()
    if not s or s[0] in '#![':
        return None
    if s.startswith('||'):                       # ||host^[$opts] HOST-ONLY rule
        # Host-only block: host token, optional '^' separator, optional '$opts',
        # then END. Anything else after the host — a '/path', a '^*/path', or a
        # trailing wildcard — is a PATH/wildcard rule the content-filter owns and
        # must NOT collapse to a bare host. That collapse is the SF5 white-screen
        # regression: `||youtube.com/track^` leaked youtube.com/google.com/etc.,
        # and `||twitter.com^*/log.json` leaked twitter.com / x.com / bing.com.
        m = re.match(r'([a-z0-9.\-]+)\^?(?:\$.*)?$', s[2:], re.I)
        if not m:
            return None
        h = m.group(1).lower()
        return h if is_plain_host(h) else None
    return s.lower() if is_plain_host(s) else None  # bare domain (seed format)


def gen_hosts(paths):
    hosts = set()
    for p in paths:
        for line in open(p, encoding='utf-8', errors='ignore'):
            h = host_from_line(line)
            if h:
                hosts.add(h)
    return sorted(hosts)


# ----------------------------------------------------------------------------
# cosmetics.css  — mirrors blocker::parse_cosmetics (generic ##selector only)
# ----------------------------------------------------------------------------
PROC = (':has(', ':-abp', ':matches', ':style', ':upward', ':remove',
        ':watch', ':xpath')


def gen_cosmetics(paths):
    sels = []
    for p in paths:
        for line in open(p, encoding='utf-8', errors='ignore'):
            s = line.strip()
            if not s.startswith('##'):
                continue
            sel = s[2:]
            if not sel or sel.startswith('+js') or any(t in sel for t in PROC):
                continue
            sels.append(sel)
    out = []
    for i in range(0, len(sels), 1000):           # chunked 1000/rule, like Rust
        out.append(','.join(sels[i:i + 1000]) + '{display:none!important}')
    return ('\n'.join(out) + '\n') if out else ''


# ----------------------------------------------------------------------------
# content_filter_{net,cosmetic}.json  — verbatim from gen_shield.py (SF2b)
# ----------------------------------------------------------------------------
EXT = re.compile(r':(?:-abp-|has-text|matches-css|matches-media|matches-path|'
                 r'matches-attr|matches-property|xpath|upward|remove|style|'
                 r'watch-attr|min-text-length|shadow|others)\(')
META = set('.+?()[]{}|$\\')


def esc(s):
    return ''.join('\\' + c if c in META else c for c in s)


def path_to_regex(path):
    # WebKit url-filter is a LIMITED regex subset: no `(?:`, no alternation `|`,
    # no mid-pattern `$`. Use only literal escapes, `.*`, and a single negated
    # char class for the adblock `^` separator; drop a trailing `^` entirely.
    out, buf, n = [], '', len(path)
    for i, ch in enumerate(path):
        if ch == '*':
            if buf:
                out.append(esc(buf)); buf = ''
            out.append('.*')
        elif ch == '^':
            if buf:
                out.append(esc(buf)); buf = ''
            if i != n - 1:
                out.append('[^-_.%a-zA-Z0-9]')
        else:
            buf += ch
    if buf:
        out.append(esc(buf))
    return ''.join(out)


def gen_content_filter(paths):
    net, cos = [], []
    seen_net, seen_cos = set(), set()
    stats = {'net': 0, 'cos': 0, 'skip_opts': 0, 'skip_nopath': 0,
             'skip_host': 0, 'skip_exc': 0, 'skip_ext': 0, 'skip_dom': 0}
    for path in paths:
        for line in open(path, encoding='utf-8', errors='ignore'):
            line = line.rstrip('\n')
            if not line or line[0] in '!#[':
                continue
            # ---- cosmetic: domain##selector (## NOT at column 0) ----
            m = re.match(r'^([^#!|@\s]+)##(.+)$', line)
            if m:
                domains_raw, sel = m.group(1), m.group(2)
                if sel.startswith('+js') or sel.startswith('^'):
                    continue
                if EXT.search(sel):
                    stats['skip_ext'] += 1; continue
                doms, ok = [], True
                for d in domains_raw.split(','):
                    d = d.strip().lower()
                    if not d or d.startswith('~') or '*' in d or '.' not in d:
                        ok = False; break
                    doms.append('*' + d)
                if not ok or not doms:
                    stats['skip_dom'] += 1; continue
                key = (tuple(doms), sel)
                if key in seen_cos:
                    continue
                seen_cos.add(key)
                cos.append({"action": {"type": "css-display-none", "selector": sel},
                            "trigger": {"url-filter": ".*", "if-domain": doms}})
                stats['cos'] += 1
                continue
            # ---- network: ||host<path>  (path-bearing, conservative) ----
            if line.startswith('@@'):
                stats['skip_exc'] += 1; continue
            if not line.startswith('||'):
                continue
            rest = line[2:]
            pattern, opts = (rest.split('$', 1) + [''])[:2]
            optset = {o for o in opts.split(',') if o}
            third = bool(optset & {'third-party', '3p'})
            if optset and not optset.issubset({'third-party', '3p'}):
                stats['skip_opts'] += 1; continue
            mh = re.match(r'^([a-z0-9.\-]+)([/^*].*)$', pattern)
            if not mh:
                stats['skip_nopath'] += 1; continue
            host, remainder = mh.group(1), mh.group(2)
            if '/' not in remainder:
                stats['skip_nopath'] += 1; continue  # host-only -> proxy owns it
            if '*' in host or not HOST_RE.match(host):
                stats['skip_host'] += 1; continue
            uf = '^https?://([^/]+\\.)?' + esc(host) + path_to_regex(remainder)
            if uf in seen_net:
                continue
            seen_net.add(uf)
            trig = {"url-filter": uf}
            if third:
                trig["load-type"] = ["third-party"]
            net.append({"action": {"type": "block"}, "trigger": trig})
            stats['net'] += 1
    net = net[:25000]                              # well under WebKit's ~50k ceiling
    cos = cos[:25000]
    return net, cos, stats


# ----------------------------------------------------------------------------
# scriptlets.json  — verbatim from gen_scriptlets.py (SF3)
# ----------------------------------------------------------------------------
# uBlock scriptlet token (+ aliases) -> Shield canonical impl name. ONLY the
# scriptlets clean-room-reimplemented in scriptlets_lib.js appear here; adding a
# new scriptlet means: implement it in scriptlets_lib.js, register it in the
# dispatcher, and add its token(s) below.
ALIAS = {
    'set': 'setConstant', 'set-constant': 'setConstant', 'set-constant.js': 'setConstant',
    'aopr': 'abortOnPropertyRead', 'abort-on-property-read': 'abortOnPropertyRead',
    'abort-on-property-read.js': 'abortOnPropertyRead',
    'aopw': 'abortOnPropertyWrite', 'abort-on-property-write': 'abortOnPropertyWrite',
    'abort-on-property-write.js': 'abortOnPropertyWrite',
    'acs': 'abortCurrentInlineScript', 'acis': 'abortCurrentInlineScript',
    'abort-current-script': 'abortCurrentInlineScript',
    'abort-current-inline-script': 'abortCurrentInlineScript',
    'abort-current-inline-script.js': 'abortCurrentInlineScript',
    'nowoif': 'noWindowOpenIf', 'no-window-open-if': 'noWindowOpenIf',
    'window.open-defuser': 'noWindowOpenIf',
    'no-fetch-if': 'noFetchIf', 'prevent-fetch': 'noFetchIf', 'nofif': 'noFetchIf',
    'no-xhr-if': 'noXhrIf', 'prevent-xhr': 'noXhrIf',
    'json-prune': 'jsonPrune', 'json-prune.js': 'jsonPrune',
    'json-prune-fetch-response': 'jsonPruneFetchResponse',
    'json-prune-xhr-response': 'jsonPruneXhrResponse',
}


def split_args(content):
    # split on commas NOT preceded by backslash; unescape \, and trim
    return [p.strip().replace('\\,', ',') for p in re.split(r'(?<!\\),', content)]


def gen_scriptlets(paths):
    rules, seen = [], set()
    stats = {'emit': 0, 'drop_name': {}, 'drop_dom': 0, 'drop_exc': 0, 'dup': 0}
    for path in paths:
        for line in open(path, encoding='utf-8', errors='ignore'):
            line = line.rstrip('\n').strip()
            if not line or line[0] in '!#[':
                continue
            if '#@#+js(' in line:                  # exception (un-inject) — unsupported
                stats['drop_exc'] += 1
                continue
            m = re.match(r'^([^#]*)##\+js\((.*)\)\s*$', line)
            if not m:
                continue
            domains_raw, content = m.group(1), m.group(2)
            parsed = split_args(content)
            canon = ALIAS.get(parsed[0].strip())
            if not canon:
                k = parsed[0].strip()
                stats['drop_name'][k] = stats['drop_name'].get(k, 0) + 1
                continue
            args = parsed[1:]
            doms, ok = [], True
            for d in domains_raw.split(','):
                d = d.strip().lower()
                if not d or d.startswith('~') or '*' in d or '/' in d or not HOST_RE.match(d):
                    ok = False
                    break
                doms.append(d)
            if not ok or not doms:
                stats['drop_dom'] += 1
                continue
            key = (tuple(doms), canon, tuple(args))
            if key in seen:
                stats['dup'] += 1
                continue
            seen.add(key)
            rules.append({"d": doms, "s": canon, "a": args})
            stats['emit'] += 1
    return rules, stats


# ----------------------------------------------------------------------------
def main():
    if len(sys.argv) < 3:
        sys.exit("usage: gen_seed.py <input_dir> <output_dir> [date]")
    in_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    date = sys.argv[3] if len(sys.argv) > 3 else 'unknown'
    out_dir.mkdir(parents=True, exist_ok=True)

    easy = [in_dir / 'easylist.txt', in_dir / 'easyprivacy.txt']
    ubo = [in_dir / n for n in ('ubo-filters.txt', 'ubo-privacy.txt',
                                'ubo-quick-fixes.txt', 'ubo-badware.txt',
                                'ubo-resource-abuse.txt')]

    hosts = gen_hosts(easy)
    leaked = sorted(SENTINEL_NEVER_BLOCK.intersection(hosts))
    if leaked:
        sys.exit(f"ABORT: {len(leaked)} first-party domain(s) leaked into hosts.txt "
                 f"— host_from_line path/wildcard collapse regression: {leaked}")
    (out_dir / 'hosts.txt').write_text(
        "# Vendored ad/tracker host blocklist (Shield) — GENERATED SEED, do not hand-edit.\n"
        "# Source: EasyList + EasyPrivacy (easylist.to) — pure-domain (||host^) network rules only.\n"
        f"# Generated: {date} — {len(hosts)} hosts. Regenerate via tools/shield/regen.sh (Plan SF5).\n"
        + '\n'.join(hosts) + '\n', encoding='utf-8')

    css = gen_cosmetics(easy)
    (out_dir / 'cosmetics.css').write_text(
        "/* Shield generic cosmetic filters (element hiding) — GENERATED SEED, do not hand-edit.\n"
        f"   Source: EasyList + EasyPrivacy generic (##selector) rules. Generated: {date}. Chunked 1000/rule. */\n"
        + css, encoding='utf-8')

    net, cos, cf = gen_content_filter(easy)
    (out_dir / 'content_filter_net.json').write_text(
        json.dumps(net, separators=(',', ':')), encoding='utf-8')
    (out_dir / 'content_filter_cosmetic.json').write_text(
        json.dumps(cos, separators=(',', ':')), encoding='utf-8')

    rules, sl = gen_scriptlets(ubo)
    (out_dir / 'scriptlets.json').write_text(
        json.dumps(rules, separators=(',', ':')), encoding='utf-8')

    top = sorted(sl['drop_name'].items(), key=lambda kv: -kv[1])[:12]
    w = sys.stderr.write
    w(f"hosts.txt:                    {len(hosts)} hosts\n")
    w(f"cosmetics.css:                {css.count(chr(10))} chunks\n")
    w(f"content_filter_net.json:      {len(net)} rules  (stats {cf})\n")
    w(f"content_filter_cosmetic.json: {len(cos)} rules\n")
    w(f"scriptlets.json:              {sl['emit']} rules "
      f"(dropped {sl['drop_dom']} non-plain-domain, {sl['drop_exc']} #@# exceptions, "
      f"{sl['dup']} dup)\n")
    w(f"top dropped scriptlets:       {top}\n")


if __name__ == '__main__':
    main()
