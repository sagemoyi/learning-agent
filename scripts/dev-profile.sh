#!/usr/bin/env sh
# Install (or refresh) the `learning` DSH profile from profile/ and link our workspace packages into it.
# Run from the repo root after `pnpm build`:   sh scripts/dev-profile.sh
# Then start DSH from a directory without .env (see docs/stage0/compatibility.md V0):
#   . .tools/dsh-env.sh && cd .dsh-home/work && dsh learning --no-open --port 3180
set -eu
root=$(pwd)
. ./.tools/dsh-env.sh
profile="$DSH_HOME/profiles/learning"
mkdir -p "$profile" "$DSH_HOME/work"
cp profile/package.json profile/cordis.patch.yml "$profile/"
cd "$DSH_HOME/work"
# contracts and kit are bundled into each unit, so they are not installed.
for pkg in core shell library knowledge goal assess curriculum textbook learner sidechat tutor planner; do
  dsh plugin --profile learning add "link:$(cd "$root/packages/$pkg" && pwd -W 2>/dev/null || pwd)"
done
