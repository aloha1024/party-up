#!/bin/sh
set -eu

node scripts/build-info.mjs
node scripts/ensure-db.mjs
node node_modules/prisma/build/index.js migrate deploy
exec node --import ./scripts/docker-admin.mjs server.js
