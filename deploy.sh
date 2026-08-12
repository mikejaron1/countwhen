#!/usr/bin/env bash
# Push pending changes to GitHub. GitHub Pages auto-rebuilds.
# Usage: ./deploy.sh "your commit message"
#
# After this finishes, reload the CountWhen app on your phone — the
# service worker will pull the new code on next launch (a 2nd reload
# may be needed if the SW upgrade takes one cycle to activate).

set -e

cd "$(dirname "$0")"

if [ -z "$(git status --porcelain)" ]; then
  echo "No changes to deploy."
  exit 0
fi

MSG="${1:-update}"
git add -A
git -c color.ui=never commit -m "$MSG

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push

echo ""
echo "Pushed. GitHub Pages will rebuild in ~30–60 seconds."
echo "URL: https://mikejaron1.github.io/countwhen/"
