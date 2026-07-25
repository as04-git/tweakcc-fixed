import json, re, os, sys, difflib, collections

LCC = '/Users/batricperovic/.tweakcc/lobotomized-claude-code'
SET = os.path.join(LCC, 'system-prompts-opus-5')
JSONP = '/Users/batricperovic/dev/tweakcc-fixed/data/prompts/prompts-2.1.220.json'

d = json.load(open(JSONP))['prompts']

def recon(e):
    out = ''
    pieces = e.get('pieces') or []
    ids = e.get('identifiers') or []
    m = e.get('identifierMap') if isinstance(e.get('identifierMap'), dict) else {}
    for i, p in enumerate(pieces):
        out += p
        if i < len(ids):
            out += m.get(str(ids[i]), 'UNKNOWN_%s' % ids[i])
    return out or (e.get('content') or '')

bodies = collections.defaultdict(list)
for e in d:
    if e.get('id'):
        bodies[e['id']].append(recon(e))

# tripwire predicates
QUANT = re.compile(r'\b(ONLY|ANY|ALL|every|never|must|each|all \w+)\b')
EG = re.compile(r'\b(e\.g\.|i\.e\.)')
NUM = re.compile(r'(?<![\w.])\d+(?:[-–]\d+)?(?![\w.])|>=\s*\d+')
PATHY = re.compile(r'`[^`]+`|\$[A-Z_]{3,}|__[A-Z_]+__|[a-zA-Z_]+\.(?:json|md|js|ts|py)\b|\b[a-z]+_[a-z_]+\b')
ORDER = re.compile(r'\b(before|after|first|until|then)\b', re.I)
ENUM = re.compile(r'\w+,\s*\w+(?:,\s*\w+)+|\w+\s*/\s*\w+\s*/\s*\w+')

def frozen(s):
    hits = []
    if QUANT.search(s): hits.append('quantifier')
    if EG.search(s): hits.append('e.g.')
    if NUM.search(s): hits.append('number')
    if PATHY.search(s): hits.append('path/enum/tool')
    if ORDER.search(s): hits.append('ordering')
    if ENUM.search(s): hits.append('enumeration')
    return hits

def sentences(t):
    t = re.sub(r'\s+', ' ', t)
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z`\-*\d])', t)
    return [p.strip() for p in parts if len(p.strip()) >= 40]

def norm(s):
    return re.sub(r'\s+', ' ', s).strip()

DONE = set(json.load(open('/tmp/contested14.json'))) if False else set()
try:
    DONE = {x['id'] for x in json.load(open('/tmp/contested14.json'))}
except Exception:
    DONE = set()

violations = []
scanned = 0
for f in sorted(os.listdir(SET)):
    if not f.endswith('.md'):
        continue
    pid = f[:-3]
    if pid in DONE or pid.startswith('inline-'):
        continue
    if pid not in bodies:
        continue
    raw = open(os.path.join(SET, f), encoding='utf8').read()
    m = re.search(r'-->\s*\n?', raw)
    body = raw[m.end():] if m else raw
    if not body.strip():
        continue                      # deliberate suppression
    nb = norm(body)
    if any(norm(b) == nb for b in bodies[pid]):
        continue                      # pristine stub
    scanned += 1
    seen = set()
    for pb in bodies[pid]:
        for s in sentences(pb):
            if s in seen:
                continue
            seen.add(s)
            hits = frozen(s)
            if not hits:
                continue
            if norm(s) in nb:
                continue              # verbatim -> ok
            # not verbatim: deleted-whole (allowed) or altered (violation)?
            cand = difflib.get_close_matches(norm(s), sentences(body), n=1, cutoff=0.72)
            if cand:
                violations.append({
                    'id': pid, 'predicates': hits,
                    'pristine': s[:400], 'deployed': cand[0][:400],
                    'ratio': round(difflib.SequenceMatcher(None, norm(s), cand[0]).ratio(), 3),
                })

by_id = collections.defaultdict(list)
for v in violations:
    by_id[v['id']].append(v)

print('real overrides scanned: %d' % scanned)
print('files with tripwire violations: %d' % len(by_id))
print('total violations: %d' % len(violations))
json.dump(violations, open('/tmp/tripwire-violations.json', 'w'), indent=1)
json.dump(sorted(by_id), open('/tmp/tripwire-files.json', 'w'), indent=0)
top = sorted(by_id.items(), key=lambda kv: -len(kv[1]))[:20]
print('\ntop offenders:')
for k, v in top:
    print('  %-58s %d' % (k[:56], len(v)))
