// Split a prompt body into the structural blocks a word-shingle must never span.
//
// Flattening a whole body into one token stream means every deletion creates a
// NEW adjacency between two surviving passages, and if that adjacency happened to
// exist in an older release, a staleness gate reports it as re-injected text. On
// the CC 2.1.237 managed-agents trim that was 6 of 7 findings, and re-baselining
// the whole corpus against block-scoped windows dropped 143 standing keys across
// 39 ids while gaining none — every one of them an adjacency artifact rather than
// a passage anyone had put back.
//
// A genuinely re-injected passage sits INSIDE a paragraph, list item, or table
// row, so scoping to blocks kills the false-positive class without blinding the
// gate.
//
// Blocks split on a blank line AND on a markdown item marker (`-`, `*`, `+`, `>`,
// `|`, `#`, `1.`). Deliberately NOT on every newline: override bodies hard-wrap
// prose, and a continuation line never starts with one of those markers, so
// wrapping immunity survives.
export const BLOCK = /\n[ \t]*\n|\n(?=[ \t]*(?:[-*+>|#]|\d+[.)]))/;

export const blocksOf = t => (t || '').split(BLOCK).filter(b => b.trim());
