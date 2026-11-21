#!/usr/bin/env bash
# Decides which supervisor a publish ships and which npm dist tag it goes on.
#
# Input (env): EVENT_NAME, COMMIT_MESSAGE (head commit message of a push, may be empty, multi-line, CRLF),
#              INPUT_SUPERVISOR_IMPL and INPUT_DIST_TAG (workflow_dispatch inputs, empty otherwise).
# Output (stdout, exactly two lines, to append to "$GITHUB_ENV"):
#   SUPERVISOR_IMPL=<go|rust>
#   DIST_TAG_OVERRIDE=<tag or empty>
#
# A push chooses its channel with trailer lines in the head commit message:
#   Supervisor: rust
#   Publish-Tag: rust-next
# Keys are case-sensitive and line-anchored; the last occurrence wins. Without trailers: go, no override (as before).
#
# The commit message is untrusted text: it is only read (here-string + `read -r`), never evaluated, and every
# expansion is quoted.
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-}"
INPUT_SUPERVISOR_IMPL="${INPUT_SUPERVISOR_IMPL:-}"
INPUT_DIST_TAG="${INPUT_DIST_TAG:-}"

TAG_PATTERN='^[a-z0-9][a-z0-9._-]*$'

fail() {
    printf '::error::%s\n' "$1" >&2
    exit 1
}

check_supervisor() {
    # $1 = value, $2 = where it comes from
    case "$1" in
        go | rust) ;;
        *) fail "Invalid supervisor '$1' (from $2). Allowed values: go, rust. Example commit message trailer: 'Supervisor: rust'." ;;
    esac
}

check_tag() {
    # $1 = value, $2 = where it comes from
    if ! [[ "$1" =~ $TAG_PATTERN ]]; then
        fail "Invalid dist tag '$1' (from $2). A tag must match ^[a-z0-9][a-z0-9._-]*\$ (lowercase letters, digits, '.', '_' and '-', not starting with a symbol). Example commit message trailer: 'Publish-Tag: rust-next'."
    fi
}

supervisor="go"
tag=""

case "$EVENT_NAME" in
    workflow_dispatch)
        if [ -n "$INPUT_SUPERVISOR_IMPL" ]; then
            check_supervisor "$INPUT_SUPERVISOR_IMPL" "the supervisor_impl input"
            supervisor="$INPUT_SUPERVISOR_IMPL"
        fi
        if [ -n "$INPUT_DIST_TAG" ]; then
            check_tag "$INPUT_DIST_TAG" "the dist_tag_override input"
            tag="$INPUT_DIST_TAG"
        fi
        ;;
    push)
        supervisor_re='^Supervisor:[[:space:]]*(.*)$'
        tag_re='^Publish-Tag:[[:space:]]*(.*)$'
        while IFS= read -r line || [ -n "$line" ]; do
            # CR from CRLF, then trailing blanks
            line="${line%$'\r'}"
            line="${line%"${line##*[![:space:]]}"}"
            if [[ "$line" =~ $supervisor_re ]]; then
                supervisor="${BASH_REMATCH[1]}"
                check_supervisor "$supervisor" "the 'Supervisor:' line of the commit message"
            elif [[ "$line" =~ $tag_re ]]; then
                tag="${BASH_REMATCH[1]}"
                check_tag "$tag" "the 'Publish-Tag:' line of the commit message"
            fi
        done <<<"$COMMIT_MESSAGE"
        ;;
    *) ;;
esac

printf 'SUPERVISOR_IMPL=%s\n' "$supervisor"
printf 'DIST_TAG_OVERRIDE=%s\n' "$tag"
