#!/usr/bin/env sh
# Install (or refresh) the `learning` DSH profile and link our workspace packages into it.
# Run from the repo root after `pnpm build`:   sh scripts/dev-profile.sh
# Then start DSH from a directory without .env (see docs/stage0/compatibility.md V0):
#   . .tools/dsh-env.sh && cd .dsh-home/work && dsh learning --no-open --port 3180
#
# The workbench is the @learning-agent/app bundle. The profile's own package.json (bundle selection)
# and cordis.patch.yml (settings saved from the settings page) belong to the learner: profile/ only
# seeds them when missing, and this script never overwrites them.
set -eu
root=$(pwd)
. ./.tools/dsh-env.sh
profile="$DSH_HOME/profiles/learning"
mkdir -p "$profile" "$DSH_HOME/work"
[ -f "$profile/package.json" ] || cp profile/package.json "$profile/"
# A patch that still starts with the pre-bundle header is a copy of the old unit rows, not the
# learner's layer; it would insert every unit a second time next to the bundle's rows.
if [ ! -f "$profile/cordis.patch.yml" ] || head -n 1 "$profile/cordis.patch.yml" | grep -q '^# learning profile: DSH web-app host'; then
  cp profile/cordis.patch.yml "$profile/"
fi
cd "$DSH_HOME/work"
# contracts and kit are bundled into each unit, so they are not installed. Adding the app bundle
# also selects it, after dsh-base and dsh-web-app.
for pkg in core shell library knowledge goal assess curriculum textbook learner sidechat tutor planner app; do
  dsh plugin --profile learning add "link:$(cd "$root/packages/$pkg" && pwd -W 2>/dev/null || pwd)"
done
