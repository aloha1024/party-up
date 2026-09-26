#!/usr/bin/env bash
# Called by docker-smoke.sh against its own throwaway project, never deployment data.
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
project="${1:?CI project required}"
scratch="$(cd -- "${2:?CI temporary directory required}" && pwd -P)"
compose_file="${3:?CI Compose file required}"
if [[ ! "$project" =~ ^party-ci-[0-9]+-[0-9]+$ ]] || [[ "$(cat "$scratch/docker-ci-project")" != "$project" ]]; then
  echo "Refusing backup drill outside the isolated Docker smoke project" >&2
  exit 1
fi
compose=(docker compose --env-file "$scratch/env" -p "$project" -f "$compose_file")
deployment="$scratch/deployment"
mkdir -p "$deployment/scripts"
cp scripts/backup.sh scripts/wait-for-web.sh scripts/maintenance-state.sh "$deployment/scripts/"
cp "$scratch/env" "$deployment/.env"
"${compose[@]}" config --format json > "$scratch/compose.json"
image_id="$("${compose[@]}" images -q web)"
# Reuse the exact tested image, resolved network and volume in a disposable directory.
python3 - "$scratch/compose.json" "$deployment/compose.yaml" "$image_id" <<'PYCODE'
import json,sys
config=json.load(open(sys.argv[1]))
web=config['services']['web']
web.pop('build',None)
web['image']=sys.argv[3]
web['pull_policy']='never'
with open(sys.argv[2],'w') as f: json.dump(config,f)
PYCODE
fixture=(docker compose --env-file "$deployment/.env" -p "$project" -f "$deployment/compose.yaml")
run_backup() {
  COMPOSE_FILE="$deployment/compose.yaml" COMPOSE_PROJECT_NAME="$project" BACKUP_DIR="$scratch/backups" \
    bash "$deployment/scripts/backup.sh" "$@"
}
# Add a second administrator so restoration checks include credentials and account state.
"${fixture[@]}" exec -T web node --input-type=module - <<'JS'
import {PrismaClient} from '@prisma/client';
const db=new PrismaClient();
try {
  const root=await db.adminCredential.findUniqueOrThrow({where:{id:1}});
  await db.adminCredential.create({data:{username:'ci-backup-admin',passwordHash:root.passwordHash,mustChangePassword:false}});
  const reservation=await db.gameReservation.findFirstOrThrow();
  await db.waitlistEntry.create({data:{reservationId:reservation.id,name:'Backup waiter',nameKey:'backup waiter',tokenHash:'ci-backup-waiter'}});
  await db.reservationChange.create({data:{reservationId:reservation.id,action:'EDIT',actorRole:'HOST',fields:'["maxPlayers"]',maxPlayersBefore:2,maxPlayersAfter:3}});
  await db.participant.updateMany({where:{reservationId:reservation.id},data:{checkedInAt:new Date(),attendanceVersion:1}});
  await db.gameReservation.update({where:{id:reservation.id},data:{status:'ENDED',endedAt:new Date()}});
  await db.reservationAccess.create({data:{reservationId:reservation.id,tokenHash:'ci-invite-member',inviteVersion:1,hasJoined:true}});
  await db.rosterRemoval.create({data:{reservationId:reservation.id,kind:'participants',entryId:'removed-fixture',targetName:'Removed fixture',targetTokenHash:'removed-fixture-hash',reason:'Fixture reason',actorRole:'HOST'}});
} finally {await db.$disconnect();}
JS
capture_state() {
  "${fixture[@]}" exec -T web node --input-type=module - <<'JS'
import {PrismaClient} from '@prisma/client';
import {readFileSync} from 'node:fs';
const db=new PrismaClient();
try {
  const reservations=await db.gameReservation.findMany({orderBy:{id:'asc'},include:{participants:{orderBy:{id:'asc'}},waitlist:{orderBy:{id:'asc'}},changes:{orderBy:{id:'asc'}},removals:{orderBy:{id:'asc'}},access:{orderBy:{id:'asc'}}}});
  const admins=await db.adminCredential.findMany({orderBy:{id:'asc'}});
  const requests=await db.creationRequest.findMany({orderBy:{id:'asc'}});
  const bootstrap=JSON.parse(readFileSync('/app/data/admin-bootstrap.json','utf8'));
  console.log(JSON.stringify({reservations,admins,requests,bootstrap}));
} finally {await db.$disconnect();}
JS
}
capture_state > "$scratch/before.json"
run_backup backup
snapshot="$(python3 - "$scratch/backups" <<'PYCODE'
import pathlib,sys
paths=list(pathlib.Path(sys.argv[1]).glob('backup-*'))
assert len(paths)==1,'Expected exactly one initial backup'
print(paths[0])
PYCODE
)"
run_backup verify "$snapshot"
"${fixture[@]}" exec -T web node --input-type=module - <<'JS'
import {PrismaClient} from '@prisma/client';
import {randomBytes,scryptSync} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const db=new PrismaClient();
try {
  const reservation=await db.gameReservation.findFirstOrThrow();
  await db.gameReservation.update({where:{id:reservation.id},data:{gameName:'Changed after backup',description:'Restore should remove this',status:'OPEN',endedAt:null}});
  await db.participant.updateMany({where:{reservationId:reservation.id},data:{checkedInAt:null,attendanceVersion:{increment:1}}});
  await db.participant.create({data:{reservationId:reservation.id,name:'Added after backup',nameKey:'added after backup',tokenHash:randomBytes(32).toString('hex')}});
  await db.waitlistEntry.deleteMany({where:{reservationId:reservation.id}});
  await db.reservationChange.deleteMany({where:{reservationId:reservation.id}});
  await db.rosterRemoval.deleteMany({where:{reservationId:reservation.id}});
  await db.reservationAccess.deleteMany({where:{reservationId:reservation.id}});
  const salt=randomBytes(16).toString('hex');
  const passwordHash='scrypt:'+salt+':'+scryptSync(randomBytes(32),salt,64).toString('hex');
  await db.adminCredential.update({where:{username:'ci-backup-admin'},data:{passwordHash,isActive:false,sessionVersion:{increment:1}}});
  const path='/app/data/admin-bootstrap.json';
  const config=JSON.parse(readFileSync(path,'utf8'));
  config.ADMIN_SESSION_SECRET=randomBytes(32).toString('hex');
  writeFileSync(path,JSON.stringify(config)+'\n',{mode:0o600});
} finally {await db.$disconnect();}
JS
printf '\nBACKUP_DRILL_MARKER=changed\n' >> "$deployment/.env"
capture_state > "$scratch/changed.json"
run_backup restore "$snapshot" --confirm
capture_state > "$scratch/restored.json"
python3 - "$scratch" <<'PYCODE'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
before=json.loads((root/'before.json').read_text())
changed=json.loads((root/'changed.json').read_text())
restored=json.loads((root/'restored.json').read_text())
assert before!=changed,'Mutation must change data before restore'
assert before==restored,'Restoration must preserve reservations, participants, waitlist, admin credentials and creation identities'
assert (root/'deployment/.env').read_bytes()==(root/'env').read_bytes(),'Server environment must be restored'
assert list((root/'backups').glob('pre-restore-*')),'Recovery snapshot must exist'
PYCODE
# A site that was already stopped must remain stopped for backup and restore.
"${fixture[@]}" stop web >/dev/null
run_backup backup
run_backup restore "$snapshot" --confirm
container="$("${fixture[@]}" ps -a -q web)"
[[ "$(docker inspect --format '{{.State.Status}}' "$container")" == exited ]]
"${fixture[@]}" up -d --no-build web >/dev/null
bash scripts/wait-for-web.sh --env-file "$deployment/.env" -p "$project" -f "$deployment/compose.yaml"
capture_state > "$scratch/restored-stopped.json"
cmp "$scratch/restored.json" "$scratch/restored-stopped.json"
echo 'Docker backup/restore preserved reservations, participants, administrators, credentials, configuration and stopped state'
