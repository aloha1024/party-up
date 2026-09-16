#!/bin/sh
set -eu

node scripts/ensure-db.mjs
node node_modules/prisma/build/index.js migrate deploy
exec node --import ./scripts/docker-admin.mjs node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port 3000
