#!/usr/bin/env bash
# Create or update a single bot comment on a PR, identified by a hidden marker,
# so each push edits the same comment instead of adding a new one.
#
# Usage: upsert-pr-comment.sh <marker> <body-file>
# Env:   GH_TOKEN, GH_REPO (owner/repo), PR_NUMBER
set -euo pipefail

MARKER="<!-- $1 -->"
BODY_FILE="$2"

{ echo "$MARKER"; cat "$BODY_FILE"; } > "$BODY_FILE.full"

COMMENT_ID=$(
  gh api --paginate "repos/$GH_REPO/issues/$PR_NUMBER/comments" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"$MARKER\"))) | .id" \
    | head -n 1
)

if [[ -n "$COMMENT_ID" ]]; then
  gh api -X PATCH "repos/$GH_REPO/issues/comments/$COMMENT_ID" -F "body=@$BODY_FILE.full" > /dev/null
  echo "Updated comment $COMMENT_ID"
else
  gh api "repos/$GH_REPO/issues/$PR_NUMBER/comments" -F "body=@$BODY_FILE.full" > /dev/null
  echo "Created comment"
fi
