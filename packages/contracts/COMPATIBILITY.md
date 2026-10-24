# Digest compatibility

`computeProposalDigest` and `createProposal` remain synchronous with unchanged
signatures, canonical JSON and SHA-256 hexadecimal output. Runtime schemas no
longer import `node:crypto`. An internal FIPS 180-4 SHA-256 implementation hashes
UTF-8 using `TextEncoder`, matching Node's treatment of malformed surrogates.

Supported runtime baseline remains ES2022 with `TextEncoder`; callers of policy
cloning also need `structuredClone` as before. No Web Crypto async API or Node
polyfill is required. This internal digest function is not a general cryptographic
API. Tests compare boundary-length, Unicode, surrogate and million-byte vectors
with Node crypto, canonical proposal bytes, and execute the browser bundle in a
context without Node globals.

The existing localeCompare-based path ordering is deliberately unchanged to
preserve current digests. Cross-runtime locale-dependent ordering of unusual
Unicode paths is a pre-existing compatibility limitation; changing canonical
ordering requires a versioned protocol migration.

The optional `TaskState.application` field is additive. Old payloads remain valid;
new clients must not infer a disk write solely from proposal presence or task
status. See `../runner/BACKEND_HANDOFF.md` for failure semantics.
