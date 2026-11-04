#!/usr/bin/env sh
# Prepare a clone for development: install the pinned DSH into .tools/dsh and write .tools/dsh-env.sh.
# Run from the repo root before typecheck, test and dev-profile.sh:   sh scripts/setup-dsh.sh
#
# Typecheck and tests read DSH's types and runtime packages from .tools/dsh/node_modules/@deepseek-ai
# (tsconfig.base.json, vitest.config.ts), so DSH is installed there with npm's flat layout. Every package is pinned
# by scripts/dsh/package-lock.json, installed with `npm ci`. Nothing already in place is replaced: an install that
# differs from the lock stops here with what differs (stop DSH, delete .tools/dsh and run again; DSH may be
# running from it), and an existing .tools/dsh-env.sh is kept, since it may carry this machine's settings.
set -eu
[ -f pnpm-workspace.yaml ] && [ -d packages ] || { echo "setup-dsh.sh: run from the repo root" >&2; exit 1; }

if [ -d .tools/dsh/node_modules ]; then
  node scripts/dsh/check.mjs || { echo "setup-dsh.sh: stop DSH, delete .tools/dsh and run this again" >&2; exit 1; }
else
  mkdir -p .tools/dsh
  cp scripts/dsh/package.json scripts/dsh/package-lock.json .tools/dsh/
  npm ci --prefix .tools/dsh --no-fund --no-audit
  node scripts/dsh/check.mjs
fi

if [ -f .tools/dsh-env.sh ]; then
  echo ".tools/dsh-env.sh exists, left as it is"
else
  cat > .tools/dsh-env.sh <<'EOF'
# Development environment for DSH. Source it from the repo root:   . .tools/dsh-env.sh
# Written once by scripts/setup-dsh.sh, which never overwrites it.
root=$(pwd)
# Node on Windows takes D:/... paths; Git Bash's pwd gives /d/..., so ask for the Windows form when there is one.
native=$(pwd -W 2>/dev/null || pwd)
export PATH="$root/.tools/dsh/node_modules/.bin:$PATH"
export DSH_HOME="$native/.dsh-home"
export LEARNING_HOME="$native/.data"
# DSH refuses DEEPSEEK_BASE_URL from a .env file, so .env is exported into the environment instead.
if [ -f "$root/.env" ]; then set -a; . "$root/.env"; set +a; fi
EOF
  echo "wrote .tools/dsh-env.sh"
fi
