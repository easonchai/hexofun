# Sourced by scripts/surf.sh and tests/fork/run-fork.sh (POSIX sh).
# Line-buffered so the log stays live. Strips colour codes and everything after
# a URL's host: Helius keys sit in the query, Chainstack keys in the path.
redact() {
  awk '{
    gsub(/\033\[[0-9;]*m/, "")
    while (match($0, /:\/\/[A-Za-z0-9.-]+\/[^ )"<][^ )"]*/)) {
      host_end = RSTART + index(substr($0, RSTART + 3), "/") + 2
      $0 = substr($0, 1, host_end) "<redacted>" substr($0, RSTART + RLENGTH)
    }
    print; fflush()
  }'
}
