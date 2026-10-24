# Approved source writes: decision

Assessed on macOS with Node v24.13.0. Retain `SAFE_WRITE_UNAVAILABLE`.
An approved production request does **not** modify the disposable target.
This is a blocked application capability, not a successful implementation of writes.

## Trusted local development threat model

Trust the local developer, engine configuration, OS/kernel, and installed runner.
Treat browser requests and model proposals as untrusted. They cannot confer
workspace authority or bypass explicit, digest-bound approval. Source selections
remain engine-resolved; an approved path does not authorize a different source.

Ordinary editors, formatters, Git operations, and another engine instance may
write or replace files while approval is pending or application is running.
They do not necessarily participate in a Summon lock protocol. Preserve their
updates, including changes after the final precondition read. Reject symlink
redirection and directory replacement fixtures rather than writing outside the
selected workspace. A fully compromised same-user process or privileged attacker
is outside this application security boundary; this exclusion does not justify
assuming that ordinary independent editors are absent.

## Primitive assessment

| Primitive | Useful guarantee | Missing guarantee |
| --- | --- | --- |
| Node `lstat`, `realpath`, hash checks | Validate the observed path/content | Observation does not reserve the path or bytes until commit |
| `open` with `O_NOFOLLOW`, `fstat` | Reject final symlink; inspect opened inode | Ancestor traversal and concurrent inode writes remain; in-place writes are not atomic replacement |
| Exclusive staging creation, `fsync`, mode copying | Prepare complete bytes and permissions | Does not condition publication on the approved base |
| Node `rename` | Atomic directory-entry replacement | Path-based; no expected inode/hash argument or directory-fd-relative API |
| macOS `renameat` / `renameatx_np` | Directory-fd-relative operations; additional flags | No expected destination content/hash condition; a pinned directory can also be moved |
| `RENAME_EXCL` | Refuse an existing destination | Cannot update the existing source file |
| `RENAME_SWAP` | Atomic exchange | Publishes before checking the displaced file; rollback races and transient unapproved publication remain |
| `flock`, lockfiles, in-process mutex | Serialize cooperating participants | Independent editors can ignore advisory locks |

The local SDK declares `renameatx_np`, `RENAME_SWAP`, `RENAME_EXCL`, and
`RENAME_NOFOLLOW_ANY`. Their availability does not supply content compare-and-swap.
A native helper could improve path resolution but would not alone solve the
concurrency requirement. Removing write permissions is not exclusive ownership:
already-open writable descriptors remain, and permission changes are themselves
observable modifications.

Concrete lost-update schedule: read/hash approved bytes A; an editor saves B;
rename staged A-prime over B. Every check before the editor save passes, yet B
is lost. Repeating the check only moves this interval. A synchronous Node call
sequence blocks its event loop, not other processes. A directory swap in the
same interval can redirect pathname-based staging, replacement, or cleanup.

## Existing boundary and remaining gaps

The executor checks approval version/digest, scope, policy, path containment,
base-content hash, and snippet uniqueness before calling the writer. The writer
accepts only a pathname and replacement string: it carries neither a pinned
source identity nor the expected base hash into a commit operation. Existing
executor checks must not be presented as transactional filesystem enforcement.

Retaining the gate preserves target bytes, inode and permissions, creates no
staging artifacts, and leaves application state `not_applied`. Existing tests
exercise valid approvals against real disposable files, late file/parent swaps,
concurrent content changes, Plan Only, and permission preservation. Added tests
cover rejection, stale version/digest, and an outside hard-link alias. The
simulated successful writer test exercises verification state handling only;
it is **not** evidence of a safe production write.

No successful-write claim is possible under these requirements. Enabling writes
requires an enforceable exclusive mutation mechanism covering every writer and
relevant directory, or an explicitly revised concurrency contract accepting an
optimistic check-to-commit race. Neither is established by user approval alone.
Read-side pathname checks also remain susceptible to races under hostile local
mutation; retaining this write gate does not certify race-free reads or protect
against a compromised local process.

## Primary references

- [Node v24.13.0 filesystem API](https://nodejs.org/download/release/v24.13.0/docs/api/fs.html)
- [Apple XNU rename manual](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/rename.2)
- [Apple XNU advisory flock manual](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/flock.2)
